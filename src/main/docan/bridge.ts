import { CanBase } from './base'
import { CanMessage, CanMsgType, CAN_ID_TYPE } from '../share/can'

/**
 * Configuration for a CAN bridge between two CanBase instances.
 * The bridge forwards CAN/CANFD frames bidirectionally at the abstract message level.
 */
export interface CanBridgeConfig {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Device key for Side A (referenced from data.devices) */
  sideADeviceKey: string
  /** Device key for Side B (referenced from data.devices) */
  sideBDeviceKey: string
  /** Optional CAN ID filter — only forward frames matching these IDs (empty = all) */
  filterIds?: number[]
}

/** Per-direction bridge statistics */
export interface BridgeDirectionStats {
  forwardedFrames: number
  droppedFrames: number
  lastForwardedTs: number
}

/** Aggregate bridge statistics */
export interface BridgeStats {
  sideAToB: BridgeDirectionStats
  sideBToA: BridgeDirectionStats
  active: boolean
}

/** Default deduplication window in milliseconds */
const DEDUP_WINDOW_MS = 50

/** Internal dedup key: CAN ID + DLC + first 8 bytes of data */
function dedupKey(msg: CanMessage): string {
  const dataPreview = msg.data.slice(0, 8).toString('hex')
  return `${msg.id}:${msg.msgType.canfd ? 'FD' : 'C'}:${dataPreview}`
}

/**
 * Bidirectional CAN bridge between two CanBase instances.
 *
 * Works with ANY CanBase implementation — PEAK, Vector (physical or virtual),
 * ZLG, KVASER, Candle, SLCAN, Simulate, Toomoss, etc.
 *
 * The bridge subscribes to the `'can-frame'` event on both sides and forwards
 * IN-direction frames to the opposite side via `writeBase()`. Echo/OUT frames
 * are ignored to prevent infinite loops. A short deduplication window prevents
 * forwarding frames that were just forwarded from the other side.
 */
export class CanBridge {
  readonly id: string
  readonly name: string
  readonly sideA: CanBase
  readonly sideB: CanBase

  private filterIds?: number[]
  private started = false

  // Deduplication: track recently forwarded frames to avoid loops
  private recentlyForwardedAtoB = new Map<string, number>()
  private recentlyForwardedBtoA = new Map<string, number>()

  // Statistics
  private stats: BridgeStats = {
    sideAToB: { forwardedFrames: 0, droppedFrames: 0, lastForwardedTs: 0 },
    sideBToA: { forwardedFrames: 0, droppedFrames: 0, lastForwardedTs: 0 },
    active: false
  }

  // Bound handlers (for proper cleanup)
  private handlerAtoB: (msg: CanMessage) => void
  private handlerBtoA: (msg: CanMessage) => void

  /**
   * @param config  Bridge configuration
   * @param sideA   First CanBase instance
   * @param sideB   Second CanBase instance
   */
  constructor(config: CanBridgeConfig, sideA: CanBase, sideB: CanBase) {
    this.id = config.id
    this.name = config.name
    this.sideA = sideA
    this.sideB = sideB

    if (config.filterIds && config.filterIds.length > 0) {
      this.filterIds = config.filterIds
    }

    // handlerAtoB: receives from sideA, forwards to sideB
    // - myDedup = recentlyForwardedAtoB (records what A→B forwarded)
    // - peerDedup = recentlyForwardedBtoA (checks what B→A forwarded, i.e. loopback detection)
    this.handlerAtoB = this.createForwardHandler(
      sideA,
      sideB,
      'AtoB',
      this.recentlyForwardedAtoB,
      this.recentlyForwardedBtoA
    )

    // handlerBtoA: receives from sideB, forwards to sideA
    // - myDedup = recentlyForwardedBtoA (records what B→A forwarded)
    // - peerDedup = recentlyForwardedAtoB (checks what A→B forwarded, i.e. loopback detection)
    this.handlerBtoA = this.createForwardHandler(
      sideB,
      sideA,
      'BtoA',
      this.recentlyForwardedBtoA,
      this.recentlyForwardedAtoB
    )
  }

