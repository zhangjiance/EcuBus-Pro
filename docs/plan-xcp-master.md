# XCP Master Implementation Plan for EcuBus-Pro

> **Status**: Draft — 材料持续收集中
> **Created**: 2026-06-08
> **Based on**: candle 动态波特率改造后的 CAN/CAN FD 基础设施

---

## 1. 背景与目标

在 EcuBus-Pro 中实现 XCP (Universal Measurement and Calibration Protocol) 主站功能，目标：

- **Phase 1**: A2L 解析器 — 加载 `.a2l` 文件，提取 MEASUREMENT/CHARACTERISTIC 列表和地址映射
- **Phase 2**: XCP on CAN/CAN FD 协议栈 — 实现 CTO 命令（CONNECT/SET_MTA/UPLOAD/DOWNLOAD/DAQ 配置等）
- **Phase 3**: UI 集成 — 类似 UDS 面板：A2L 文件加载 → 变量树 → 实时测量图表
- **Phase 4**: DAQ 模式 — 支持高速同步数据采集

---

## 2. 已有基础设施

### 2.1 CAN/CAN FD 传输层

EcuBus-Pro 已支持 7 种 CAN 硬件的收发，全支持 CAN FD BRS：

| 硬件 | 模块 | CAN FD |
|------|------|--------|
| candle (gs_usb) | `src/main/docan/candle/` | ✅ |
| peak | `src/main/docan/peak/` | ✅ |
| kvaser | `src/main/docan/kvaser/` | ✅ |
| vector | `src/main/docan/vector/` | ✅ |
| zlg | `src/main/docan/zlg/` | ✅ |
| toomoss | `src/main/docan/toomoss/` | ✅ |
| slcan | `src/main/docan/slcan/` | ✅ |

### 2.2 相关模块

| 模块 | 路径 | 可复用内容 |
|------|------|-----------|
| Worker API | `src/main/worker/` | 用户脚本扩展框架 |
| UDS TP | 已有 ISO-15765 多帧传输 | 分片重组参考 |
| SecurityAccess | UDS 安全解锁框架 | XCP GET_SEED/UNLOCK 参考 |
| DBC/LDF parser | 已有解析器 | 语法树解析经验 |

---

## 3. 调研材料

### 3.1 XCP 从站参考实现

**路径**: `D:\Users\Desktop\xcp_demo\Middleware\XCP_Basic`
**来源**: Vector Informatik XCP Basic V1.30.04 (embedded C)
**License**: Vector 版权 — 仅供参考协议格式，不可直接引用代码

#### 文件结构

```
Middleware/XCP_Basic/
├── inc/
│   ├── XcpBasic.h    (2404行)  XCP 协议层核心：全部命令码、CRO/CRM 结构定义、DAQ 类型
│   ├── xcp_cfg.h     (58行)    硬件适配配置：字节序、校准使能、校验和类型
│   ├── xcp_def.h     (167行)   默认设置（不必修改）
│   ├── xcp_par.h     (20行)    参数声明
│   └── xcp_if.h                应用接口：ApplXcpSend/GetPointer/Init/Background
└── src/
    ├── XcpBasic.c    (实现文件) XCP 命令处理、状态机、DAQ 管理
    ├── xcp_appl.c               应用层回调
    ├── xcp_if.c                 接口实现
    └── xcp_par.c                参数定义
```

#### 关键可参考内容

**XCP 命令码** (`XcpBasic.h:295-388`):

```c
// Standard Commands
#define CC_CONNECT             0xFF
#define CC_DISCONNECT          0xFE
#define CC_GET_STATUS          0xFD
#define CC_SYNC                0xFC
#define CC_GET_COMM_MODE_INFO  0xFB
#define CC_GET_ID              0xFA
#define CC_SET_REQUEST         0xF9
#define CC_GET_SEED            0xF8
#define CC_UNLOCK              0xF7
#define CC_SET_MTA             0xF6
#define CC_UPLOAD              0xF5
#define CC_SHORT_UPLOAD        0xF4
#define CC_BUILD_CHECKSUM       0xF3

// Calibration Commands
#define CC_DOWNLOAD            0xF0
#define CC_DOWNLOAD_NEXT       0xEF
#define CC_SHORT_DOWNLOAD      0xED
#define CC_MODIFY_BITS         0xEC

// DAQ Commands
#define CC_CLEAR_DAQ_LIST      0xE3
#define CC_SET_DAQ_PTR         0xE2
#define CC_WRITE_DAQ           0xE1
#define CC_START_STOP_DAQ_LIST 0xDE
#define CC_START_STOP_SYNCH    0xDD
#define CC_GET_DAQ_CLOCK       0xDC
#define CC_FREE_DAQ            0xD6
#define CC_ALLOC_DAQ           0xD5
#define CC_ALLOC_ODT           0xD4
#define CC_ALLOC_ODT_ENTRY     0xD3
```

