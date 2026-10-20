import {
  CanAddr,
  CAN_ID_TYPE,
  CanMsgType,
  CAN_ERROR_ID,
  getLenByDlc,
  CanBaseInfo,
  CanDevice,
  CandleCapability,
  getTsUs,
  CanMessage,
  getDlcByLen
} from '../../share/can'
import { EventEmitter } from 'events'
import { cloneDeep } from 'lodash'
import { addrToId, CanError } from '../../share/can'
import { CanLOG } from '../../log'
import Candle from './../build/Release/candle.node'
import { platform } from 'os'
import { CanBase } from '../base'

interface CANFrame {
  canId: number
  msgType: CanMsgType
  data: Buffer
  ts: number
}

/** How the CAN channels are mapped onto the USB interfaces of one device. */
export type CandleChannelMode = 'single' | 'multi'

/** One selectable CAN channel. */
export interface CandleChannelPlan {
  /** USB device interface path (also the key of the shared native context) */
  path: string
  /** Display label, already containing the channel suffix when needed */
  label: string
  name: string
  /** bInterfaceNumber of the interface that carries this channel */
  mi: number
  /** Logical channel index, written into wValue of vendor requests and the frame header */
  channel: number
  /** Total channels carried by `path` */
  channelCount: number
  mode: CandleChannelMode
  busy: boolean
  feature: number
  cap: CandleCapability
  dataCap?: CandleCapability
}

/** Per-interface runtime state shared by all channels living on the same USB interface. */
interface CandleParentHub {
  mode: CandleChannelMode
  refCount: number
  instances: Map<number, Candle_CAN>
  /** Channels already reported as unknown, to log each one only once */
  warnedChannels: Set<number>
}

export class Candle_CAN extends CanBase {
  event: EventEmitter
  info: CanBaseInfo
  target: any
  channel = 0
  channelMode: CandleChannelMode = 'single'
  channelCount = 1
  closed = false
  cnt = 0

  id: string
  log: CanLOG
  canConfig: any
  canfdConfig: any
  startTime = getTsUs()
  tsOffset: number | undefined

  // Device management: track opened devices by path.
  // `mode` / `channelCount` are recorded by the first opener, because a
  // rescan of an already opened interface reports it as "in use" and loses
  // the channel information.
  private static openedDevices = new Map<
    string,
    { device: any; refCount: number; mode: CandleChannelMode; channelCount: number }
  >()
  // One native RX/TX context per USB interface; channels are demultiplexed by frame header
  private static hubs = new Map<string, CandleParentHub>()
  // Channel plan of the last healthy scan, per device interface path. A device
  // opened by us reports itself as "in use" on the next scan, which would
  // otherwise shrink the device list while it is running.
  private static planCache = new Map<string, CandleChannelPlan[]>()
  // Last logged classification per group, to avoid repeating it on every scan
  private static lastGroupLog = new Map<string, string>()
  private devicePath: string = ''

  private readAbort = new AbortController()

  rejectBaseMap = new Map<
    number,
    {
      reject: (reason: CanError) => void
      msgType: CanMsgType
    }
  >()

  // Add missing pendingBaseCmds property
  pendingBaseCmds = new Map<
    string,
    {
      resolve: (value: number) => void
      reject: (reason: CanError) => void
      msgType: CanMsgType
      data: Buffer
      extra?: { database?: string; name?: string }
    }[]
  >()

  /**
   * Register a channel on the native context of its USB interface.
   *
   * The native side owns exactly one RX/TX thread per USB interface, so
   * several channels sharing one interface (standard gs_usb layout) can be
   * demultiplexed by the `channel` field of the frame header instead of
   * fighting over the same URB set.
   */
  private static registerChannel(
    path: string,
    channel: number,
    instance: Candle_CAN,
    mode: CandleChannelMode
  ) {
    let hub = Candle_CAN.hubs.get(path)
    if (!hub) {
      hub = { mode, refCount: 0, instances: new Map(), warnedChannels: new Set() }
      Candle_CAN.hubs.set(path, hub)
      Candle.CreateTSFN(
        path,
        (msg: any) => Candle_CAN.dispatchRx(path, msg),
        (err: any) => Candle_CAN.dispatchError(path, err)
      )
    }
    hub.refCount++
    hub.instances.set(channel, instance)
    if (mode === 'multi') {
      hub.mode = 'multi'
    }
  }

  private static unregisterChannel(path: string, channel: number) {
    const hub = Candle_CAN.hubs.get(path)
    if (!hub) {
      return
    }
    if (hub.instances.get(channel) !== undefined) {
      hub.instances.delete(channel)
      hub.refCount--
    }
    if (hub.refCount <= 0 || hub.instances.size === 0) {
      Candle_CAN.hubs.delete(path)
      Candle.FreeTSFN(path)
    }
  }

  private static dispatchRx(path: string, msg: any) {
    const hub = Candle_CAN.hubs.get(path)
    if (!hub || !msg) {
      return
    }
    if (hub.mode === 'multi' && msg.Channel !== undefined) {
      const channel = Number(msg.Channel)
      const instance = hub.instances.get(channel)
      if (instance) {
        instance.callback(msg)
        return
      }
      // Echo frames must never be dropped, otherwise the TX promise would hang
      // when a firmware reports an unexpected channel id.
      if (msg.FrameType === 2) {
        hub.instances.forEach((item) => item.callback(msg))
        return
      }
      if (!hub.warnedChannels.has(channel)) {
        hub.warnedChannels.add(channel)
        sysLog.warn(
          `candle ${path}: dropped frame with unknown channel ${channel} ` +
            `(active channels: ${[...hub.instances.keys()].join(',') || 'none'})`
        )
      }
      return
    }
    hub.instances.forEach((item) => item.callback(msg))
  }