  /**
   * Start bridging. Registers 'can-frame' listeners on both sides.
   * Must be called after both devices are opened and activated.
   */
  start(): void {
    if (this.started) return

    this.sideA.event.on('can-frame', this.handlerAtoB)
    this.sideB.event.on('can-frame', this.handlerBtoA)
    this.started = true
    this.stats.active = true

    global.sysLog.info(
      `[Bridge:${this.name}] Started bridging ${this.sideA.info.name} <-> ${this.sideB.info.name}`
    )
  }

  /**
   * Stop bridging. Removes all listeners.
   */
  stop(): void {
    if (!this.started) return

    this.sideA.event.off('can-frame', this.handlerAtoB)
    this.sideB.event.off('can-frame', this.handlerBtoA)
    this.started = false
    this.stats.active = false

    this.recentlyForwardedAtoB.clear()
    this.recentlyForwardedBtoA.clear()

    global.sysLog.info(`[Bridge:${this.name}] Stopped`)
  }

  /** Get current bridge statistics */
  getStats(): BridgeStats {
    return { ...this.stats }
  }

  /** Check if bridge is currently active */
  isActive(): boolean {
    return this.started
  }

  /**
   * Create a forward handler for one direction of the bridge.
   *
   * Deduplication strategy:
   * - Each handler records forwarded frames in its `myDedup` map.
   * - Each handler checks ONLY the OTHER handler's records (`peerDedup`).
   * - This way periodic messages from the source side pass through freely,
   *   but loopback/echo from the target side is caught via the peer's records.
   *
   * Example (handlerAtoB: sideA → sideB):
   *   t=0ms:  CANape sends F on sideA → myDedup[F] absent, peerDedup[F] absent → FORWARD
   *           → record F in myDedup (recentlyForwardedAtoB)
   *   t=5ms:  PCAN echoes F back (handlerBtoA fires) → peerDedup (recentlyForwardedAtoB)
   *           has F at t=0 → SKIP (loop prevention)
   *   t=10ms: CANape sends F again → peerDedup[F] absent (handlerBtoA never recorded F)
   *           → FORWARD ✓
   *
   * @param source    Source CanBase (where frames are received)
   * @param target    Target CanBase (where frames are forwarded to)
   * @param direction Label for logging/stats
   * @param myDedup   This handler's forward records (checked by the OTHER handler)
   * @param peerDedup The OTHER handler's forward records (checked by THIS handler)
   */
  private createForwardHandler(
    source: CanBase,
    target: CanBase,
    direction: 'AtoB' | 'BtoA',
    myDedup: Map<string, number>,
    peerDedup: Map<string, number>
  ): (msg: CanMessage) => void {
    const statsKey = direction === 'AtoB' ? 'sideAToB' : 'sideBToA'

    return (msg: CanMessage) => {
      // Only forward IN-direction frames (received from the bus)
      // OUT frames are echo/loopback confirmations and should not be forwarded
      if (msg.dir !== 'IN') return

      // Optional CAN ID filter
      if (this.filterIds && !this.filterIds.includes(msg.id)) return

      const now = Date.now()
      const key = dedupKey(msg)

      // Check peer dedup: was this frame recently forwarded FROM the target side TO us?
      // If yes, this is an echo/loopback of our own forward — skip to prevent loop.
      const peerTs = peerDedup.get(key)
      if (peerTs !== undefined && now - peerTs < DEDUP_WINDOW_MS) {
        return
      }

      // Record in our dedup so the opposite direction can skip the echo
      myDedup.set(key, now)

      // Forward via writeBase
      target
        .writeBase(msg.id, msg.msgType, msg.data)
        .then(() => {
          this.stats[statsKey].forwardedFrames++
          this.stats[statsKey].lastForwardedTs = now
        })
        .catch((err) => {
          this.stats[statsKey].droppedFrames++
          global.sysLog.warn(
            `[Bridge:${this.name}] Failed to forward frame ID=0x${msg.id.toString(16)} (${direction}): ${err.message}`
          )
        })

      // Periodically clean old dedup entries
      if (myDedup.size > 500) {
        this.cleanDedupMap(myDedup, now)
      }
      if (peerDedup.size > 500) {
        this.cleanDedupMap(peerDedup, now)
      }
    }
  }

  /** Remove dedup entries older than the window */
  private cleanDedupMap(map: Map<string, number>, now: number): void {
    for (const [key, ts] of map) {
      if (now - ts > DEDUP_WINDOW_MS * 2) {
        map.delete(key)
      }
    }
  }
}