**PID 标识** (`XcpBasic.h:393-397`):

```c
#define PID_RES  0xFF  // Response
#define PID_ERR  0xFE  // Error
#define PID_EV   0xFD  // Event
#define PID_SERV 0xFC  // Service Request
```

**错误码** (`XcpBasic.h:399-421`):

```c
#define CRC_CMD_UNKNOWN     0x20
#define CRC_CMD_SYNTAX      0x21
#define CRC_OUT_OF_RANGE    0x22
#define CRC_WRITE_PROTECTED 0x23
#define CRC_ACCESS_DENIED   0x24
#define CRC_ACCESS_LOCKED   0x25
#define CRC_PAGE_NOT_VALID  0x26
#define CRC_SEQUENCE        0x29
#define CRC_MEMORY_OVERFLOW 0x30
#define CRC_GENERIC         0x31
```

**CRO/CRM 结构体宏** (`XcpBasic.h:716-1342`) — 每个命令的请求/响应字段偏移和长度：

```c
// CONNECT example
#define CRO_CONNECT_LEN             2
#define CRO_CONNECT_MODE            CRO_BYTE(1)
#define CRM_CONNECT_LEN             8
#define CRM_CONNECT_RESOURCE        CRM_BYTE(1)
#define CRM_CONNECT_COMM_BASIC      CRM_BYTE(2)
#define CRM_CONNECT_MAX_CTO_SIZE    CRM_BYTE(3)
#define CRM_CONNECT_MAX_DTO_SIZE    CRM_WORD(2)
#define CRM_CONNECT_PROTOCOL_VERSION CRM_BYTE(6)
#define CRM_CONNECT_TRANSPORT_VERSION CRM_BYTE(7)
```

**字节序处理** (`XcpBasic.h:1360-1394`) — Little/Big-Endian 宏定义

**DAQ 类型系统** (`XcpBasic.h:1547-1668`) — ODT/DAQ List/动态分配结构体

**CAN FD 配置关键** (`xcp_def.h:26-30`):

```c
#define kXcpMaxCTO 8   // 经典 CAN → 改为 64 适配 CAN FD
#define kXcpMaxDTO 8
```

---

### 3.2 A2L 解析工具

**路径**: `D:\Users\Documents\geekdebugprobe-webui\static\a2l-utils`
**来源**: geekdebugprobe-webui
**License**: 待确认

#### 文件结构 (~3700 行 JS)

```
a2l-utils/
├── js/
│   ├── a2l-parser.js    (842行)  词法分析器 + 栈式解析器 → AST
│   ├── a2l-gen.js       (1288行) A2L 模板生成、ELF 地址填充、AST 合并
│   ├── a2l-tree.js      (721行)  AST 可视化（可折叠树形视图 + 搜索）
│   ├── app.js           (451行)  主应用逻辑
│   └── config-editor.js (465行)  配置编辑器
├── parser_table.json             ASAM 语法表（所有关键字、参数类型、父子关系）
├── default-template.a2l          A2L 默认模板
├── config.json                   配置文件
└── index.html
```

#### 架构亮点

```
Tokenizer (逐字符状态机)
  → 输出 Token 流 (IDENT/STRING/INT/FLOAT/HEX/BEGIN/END)
  → Parser (栈式匹配 parser_table.json 中的关键字树)
  → AST (ValueContainer 树结构)
  → Serializer (AST → A2L 文本)
  → AddressReplacer (遍历 AST 替换 ECU_ADDRESS)
```

#### 解析器核心类

| 类 | 功能 |
|---|------|
| `A2LTokenizer` | tokenize() → Token[] |
| `A2LParser` | parse() → AST (ValueContainer tree) |
| `A2LSerializer` | serialize(AST) → A2L text |
| `A2LGenerator` | fillAddressesFromELF(symbols, dwarfParser) → merge ASTs |
| `A2LTreeView` | render(AST) → collapsible HTML tree |

#### 转换可行性

- **纯 JS 实现** → TypeScript 直译，几乎零成本
- `parser_table.json` 即 ASAM A2L 标准语法表
- 支持的关键字完整覆盖 A2L V1.61

---