  private static dispatchError(path: string, err: any) {
    const hub = Candle_CAN.hubs.get(path)
    if (!hub) {
      return
    }
    hub.instances.forEach((item) => item.errorCallback(err))
  }

  /**
   * Raw bytes of the DEVICE_CONFIG reply, for firmware debugging.
   * Nothing is transformed here: reserved1..3, icount, sw_version, hw_version
   * are dumped in wire order (little endian).
   */
  private static dconfHex(device: any): string {
    const dc = device?.dconf
    if (!dc) {
      return ''
    }
    const le32 = (value: number) => {
      const n = value >>> 0
      return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
    }
    return [
      Number(dc.reserved1) & 0xff,
      Number(dc.reserved2) & 0xff,
      Number(dc.reserved3) & 0xff,
      Number(dc.icount) & 0xff,
      ...le32(Number(dc.sw_version)),
      ...le32(Number(dc.hw_version))
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
  }

  private static buildCap(device: any): {
    cap: CandleCapability
    dataCap?: CandleCapability
    feature: number
  } {
    const cap = device.bt_const
    const candleCap: CandleCapability = {
      feature: cap.feature,
      fclk_can: cap.fclk_can,
      tseg1_min: cap.tseg1_min,
      tseg1_max: cap.tseg1_max,
      tseg2_min: cap.tseg2_min,
      tseg2_max: cap.tseg2_max,
      sjw_max: cap.sjw_max,
      brp_min: cap.brp_min,
      brp_max: cap.brp_max,
      brp_inc: cap.brp_inc
    }

    let candleDataCap: CandleCapability | undefined
    // Check if device supports CAN FD (feature bit 8 = 0x100)
    if (cap.feature & 0x100) {
      const dataCap = device.data_bt_const
      candleDataCap = {
        feature: dataCap.feature,
        fclk_can: dataCap.fclk_can,
        tseg1_min: dataCap.tseg1_min,
        tseg1_max: dataCap.tseg1_max,
        tseg2_min: dataCap.tseg2_min,
        tseg2_max: dataCap.tseg2_max,
        sjw_max: dataCap.sjw_max,
        brp_min: dataCap.brp_min,
        brp_max: dataCap.brp_max,
        brp_inc: dataCap.brp_inc
      }
    }

    return { cap: candleCap, dataCap: candleDataCap, feature: cap.feature }
  }

  /**
   * Build the channel plan for every enumerated device interface.
   *
   * Two flavours are supported:
   *  - `single`: one USB interface per CAN channel (custom Windows firmware).
   *              channel = bInterfaceNumber, one channel per interface.
   *  - `multi` : one USB interface carrying `dconf.icount + 1` channels
   *              (standard Linux gs_usb layout). All frames of those channels
   *              arrive on the same bulk pipe and carry the channel id in the
   *              frame header.
   *
   * Interfaces that belong to the same physical device are grouped by the
   * device interface path with the `&mi_XX` part removed, so an extra HID/CDC
   * interface of the same composite device never turns into a CAN channel.
   *
   * The heuristic can be overridden with
   * `ECUBUS_CANDLE_CHANNEL_MODE=interface|channel`.
   */
  /**
   * Read the device interface path.
   *
   * The native side appends the parent USB device instance id (separated by
   * 0x1f) so that all interfaces of one composite device can be grouped
   * together. Only the part before the separator is stored in `handle`.
   */
  private static readPath(device: any): { path: string; parentId: string } {
    const raw = String(Candle.GetDevicePath(device) || '')
    const sep = raw.indexOf('\x1f')
    if (sep < 0) {
      return { path: raw, parentId: '' }
    }
    return { path: raw.substring(0, sep), parentId: raw.substring(sep + 1) }
  }

  /** bInterfaceNumber encoded in the device interface path (`&mi_XX`). */
  private static miFromPath(path: string): number | undefined {
    const match = /&mi_([0-9a-f]{2})/i.exec(path)
    return match ? parseInt(match[1], 16) : undefined
  }

  static buildChannelPlans(rawList: any[], verbose = true): CandleChannelPlan[] {
    const forceMode = (process.env.ECUBUS_CANDLE_CHANNEL_MODE || '').toLowerCase()
    const forced: CandleChannelMode | undefined =
      forceMode === 'multi' || forceMode === 'channel' || forceMode === 'single-interface'
        ? 'multi'
        : forceMode === 'interface' || forceMode === 'per-interface' || forceMode === 'single'
          ? 'single'
          : undefined

    const groups = new Map<string, { device: any; path: string; parentId: string }[]>()
    for (const device of rawList) {
      const { path, parentId } = Candle_CAN.readPath(device)
      // All interfaces of one composite device share the parent instance id.
      // Fall back to the path without the &mi_XX part when it is unavailable.
      const key = parentId || path.replace(/&mi_[0-9a-f]{2}/i, '')
      const group = groups.get(key)
      if (group) {
        group.push({ device, path, parentId })
      } else {
        groups.set(key, [{ device, path, parentId }])
      }
    }

    const plans: CandleChannelPlan[] = []

    for (const [groupKey, entries] of groups) {
      const items = entries
        .map(({ device, path }) => ({
          device,
          path,
          name: Candle.GetDeviceFriendlyName(device) as string,
          // A busy interface could not be opened during the scan, so its
          // bInterfaceNumber was not read: recover the MI from the path.
          mi: Candle_CAN.miFromPath(path) ?? (Number(device.interfaceNumber) || 0),
          icount: Number(device.dconf?.icount) || 0,
          busy: Number(device.state) === 1
        }))
        .sort((a, b) => a.mi - b.mi)

      const groupStart = plans.length

      // Channels we already opened cannot be re-read (the device reports
      // itself as "in use"): replay their cached plan so the device list stays
      // complete and selectable while the device is running.
      const replay: CandleChannelPlan[] = []
      const fresh = items.filter((item) => {
        const cached = Candle_CAN.planCache.get(item.path)
        if (cached && Candle_CAN.openedDevices.has(item.path)) {
          replay.push(...cached.map((plan) => ({ ...plan, busy: false })))
          return false
        }
        return true
      })

      // Interfaces that cannot be probed during the scan (HID, busy devices,
      // interfaces without a WinUSB pipe pair) are excluded from the
      // classification, but stay selectable (and disabled).
      const usable = fresh.filter((item) => !item.busy)
      const candidates = usable.length > 0 ? usable : fresh

      if (candidates.length === 0) {
        // Every channel of this device is opened by us, nothing left to probe.
        plans.push(...replay)
        if (verbose) {
          const logLine =
            `candle group ${groupKey}: all interfaces in use, reused cached plan ` +
            `(${replay.length} channels)`
          if (Candle_CAN.lastGroupLog.get(`${groupKey}:busy`) !== logLine) {
            Candle_CAN.lastGroupLog.set(`${groupKey}:busy`, logLine)
            sysLog.info(logLine)
          }
        }
        continue
      }

      // A single interface reporting icount >= 1 carries all channels on its
      // own bulk pipe (standard gs_usb layout). As soon as the device exposes
      // more than one usable interface, every interface is one channel and the
      // firmware simply reports the device wide icount on each of them.
      let mode: CandleChannelMode
      if (forced) {
        mode = forced
      } else {
        mode = candidates.length === 1 && candidates[0].icount >= 1 ? 'multi' : 'single'
      }

      const primary = candidates[0]
      const multiChannelCount = primary.icount + 1
      // Several interfaces of one device usually share the same friendly name
      // (the per interface iInterface string is used when the firmware
      // provides one), so a channel suffix is added when the names collide.
      const distinctNames = new Set(candidates.map((item) => item.name)).size === candidates.length

      const handled = new Set<any>()
      if (mode === 'multi') {
        candidates.forEach((item) => handled.add(item.device))
        const { cap, dataCap, feature } = Candle_CAN.buildCap(primary.device)
        for (let ch = 0; ch < multiChannelCount; ch++) {
          plans.push({
            path: primary.path,
            label: `${primary.name} (Ch${ch})`,
            name: primary.name,
            mi: primary.mi,
            channel: ch,
            channelCount: multiChannelCount,
            mode,
            busy: primary.busy,
            feature,
            cap,
            dataCap
          })
        }
        if (verbose && candidates.length > 1) {
          sysLog.warn(
            `candle group ${groupKey}: ${candidates.length} interfaces, icount=${primary.icount}, ` +
              `channel mode forced to multi on interface ${primary.mi}`
          )
        }
      } else {
        for (const item of candidates) {
          handled.add(item.device)
          const { cap, dataCap, feature } = Candle_CAN.buildCap(item.device)
          const suffix = !distinctNames && candidates.length > 1 ? ` (Ch${item.mi})` : ''
          plans.push({
            path: item.path,
            label: `${item.name}${suffix}`,
            name: item.name,
            mi: item.mi,
            channel: item.mi,
            channelCount: 1,
            mode,
            busy: item.busy,
            feature,
            cap,
            dataCap
          })
        }
        if (
          verbose &&
          !forced &&
          candidates.length > 1 &&
          candidates.every((item) => item.icount === candidates[0].icount) &&
          candidates[0].icount > 0
        ) {
          // Ambiguous: every interface reports the same device wide icount.
          // If this device really carries all channels on a single interface,
          // force it with ECUBUS_CANDLE_CHANNEL_MODE=channel.
          const warnLine =
            `candle group ${groupKey}: ${candidates.length} interfaces all report icount=` +
            `${candidates[0].icount}, treated as one channel per interface ` +
            `(set ECUBUS_CANDLE_CHANNEL_MODE=channel if it is a single multi-channel interface)`
          if (Candle_CAN.lastGroupLog.get(`${groupKey}:warn`) !== warnLine) {
            Candle_CAN.lastGroupLog.set(`${groupKey}:warn`, warnLine)
            sysLog.warn(warnLine)
          }
        }
      }

      // Keep the remaining (busy / not openable) interfaces visible but disabled
      for (const item of fresh) {
        if (handled.has(item.device)) {
          continue
        }
        const { cap, dataCap, feature } = Candle_CAN.buildCap(item.device)
        plans.push({
          path: item.path,
          label: `${item.name} (Ch${item.mi})`,
          name: item.name,
          mi: item.mi,
          channel: item.mi,
          channelCount: 1,
          mode: 'single',
          busy: true,
          feature,
          cap,
          dataCap
        })
      }

      // Channels opened by us, replayed from the last healthy scan.
      plans.push(...replay)

      if (verbose) {
        const logLine =
          `candle group ${groupKey}: mode=${mode}, channels=${plans.length - groupStart}, ` +
          `interfaces=[${items
            .map((item) => `mi${item.mi}:icount=${item.icount}${item.busy ? ':busy' : ''}`)
            .join(', ')}], ` +
          `dconf=[${Candle_CAN.dconfHex((usable[0] ?? fresh[0] ?? items[0]).device)}]`
        // Only log when the classification changed, the device list is
        // re-enumerated on every UI refresh.
        if (Candle_CAN.lastGroupLog.get(`${groupKey}:info`) !== logLine) {
          Candle_CAN.lastGroupLog.set(`${groupKey}:info`, logLine)
          sysLog.info(logLine)
        }
      }

      // Remember the plan of a healthy scan, see the replay above.
      if (usable.length > 0) {
        const byPath = new Map<string, CandleChannelPlan[]>()
        for (const plan of plans.slice(groupStart)) {
          const list = byPath.get(plan.path)
          if (list) {
            list.push(plan)
          } else {
            byPath.set(plan.path, [plan])
          }
        }
        byPath.forEach((list, path) => Candle_CAN.planCache.set(path, list))
      }
    }

    return plans
  }

  constructor(info: CanBaseInfo) {
    super()
    this.id = info.id
    this.info = cloneDeep(info)

    const handleStr = String(this.info.handle)
    const parts = handleStr.split('|')
    if (parts.length !== 2) {
      throw new Error(`Invalid handle format: ${handleStr}, expected "path|channel"`)
    }
    this.devicePath = parts[0]
    this.channel = parseInt(parts[1], 10)

    const readList = new Candle.candle_list_t()
    Candle.candle_list_scan(readList)

    const devicesx = Candle.DeviceArray.frompointer(readList.dev)
    const devicesArray: any[] = []
    for (let i = 0; i < readList.num_devices; i++) {
      const dev = devicesx.getitem(i)
      devicesArray.push(dev)
    }

    // A USB interface may carry several CAN channels, so the interface path is
    // matched alone and the logical channel comes from the handle suffix.
    let deviceEntry = Candle_CAN.openedDevices.get(this.devicePath)

    if (deviceEntry) {
      // The interface is already opened by us. Reuse the channel mode recorded
      // by the first opener: a rescan of an opened interface reports it as
      // "in use" (dconf empty), so it can no longer be classified reliably.
      deviceEntry.refCount++
      this.channelMode = deviceEntry.mode
      this.channelCount = deviceEntry.channelCount
    } else {
      const targetDevice = devicesArray.find(
        (device) => Candle_CAN.readPath(device).path === this.devicePath
      )

      if (!targetDevice) {
        throw new Error(`Device not found: path="${this.devicePath}", channel=${this.channel}`)
      }

      const plan = Candle_CAN.buildChannelPlans(devicesArray, false).find(
        (item) => item.path === this.devicePath && item.channel === this.channel
      )
      if (plan) {
        this.channelMode = plan.mode
        this.channelCount = plan.channelCount
      } else {
        // The handle may be older than the current enumeration (e.g. channel
        // numbering changed after a firmware update), fall back to the icount.
        this.channelMode = (Number(targetDevice.dconf?.icount) || 0) >= 1 ? 'multi' : 'single'
        this.channelCount = this.channelMode === 'multi' ? Number(targetDevice.dconf.icount) + 1 : 1
        sysLog.warn(
          `candle ${this.devicePath}: handle channel ${this.channel} not in current plan, ` +
            `fallback to mode=${this.channelMode}`
        )
      }

      if (!Candle.candle_dev_open(targetDevice)) {
        throw new Error(`Failed to open device: ${this.devicePath}`)
      }
      deviceEntry = {
        device: targetDevice,
        refCount: 1,
        mode: this.channelMode,
        channelCount: this.channelCount
      }
      Candle_CAN.openedDevices.set(this.devicePath, deviceEntry)
    }

    if (this.channelMode === 'multi' && this.channel >= this.channelCount) {
      sysLog.warn(
        `candle ${this.devicePath}: channel ${this.channel} out of range ` +
          `(0..${this.channelCount - 1}), frames will be dropped`
      )
    }

    this.target = deviceEntry.device

    if (this.info.bitrate.clock == undefined) {
      throw new Error('Clock frequency is not set')
    }

    this.event = new EventEmitter()

    this.log = new CanLOG('CANABLE', this.info.name, this.id, this.event)

    let tsfnRegistered = false
    try {
      // Use the device's actual clock frequency from BT_CONST for all calculations
      const cap = this.target.bt_const
      const data_cap = this.target.data_bt_const
      const userClock = Number(this.info.bitrate.clock) * 1000000

      // Validate clock frequency matches device capability
      if (userClock != cap.fclk_can) {
        throw new Error(
          `Clock frequency mismatch: configuration specifies ${userClock} Hz, ` +
            `but device reports ${cap.fclk_can} Hz. ` +
            `Please update the device configuration to match the hardware.`
        )
      }
      const actualClock = cap.fclk_can

      // Validate baud rate config against the device's actual clock
      if (this.info.bitrate.freq) {
        const calcFreq = Math.floor(
          actualClock /
            (this.info.bitrate.preScaler *
              (1 + this.info.bitrate.timeSeg1 + this.info.bitrate.timeSeg2))
        )
        // Allow 1% error tolerance
        if (Math.abs(calcFreq - this.info.bitrate.freq) / this.info.bitrate.freq > 0.01) {
          throw new Error(
            `Invalid CAN bitrate config: expected ${this.info.bitrate.freq} Hz, got ${calcFreq} Hz (fclk=${actualClock}). ` +
              `preScaler=${this.info.bitrate.preScaler}, ` +
              `timeSeg1=${this.info.bitrate.timeSeg1}, ` +
              `timeSeg2=${this.info.bitrate.timeSeg2}`
          )
        }
      }

      const deviceEntry = Candle_CAN.openedDevices.get(this.devicePath)
      if (deviceEntry && deviceEntry.refCount === 1) {
        const candleInfo = {
          channel_count: (Number(this.target.dconf.icount) || 0) + 1,
          HW_version: `${(this.target.dconf.hw_version >> 24) & 0xff}.${(this.target.dconf.hw_version >> 16) & 0xff}.${(this.target.dconf.hw_version >> 8) & 0xff}`,
          SW_version: `${(this.target.dconf.sw_version >> 16) & 0xff}.${(this.target.dconf.sw_version >> 8) & 0xff}.${(this.target.dconf.sw_version >> 0) & 0xff}`,
          dconf: Candle_CAN.dconfHex(this.target)
        }
        sysLog.info(`candle ${this.info.name}: ${JSON.stringify(candleInfo)}`)
        sysLog.info(
          `candle ${this.info.name} arb timing: ${JSON.stringify({
            fclk_can: cap.fclk_can,
            tseg1_min: cap.tseg1_min,
            tseg1_max: cap.tseg1_max,
            tseg2_min: cap.tseg2_min,
            tseg2_max: cap.tseg2_max,
            sjw_max: cap.sjw_max,
            brp_min: cap.brp_min,
            brp_max: cap.brp_max,
            brp_inc: cap.brp_inc,
            feature: `0x${cap.feature.toString(16)}`
          })}`
        )
        if (cap.feature & 0x100) {
          sysLog.info(
            `candle ${this.info.name} fd timing: ${JSON.stringify({
              fclk_can: data_cap.fclk_can,
              tseg1_min: data_cap.tseg1_min,
              tseg1_max: data_cap.tseg1_max,
              tseg2_min: data_cap.tseg2_min,
              tseg2_max: data_cap.tseg2_max,
              sjw_max: data_cap.sjw_max,
              brp_min: data_cap.brp_min,
              brp_max: data_cap.brp_max,
              brp_inc: data_cap.brp_inc,
              feature: `0x${data_cap.feature.toString(16)}`
            })}`
          )
        }
      }
      if (
        this.info.bitrate.timeSeg1 < cap.tseg1_min ||
        this.info.bitrate.timeSeg1 > cap.tseg1_max
      ) {
        throw new Error(
          `Time segment 1 (${this.info.bitrate.timeSeg1}) out of valid range [${cap.tseg1_min}-${cap.tseg1_max}], open fail, please modify parameters and start again`
        )
      }

      if (
        this.info.bitrate.timeSeg2 < cap.tseg2_min ||
        this.info.bitrate.timeSeg2 > cap.tseg2_max
      ) {
        throw new Error(
          `Time segment 2 (${this.info.bitrate.timeSeg2}) out of valid range [${cap.tseg2_min}-${cap.tseg2_max}], open fail, please modify parameters and start again`
        )
      }

      // Check prescaler (BRP)
      if (this.info.bitrate.preScaler < cap.brp_min || this.info.bitrate.preScaler > cap.brp_max) {
        throw new Error(
          `Prescaler (${this.info.bitrate.preScaler}) out of valid range [${cap.brp_min}-${cap.brp_max}], open fail, please modify parameters and start again`
        )
      }
      //sjw
      if (this.info.bitrate.sjw > cap.sjw_max) {
        throw new Error(
          `SJW (${this.info.bitrate.sjw}) out of valid range [0-${cap.sjw_max}], open fail, please modify parameters and start again`
        )
      }
      const bittiming = new Candle.candle_bittiming_t()
      bittiming.prop_seg = 1
      bittiming.phase_seg1 = this.info.bitrate.timeSeg1 - 1
      bittiming.phase_seg2 = this.info.bitrate.timeSeg2
      bittiming.sjw = this.info.bitrate.sjw
      bittiming.brp = this.info.bitrate.preScaler

      if (!Candle.candle_channel_set_timing(this.target, this.channel, bittiming)) {
        throw new Error('Set timing failed')
      }
      const ra = new Candle.Uint8Array(1)

      if (this.info.candleRes) {
        ra.setitem(0, 1)
      } else {
        ra.setitem(0, 0)
      }
      const currentRes = new Candle.Uint8Array(1)
      const getSuccess = Candle.candle_channel_get_can_resister_enable_state(
        this.target,
        this.channel,
        currentRes.cast()
      )

      if (getSuccess) {
        const currentResState = currentRes[0] === 1
        const configResState = this.info.candleRes

        // Only perform the set operation when the configuration value is inconsistent with the hardware state
        if (currentResState !== configResState) {
          if (
            !Candle.candle_channel_set_can_resister_enable_state(
              this.target,
              this.channel,
              ra.cast()
            )
          ) {
            console.log('Set can resister enable state failed')
          }
        } else {
          console.log('Terminal resistor state matches configuration, no need to set')
        }
      } else {
        // Attempt to set even if fetching status fails (to avoid unknown hardware state).
        console.warn('Failed to get current terminal resistor state, attempting to set...')
        if (
          !Candle.candle_channel_set_can_resister_enable_state(this.target, this.channel, ra.cast())
        ) {
          console.log('Set can resister enable state failed')
        }
      }

      let flag = 0
      //canfd config
      if (this.info.canfd && this.info.bitratefd) {
        // Verify device actually supports CAN FD before proceeding
        // (GS_CAN_FEATURE_FD = BIT(8) = 0x100, same as CANDLE_MODE_FD)
        if (!(cap.feature & 0x100)) {
          throw new Error(
            'CAN FD is enabled in configuration but the device does not support CAN FD. ' +
              'Please disable CAN FD in the hardware settings, or use a CAN FD capable device.'
          )
        }
        //check
        const canfd_cap = this.target.data_bt_const
        if (
          this.info.bitratefd.timeSeg1 < canfd_cap.tseg1_min ||
          this.info.bitratefd.timeSeg1 > canfd_cap.tseg1_max
        ) {
          throw new Error(
            `FD time segment 1 (${this.info.bitratefd.timeSeg1}) out of valid range [${canfd_cap.tseg1_min}-${canfd_cap.tseg1_max}], open fail, please modify parameters and start again`
          )
        }
        if (
          this.info.bitratefd.timeSeg2 < canfd_cap.tseg2_min ||
          this.info.bitratefd.timeSeg2 > canfd_cap.tseg2_max
        ) {
          throw new Error(
            `FD time segment 2 (${this.info.bitratefd.timeSeg2}) out of valid range [${canfd_cap.tseg2_min}-${canfd_cap.tseg2_max}], open fail, please modify parameters and start again`
          )
        }
        if (
          this.info.bitratefd.preScaler < canfd_cap.brp_min ||
          this.info.bitratefd.preScaler > canfd_cap.brp_max
        ) {
          throw new Error(
            `FD prescaler (${this.info.bitratefd.preScaler}) out of valid range [${canfd_cap.brp_min}-${canfd_cap.brp_max}], open fail, please modify parameters and start again`
          )
        }
        if (this.info.bitratefd.sjw > canfd_cap.sjw_max) {
          throw new Error(
            `FD SJW (${this.info.bitratefd.sjw}) out of valid range [0-${canfd_cap.sjw_max}], open fail, please modify parameters and start again`
          )
        }
        const bittimingfd = new Candle.candle_bittiming_t()
        bittimingfd.prop_seg = 1
        bittimingfd.phase_seg1 = this.info.bitratefd.timeSeg1 - 1
        bittimingfd.phase_seg2 = this.info.bitratefd.timeSeg2
        bittimingfd.sjw = this.info.bitratefd.sjw
        bittimingfd.brp = this.info.bitratefd.preScaler
        if (!Candle.candle_channel_set_data_timing(this.target, this.channel, bittimingfd)) {
          throw new Error('Set data timing failed')
        }
        //can-fd flag
        flag |= 0x100
      }
      //error report flag

      // flag |= (1 << 12)

      const ts = new Candle.TS()

      if (!Candle.candle_dev_get_timestamp_us(this.target, ts.cast())) {
        // throw new Error('Get timestamp failed')
      }

      if (!Candle.candle_channel_set_interfacenumber_endpoints(this.target, this.channel)) {
        // throw new Error('Set interface number endpoints failed')
      }

      if (!Candle.candle_channel_start(this.target, this.channel, flag)) {
        // throw new Error('Start channel failed')
      }

      Candle_CAN.registerChannel(this.devicePath, this.channel, this, this.channelMode)
      tsfnRegistered = true
      if (!Candle.SetContextDevice(this.devicePath, this.target)) {
        throw new Error('Set context device failed')
      }

      this.attachCanMessage(this.busloadCb)
    } catch (err) {
      if (tsfnRegistered) {
        Candle_CAN.unregisterChannel(this.devicePath, this.channel)
      }
      Candle.candle_channel_stop(this.target, this.channel)

      const deviceEntry = Candle_CAN.openedDevices.get(this.devicePath)
      if (deviceEntry) {
        deviceEntry.refCount--
        if (deviceEntry.refCount === 0) {
          Candle.candle_dev_close(this.target)
          Candle_CAN.openedDevices.delete(this.devicePath)
        }
      }

      throw err
    }
  }

  callback(msg: any) {
    // Handle received CAN message
    if (msg) {
      // Extract CAN ID without flags
      const canId = msg.ID & 0x1fffffff
      const isEcho = msg.FrameType === 2 // CANDLE_FRAMETYPE_ECHO = 2
      const isExtended = (msg.ID & 0x80000000) !== 0 // CANDLE_ID_EXTENDED
      const isRtr = (msg.ID & 0x40000000) !== 0 // CANDLE_ID_RTR
      const isCanfd = (msg.Flags & 0x02) !== 0 // CANDLE_FLAG_FD
      const hasBrs = (msg.Flags & 0x04) !== 0 // CANDLE_FLAG_BRS
      const isErr = msg.FrameType === 3 // CANDLE_FRAMETYPE_ERROR = 3

      const msgType: CanMsgType = {
        idType: isExtended ? CAN_ID_TYPE.EXTENDED : CAN_ID_TYPE.STANDARD,
        brs: hasBrs,
        canfd: isCanfd,
        remote: isRtr
      }

      const data = msg.Data || Buffer.alloc(0)
      const cmdId = this.getReadBaseId(canId, msgType)
      if (isEcho) {
        // Handle echo frame (transmission confirmation)

        const items = this.pendingBaseCmds.get(cmdId)
        if (items && items.length > 0) {
          const item = items.shift()!
          if (items.length == 0) {
            this.pendingBaseCmds.delete(cmdId)
          }

          const message: CanMessage = {
            device: this.info.name,
            dir: 'OUT',
            id: canId,
            data: data,
            ts: msg.TimeStamp,
            msgType: msgType,
            database: item.extra?.database,
            name: item.extra?.name
          }
          this.log.canBase(message)
          this.event.emit(cmdId, message)
          item.resolve(msg.TimeStamp)
        }
      } else {
        if (isErr) {
          const ts = msg.TimeStamp
          //   console.log('[DEBUG] get ts:', ts)
          let str = ''
          /* bus off */
          if (msg.ID & 0x00000040) {
            str += 'BUS_OFF, '
          }
          // CAN_ERR_CRTL
          if (msg.ID & 0x00000004) {
            const err_ctrl = data[1]
            /* recovered to error active state */
            if (err_ctrl & 0x40) {
              str += 'ERROR_CRTL_ACTIVE, '
            }
            /* reached error passive status RX */
            if (err_ctrl & 0x10) {
              str += 'ERROR_CRTL_RX_PASSIVE, '
            }
            /* reached error passive status TX */
            if (err_ctrl & 0x20) {
              str += 'ERROR_CRTL_TX_PASSIVE, '
            }
            /* reached warning level for RX errors */
            if (err_ctrl & 0x04) {
              str += 'ERROR_CRTL_RX_WARNING, '
            }
            /* reached warning level for TX errors */
            if (err_ctrl & 0x08) {
              str += 'ERROR_CRTL_TX_WARNING, '
            }
          }
          // CAN_ERR_PROT  protocol violations
          if (msg.ID & 0x00000008) {
            const err_port = data[2]
            const err_port_crc = data[3]
            /* bit stuffing error */
            if (err_port & 0x04) {
              str += 'ERROR_PROT_STUFF, '
            }
            /* frame format error */
            if (err_port & 0x02) {
              str += 'ERROR_PROT_FORM, '
            }
            /* unable to send dominant bit */
            if (err_port & 0x08) {
              str += 'ERROR_PROT_BIT0, '
            }
            /* unable to send recessive bit */
            if (err_port & 0x10) {
              str += 'ERROR_PROT_BIT1, '
            }
            /* CRC sequence */
            if (err_port_crc & 0x08) {
              str += 'ERROR_PROT_CRC, '
            }
          }
          // CAN_ERR_ACK received no ACK on transmission
          if (msg.ID & 0x00000020) {
            str += 'ERROR_ACK, '
          }

          const transmit_error_count = data[6]
          const receive_error_count = data[7]
          if (transmit_error_count || receive_error_count) {
            str += `TX_ERR_CNT:${transmit_error_count} RX_ERR_CNT:${receive_error_count}`
          }
          this.log.error(ts, `bus error, ${str}`)
          this.close(true)
        } else {
          const message: CanMessage = {
            device: this.info.name,
            dir: 'IN',
            id: canId,
            data: data,
            ts: msg.TimeStamp,
            msgType: msgType,
            database: this.info.database
          }
          this.log.canBase(message) //打印接收帧
          this.event.emit(cmdId, message) //EventEmitter触发事件，接收帧触发
        }
      }
    }
  }

  errorCallback(error: any) {
    //TODO: handle error
    console.error('Candle send error:', error)

    // Handle send errors
    for (const [key, items] of this.pendingBaseCmds) {
      for (const item of items) {
        item.reject(new CanError(CAN_ERROR_ID.CAN_INTERNAL_ERROR, item.msgType, item.data, error))
      }
    }
    this.pendingBaseCmds.clear()
  }

  setOption(cmd: string, val: any): any {
    return this._setOption(cmd, val)
  }

  static loadDllPath(dllPath: string) {}

  static getRawDeviceList() {
    const list: any[] = []
    if (process.platform == 'win32') {
      const readList = new Candle.candle_list_t()
      const ret = Candle.candle_list_scan(readList)

      if (ret && readList.num_devices > 0) {
        const devicesx = Candle.DeviceArray.frompointer(readList.dev)
        // Convert device array to plain JS array
        const devicesArray: any[] = []
        for (let i = 0; i < readList.num_devices; i++) {
          devicesArray.push(devicesx.getitem(i))
        }
        // Sort by interfaceNumber in ascending order
        devicesArray.sort((a, b) => a.interfaceNumber - b.interfaceNumber)

        // 按排序后的顺序添加到列表
        for (const device of devicesArray) {
          list.push(device)
        }
      }

      return list
    }
    return []
  }
  static override getValidDevices(): CanDevice[] {
    if (process.platform != 'win32') {
      return []
    }

    const plans = Candle_CAN.buildChannelPlans(this.getRawDeviceList())

    return plans.map((plan) => {
      const pathStr = plan.path
      return {
        label: plan.label,
        id: `Candle_Ch${plan.channel}_${pathStr.substring(0, 8)}`,
        handle: `${pathStr}|${plan.channel}`,
        serialNumber: pathStr,
        busy: plan.busy,
        extra: {
          candle: {
            cap: plan.cap,
            dataCap: plan.dataCap,
            fdSupported: !!(plan.feature & 0x100),
            Res: !!(plan.feature & 0x800),
            channel: plan.channel,
            channelCount: plan.channelCount,
            mode: plan.mode,
            parentKey: plan.path
          }
        }
      }
    })
  }

  static override getLibVersion(): string {
    if (process.platform == 'win32') {
      const v = Candle_CAN.getRawDeviceList()[0]
      if (v) {
        return `SW:${(v.dconf.sw_version >> 16) & 0xff}.${(v.dconf.sw_version >> 8) & 0xff}.${(v.dconf.sw_version >> 0) & 0xff}
                HW:${(v.dconf.hw_version >> 24) & 0xff}.${(v.dconf.hw_version >> 16) & 0xff}.${(v.dconf.hw_version >> 8) & 0xff}
                channel:${(Number(v.dconf.icount) || 0) + 1}`
      }
      return '1.0.0'
    } else {
      return 'only support windows'
    }
  }

  close(isReset = false, msg?: string) {
    this.readAbort.abort()

    for (const [key, value] of this.rejectBaseMap) {
      value.reject(new CanError(CAN_ERROR_ID.CAN_BUS_CLOSED, value.msgType))
    }

    this.rejectBaseMap.clear()

    for (const [key, vals] of this.pendingBaseCmds) {
      for (const val of vals) {
        val.reject(new CanError(CAN_ERROR_ID.CAN_BUS_CLOSED, val.msgType))
      }
    }
    this.pendingBaseCmds.clear()

    if (isReset) {
      /* In HSCAN device, the device auto-resets on bus-off.*/
      // Reset logic would go here
      return
    } else {
      this.closed = true
      this.log.close()
      Candle_CAN.unregisterChannel(this.devicePath, this.channel)
      Candle.candle_channel_stop(this.target, this.channel)
      const deviceEntry = Candle_CAN.openedDevices.get(this.devicePath)
      if (deviceEntry) {
        deviceEntry.refCount--
        if (deviceEntry.refCount === 0) {
          Candle.candle_dev_close(this.target)
          Candle_CAN.openedDevices.delete(this.devicePath)
        }
      }
    }
    this._close()
  }
  writeBase(
    //发送报文
    id: number,
    msgType: CanMsgType,
    data: Buffer,
    extra?: { database?: string; name?: string }
  ): Promise<number> {
    let maxLen = msgType.canfd ? 64 : 8 //最大长度
    if (data.length > maxLen) {
      throw new CanError(CAN_ERROR_ID.CAN_PARAM_ERROR, msgType, data)
    }

    if (msgType.canfd) {
      //CANFD帧
      //detect data.length range by dlc
      if (data.length > 8 && data.length <= 12) {
        maxLen = 12
      } else if (data.length > 12 && data.length <= 16) {
        maxLen = 16
      } else if (data.length > 16 && data.length <= 20) {
        maxLen = 20
      } else if (data.length > 20 && data.length <= 24) {
        maxLen = 24
      } else if (data.length > 24 && data.length <= 32) {
        maxLen = 32
      } else if (data.length > 32 && data.length <= 48) {
        maxLen = 48
      } else if (data.length > 48) {
        maxLen = 64
      } else {
        maxLen = data.length
      }
      data = Buffer.concat([data, Buffer.alloc(maxLen - data.length).fill(0)]) //合并数据和填充数据0
    }

    const cmdId = this.getReadBaseId(id, msgType)
    //queue
    return this._writeBase(id, msgType, cmdId, data, extra) //发送函数
  }
  _writeBase(
    //发送函数
    id: number,
    msgType: CanMsgType,
    cmdId: string,
    data: Buffer,
    extra?: { database?: string; name?: string }
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const item = this.pendingBaseCmds.get(cmdId)
      if (item) {
        item.push({ resolve, reject, data, msgType, extra })
      } else {
        this.pendingBaseCmds.set(cmdId, [{ resolve, reject, data, msgType, extra }])
      }

      try {
        const frame = new Candle.candle_frame_t()

        // 设置 CAN ID，根据 ID 类型添加标志位
        let canId = id
        if (msgType.idType === CAN_ID_TYPE.EXTENDED) {
          canId += 0x80000000 // CANDLE_ID_EXTENDED
        }
        if (msgType.remote) {
          canId += 0x40000000 // CANDLE_ID_RTR
        }
        frame.can_id = canId
        frame.channel = this.channel
        // 设置 DLC (Data Length Code)
        if (msgType.canfd) {
          const dataArray = Candle.Uint8Array.frompointer(frame.msg.canfd.data)
          for (let i = 0; i < data.length; i++) {
            dataArray.setitem(i, data[i])
          }
          frame.can_dlc = getDlcByLen(data.length, true)
        } else {
          const dataArray = Candle.Uint8Array.frompointer(frame.msg.classic_can.data)
          for (let i = 0; i < data.length; i++) {
            dataArray.setitem(i, data[i])
          }
          frame.can_dlc = data.length
        }

        // 设置通道号
        frame.channel = this.channel

        // 设置标志位
        let falg = 0
        if (msgType.canfd) {
          falg += 0x02 // CANDLE_FLAG_FD
          if (msgType.brs) {
            falg += 0x04 // CANDLE_FLAG_BRS
          }
        }
        frame.flags = falg

        Candle.SendCANMsg(this.devicePath, this.channel, frame)
      } catch (err: any) {
        const items = this.pendingBaseCmds.get(cmdId)
        if (items && items.length > 0) {
          items.pop()
        }
        reject(new CanError(CAN_ERROR_ID.CAN_INTERNAL_ERROR, msgType, data, err))
      }
    })
  }

  readBase(
    id: number,
    msgType: CanMsgType,
    timeout: number
  ): Promise<{ data: Buffer; ts: number }> {
    return new Promise<{ data: Buffer; ts: number }>(
      (
        resolve: (value: { data: Buffer; ts: number }) => void,
        reject: (reason: CanError) => void
      ) => {
        const cmdId = this.getReadBaseId(id, msgType)
        const cnt = this.cnt++
        this.rejectBaseMap.set(cnt, { reject, msgType })

        this.readAbort.signal.addEventListener('abort', () => {
          if (this.rejectBaseMap.has(cnt)) {
            this.rejectBaseMap.delete(cnt)
            reject(new CanError(CAN_ERROR_ID.CAN_BUS_CLOSED, msgType))
          }
          this.event.off(cmdId, readCb)
        })

        const readCb = (val: any) => {
          if (this.rejectBaseMap.has(cnt)) {
            if (val instanceof CanError) {
              reject(val)
            } else {
              resolve({ data: val.data, ts: val.ts })
            }
            this.rejectBaseMap.delete(cnt)
          }
        }

        this.event.once(cmdId, readCb)
      }
    )
  }

  getReadBaseId(id: number, msgType: CanMsgType): string {
    return `${id}-${msgType.canfd ? msgType.brs : false}-${msgType.remote}-${msgType.canfd}-${msgType.idType}`
  }
}