### 3.3 candleLight 固件分析

**路径**: `D:\Users\Documents\candleLight_fw`
**来源**: Hubert Denkmair 开源固件
**License**: MIT

**路径**: `D:\Users\Documents\CANable-2.5-firmware-Slcan-and-Candlelight`
**来源**: ElmueSoft CANable 2.5 固件

#### USB 帧处理（与 XCP 传输层无关，但确认 TX 帧格式正确性）

**gs_host_frame 结构** (`include/gs_usb.h:312-345`):

```c
struct classic_can     { u8 data[8]; };
struct classic_can_ts  { u8 data[8]; u32 timestamp_us; };
struct canfd            { u8 data[64]; };
struct canfd_ts         { u8 data[64]; u32 timestamp_us; };

struct gs_host_frame {
    u32 echo_id, can_id;
    u8 can_dlc, channel, flags, reserved;
    union { classic_can, classic_can_ts, canfd, canfd_ts };
};
```

**TX 帧校验逻辑** (`src/usbd_gs_can.c:668-682`):

```c
// Classic CAN: 最小 20 字节 (12 header + 8 data)
if (rxlen < struct_size(hf, classic_can, 1)) goto out;

// CAN FD: 最小 76 字节 (12 header + 64 data)
if (flags & GS_CAN_FLAG_FD && rxlen < struct_size(hf, canfd, 1)) goto out;
```

**结论**: 固件对 TX 帧只用最小长度检查。时间戳字段仅用于 RX 方向（设备→主机）。

---

## 4. XCP 协议架构设计

### 4.1 协议分层

```
┌──────────────────────────────────────────┐
│  XCP Protocol Layer (CTO/DTO)            │ ← 新建 TypeScript 模块
│  - 命令编码/解码 (CRO → CRM)              │
│  - 状态机 (连接/断开/DAQ)                 │
│  - 错误处理                               │
├──────────────────────────────────────────┤
│  XCP Transport Layer                     │ ← 新建
│  - CTO/DTO 帧封装/解包                   │
│  - CAN ID 分配                            │
│  - 分片重组 (如需要)                      │
├──────────────────────────────────────────┤
│  CAN/CAN FD Transport                    │ ← 已有 docan/
│  - candle/peak/kvaser/vector/zlg/...     │
└──────────────────────────────────────────┘
```

### 4.2 帧格式

```
CTO (Command Transfer Object) — 控制帧:
┌──────┬─────────────────────────────┐
│ PID  │      Command Data            │
│ 1B   │      (N-1 bytes)            │
├──────┼─────────────────────────────┤
│ 0xFF │  CONNECT: mode=0x00         │
│ 0xF8 │  GET_SEED: mode, resource   │
│  ... │  ...                        │
└──────┴─────────────────────────────┘

DTO (Data Transfer Object) — 数据传输帧:
┌──────┬──────────────────────────────┐
│ PID  │  DAQ/STIM/Resync data        │
│ 1B   │  (N-1 bytes)                │
└──────┴──────────────────────────────┘
```

### 4.3 CAN FD 优势

| 参数 | 经典 CAN | CAN FD |
|------|----------|--------|
| Max DLC | 8 | 64 |
| CTO 大小 | 8 bytes (刚好 1 帧) | 8 bytes (1 帧) |
| DTO 大小 | 8 bytes (需要分片) | 可到 64 bytes (大幅减少分片) |
| BRS | N/A | 数据段加速到 5-8 Mbps |

**XCP on CAN FD 不需要分片层** — 64 字节足以承载绝大多数 XCP CTO 命令。DTO 最大长度可从 8 扩展到 64。

---

## 5. 实现计划

### Phase 1: A2L 解析器 (预估 1-2 天)

**从 `a2l-utils` 转换到 TypeScript**

```
a2l-utils/js/a2l-parser.js    → src/main/a2l/parser.ts
a2l-utils/js/a2l-gen.js       → src/main/a2l/generator.ts
a2l-utils/parser_table.json   → src/main/a2l/amdl-table.json
a2l-utils/default-template.a2l → resources/template.a2l
```

**产出**:
- [ ] `A2LTokenizer` — 词法分析
- [ ] `A2LParser` — AST 构建
- [ ] `A2LSerializer` — AST → A2L 文本
- [ ] `extractSymbols()` — 提取 MEASUREMENT/CHARACTERISTIC 列表
- [ ] `fillAddressesFromELF()` — 从 ELF 文件填充地址
- [ ] IPC handler — 渲染进程加载 A2L 文件

### Phase 2: XCP 协议层 (预估 2-3 天)

**参考 `XCP_Basic/XcpBasic.h` 的定义**

```
src/main/xcp/
├── commands.ts       — 命令码常量 (来自 XcpBasic.h:295-388)
├── cro.ts            — CRO 编码 (请求帧构建)
├── crm.ts            — CRM 解码 (响应帧解析)
├── error.ts          — 错误码定义
├── session.ts        — XCP 会话状态机
├── transport.ts      — CAN/CAN FD 传输适配
├── checksum.ts       — ADD11/CRC16/CRC32 校验和
└── index.ts          — 导出 XcpMaster 类
```

**关键接口**:
```ts
class XcpMaster {
  constructor(canChannel: CanBase, croId: number, dtoId: number)
  connect(): Promise<void>
  disconnect(): Promise<void>
  getSeed(mode: number, resource: number): Promise<Buffer>
  unlock(key: Buffer): Promise<void>
  setMta(addrExt: number, addr: number): Promise<void>
  upload(size: number): Promise<Buffer>
  shortUpload(size: number, addrExt: number, addr: number): Promise<Buffer>
  download(data: Buffer): Promise<void>
  // DAQ
  allocDaq(count: number): Promise<void>
  allocOdt(daq: number, count: number): Promise<void>
  allocOdtEntry(daq: number, odt: number, count: number): Promise<void>
  setDaqPtr(daq: number, odt: number, idx: number): Promise<void>
  writeDaq(bitOffset: number, size: number, addrExt: number, addr: number): Promise<void>
  startStopDaqList(mode: number, daq: number): Promise<number> // returns first PID
  // ...
}
```

### Phase 3: UI 集成 (预估 2-3 天)

**参考现有 UDS 面板架构** (`src/renderer/src/views/uds/`)

```
src/renderer/src/views/xcp/
├── layout.ts          — XCP 工作区布局
├── a2lLoader.vue      — A2L 文件加载 + 变量树
├── measurement.vue    — 实时测量图表（复用 Trace 组件）
├── calibration.vue    — 标定面板（读取/写入变量）
└── daqConfig.vue      — DAQ 列表配置
```

### Phase 4: DAQ 模式 (预估 2-3 天)

- [ ] 动态 DAQ 列表分配
- [ ] ODT 条目自动配置
- [ ] 事件同步测量
- [ ] DMA/DTO 高速采集（Worker 线程处理）

---

## 6. 关键风险

| 风险 | 缓解 |
|------|------|
| A2L 文件语法随 ASAM 版本变化 | `parser_table.json` 覆盖 V1.6-V1.7 |
| XCP 从站实现差异（Vector / ETAS / 开源） | 参考 Vector 标准实现，提供兼容模式 |
| DAQ 模式性能瓶颈 | CAN FD BRS 可大幅提升，Worker 线程卸载处理 |
| ELF 地址解析（DWARF 调试信息） | `a2l-utils` 已有 ELF→地址 功能 |

---

## 7. 参考材料

| 材料 | 路径/链接 |
|------|----------|
| XCP 书籍 (ASAM) | 对话历史中的 ETAS 文档 |
| XCP V1.5 规范 | ASAM MCD-1 XCP |
| Vector XCP Basic 源码 | `D:\Users\Desktop\xcp_demo\Middleware\XCP_Basic` |
| candleLight 固件 | `D:\Users\Documents\candleLight_fw` |
| CANable 2.5 固件 | `D:\Users\Documents\CANable-2.5-firmware-Slcan-and-Candlelight` |
| A2L utils (JS) | `D:\Users\Documents\geekdebugprobe-webui\static\a2l-utils` |
| gs_usb 协议 | `D:\Users\Documents\fcm_candlelight_slcan\gs_usb.md` |
| Linux gs_usb.c 驱动 | 对话历史中的完整内核驱动代码 |

---

## 8. 待补充材料

> **请在此追加后续调研材料、从站响应示例、Wireshark 抓包等。**

- [ ] 实际 XCP 从站（如 Vector VX1000 或开源 XCP 从站）的 CAN 抓包数据
- [ ] A2L 示例文件（覆盖常用测量/标定变量）
- [ ] ELF 文件地址填充测试
- [ ] XCP on CAN FD 的实际速率测试
- [ ] 与 CANape/INCA 的互操作测试结果
- [ ] XCP 安全解锁（Seed/Key DLL 接口）方案

---

## 9. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-06-08 | 初始版本：调研报告 + 实现计划框架 |
| | |
