# 统一日志系统 (Unified Logging)

## 概述

MyAgents 使用统一日志系统聚合来自三个来源的日志：
- **React** - 前端 `console.log/error/warn/debug`
- **NODE** - Node.js Sidecar 后端日志
- **Rust** - Tauri 原生层日志

所有日志通过 TabProvider 统一管理，显示在 UnifiedLogsPanel，并持久化到文件。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      TabProvider                             │
│                                                              │
│  React logs ──► CustomEvent ──► appendUnifiedLog ──► UI     │
│                              └─► buffer ──► /api/unified-log│
│                                                              │
│  Node logs ───► SSE chat:log ──► appendUnifiedLog ──► UI    │
│                (server-side persistence via UnifiedLogger)   │
│                                                              │
│  Rust logs ───► Tauri event ──► appendUnifiedLog ──► UI     │
│                (Rust 侧直接写入文件，不经过前端 API)          │
└─────────────────────────────────────────────────────────────┘
```

### 持久化机制

| 来源 | 持久化方式 | 说明 |
|------|-----------|------|
| React | 前端 buffer → `/api/unified-log` | 批量发送，500ms debounce |
| NODE | 服务端 `UnifiedLogger.ts` queue + 100ms flusher | async/bounded writer，队列上限 1000，50MB rotation，overflow 计数告警 |
| Rust | `logger.rs` bounded mpsc + BufWriter | async/bounded writer，200ms flush，overflow 计数告警；Rust 侧仍直接写文件避免循环 |

Rust 日志直接在 Rust 侧写入文件，而不是通过前端 API，这样可以避免日志循环：
```
❌ Rust log → 前端 → POST /api/unified-log → Rust proxy 日志 → 新 Rust log → ...
✅ Rust log → logger.rs bounded writer → 直接写入文件 (无循环)
```

Node/Rust 日志都不是 per-call 同步写入：

- Node `UnifiedLogger.ts`：in-memory queue、100ms flusher、bounded queue、drop counter、50MB per-file rotation、exit drain。
- Rust `logger.rs`：bounded mpsc、single writer task、`BufWriter<File>`、200ms flush、drop counter、pre-init sync fallback。

同一条 Node 日志必须只有一个文件持久化 owner。Sidecar logger 初始化后，`console.*` / `sendLog()` 由 Node `UnifiedLogger.ts` 落盘；Rust 只保留真实的原始 stderr（native/runtime crash 与 logger 初始化前输出），不得让已被 Node 落盘的 `console.warn/error` 再经 stderr 进入 `[bun-err]`。stdout 仅承担初始化握手，Rust 看到 `[Logger] Unified logging initialized` 后停止捕获。Plugin Bridge 不初始化 Node UnifiedLogger，因此它的 stdout/stderr 仍由 Rust Bridge owner 落盘。

Rust unit-test binary 不写用户真实的 `~/.myagents/logs/unified-*.log`；测试日志只进入测试 runner 的标准日志捕获。这样 synthetic failure 不会污染随后用于产品排障的本机日志。

统一日志已有 correlation fields，可直接用于性能 trace 和排障过滤：`sessionId / tabId / ownerId / requestId / turnId / runtime`。

## 日志类型

```typescript
// src/renderer/types/log.ts
// Note: the 'bun' source tag is retained for backward-compat with historical
// log entries and field names; v0.2.0+ all sidecar logs are emitted by Node.js
// and displayed with the [NODE] label via SOURCE_LABELS in UnifiedLogsPanel.
export type LogSource = 'bun' | 'rust' | 'react';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;  // ISO 8601
  meta?: Record<string, unknown>;
  sessionId?: string;
  tabId?: string;
  ownerId?: string;
  requestId?: string;
  turnId?: string;
  runtime?: string;
}
```

## 核心组件

### 1. frontendLogger.ts (React 日志拦截)

拦截前端 `console.*` 方法，将日志分发到 UI 和持久化队列。

```typescript
// 初始化（在 main.tsx 调用一次）
import { initFrontendLogger } from '@/utils/frontendLogger';
initFrontendLogger();

// 之后所有 console.log 自动被拦截
console.log('[MyComponent] something happened');  // 自动分发
```

**关键特性**：
- 批量发送：500ms debounce，50 条强制刷新
- 防递归：过滤 `[FrontendLogger]` 前缀的消息
- Cleanup：`forceFlushLogs()` 在 App unmount 时调用

### 2. UnifiedLogger.ts (服务端持久化)

将日志写入每日文件 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。

```typescript
// 服务端使用
import { appendUnifiedLog, cleanupOldUnifiedLogs } from './UnifiedLogger';

// 启动时清理旧日志
cleanupOldUnifiedLogs();

// 写入日志
appendUnifiedLog({
  source: 'bun',
  level: 'info',
  message: 'Server started',
  timestamp: new Date().toISOString()
});
```

### 3. AgentLogger.ts (Agent 会话日志)

独立的 Agent 会话日志，与统一日志分开存储。

```typescript
// 文件命名：{YYYY-MM-DD}-{sessionId}.log
// 存储位置：~/.myagents/logs/
// 特性：懒加载创建（首次写入时才创建文件）
```

### 4. 异常 crash artifact（不属于 unified log）

`~/.myagents/logs/crash/*.log` 只记录 `uncaughtException`、`unhandledRejection`、异常 stdio 等真正异常事件；正常 STARTUP / EXIT / SIGTERM 只进入 unified log，健康生命周期不会创建 crash 目录或文件。

Node Sidecar 只拥有自己的懒写文件：文件名含 timestamp + PID + nonce，单文件硬上限 50MB，并按创建时间在 30 天边界轮转。共享目录清理归始终存在的 Tauri 应用进程单一持有，在应用启动立即执行并每小时复查，覆盖升级前 backlog 与没有 Global Sidecar 的 idle 场景：

- 最长 30 天；
- 最多 20 个 `.log`；
- 历史单文件超过 50MB 时删除；
- 目录总量最多 200MB，超限时从最旧文件开始删除。

排查磁盘增长时必须分别统计 unified/session log 与 crash artifact；后者的文件数量不再代表 Sidecar 生命周期次数。

### 5. logUtils.ts (共享常量)

```typescript
export const MYAGENTS_DIR = join(homedir(), '.myagents');
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;
```

## API 端点

### POST /api/unified-log

接收前端日志批次并持久化。

```typescript
// Request
{
  entries: LogEntry[]
}

// Response
{ success: true }
```

## 最佳实践

### 1. 使用标准 console 方法

```typescript
// ✅ 直接使用，自动被拦截
console.log('[MyComponent] info');
console.warn('[MyComponent] warning');
console.error('[MyComponent] error');
console.debug('[MyComponent] debug');

// ❌ 不要直接调用 frontendLogger 内部方法
```

### 2. 日志前缀规范

```typescript
// ✅ 使用模块名前缀
console.log('[TabProvider] SSE connected');
console.log('[Chat] Message sent');

// ❌ 无前缀或不一致
console.log('connected');
console.log('Chat - sent');
```

### 3. 避免日志循环

```typescript
// ✅ 在日志相关代码中使用原始 console
import { getOriginalConsole } from '@/utils/frontendLogger';
const originalConsole = getOriginalConsole();
originalConsole.log('[FrontendLogger] internal message');

// ❌ 在日志代码中使用被拦截的 console
console.log('[FrontendLogger] ...');  // 会被过滤掉
```

### 4. Cleanup 时刷新日志

```typescript
// App.tsx
useEffect(() => {
  return () => {
    forceFlushLogs();  // 确保日志不丢失
    void stopAllSidecars();
  };
}, []);
```

### 5. 批量发送日志

```typescript
// ✅ 使用 queueLogsForPersistence 批量入队
import { queueLogsForPersistence } from '@/utils/frontendLogger';
queueLogsForPersistence(entries);  // 自动批量发送

// ❌ 每条日志单独发送 HTTP 请求
for (const entry of entries) {
  await fetch('/api/unified-log', { body: JSON.stringify({ entries: [entry] }) });
}
```

## 文件结构

```
~/.myagents/
└── logs/
    ├── unified-2025-01-25.log      # 统一日志（React/NODE/Rust）
    ├── unified-2025-01-24.log
    ├── 2025-01-25-abc123.log       # Agent 会话日志
    ├── 2025-01-25-def456.log
    └── crash/                       # 仅异常事件；Tauri 应用级 retention owner
        └── 2025-01-25T10-30-45.000Z-12345-a1b2c3d4.log
```

## 日志格式

### 统一日志文件格式

```
2026-03-26 10:30:45.123 [REACT] [INFO ] [TabProvider] SSE connected
2026-03-26 10:30:45.234 [NODE ] [INFO ] Server started on port 31415
2026-03-26 10:30:45.345 [RUST ] [INFO ] Sidecar process spawned
```

> v0.1.x 的 `[BUN  ]` 标签在 v0.2.0+ 渲染为 `[NODE ]`（UnifiedLogsPanel 的 SOURCE_LABELS.bun = 'NODE'）。历史日志文件中的 `[BUN  ]` 字面量保留不变，保证能 grep 到旧日志。

> **注意**：时间戳使用**本地时间** `YYYY-MM-DD HH:MM:SS.mmm`（非 UTC ISO 8601）。

### Agent 会话日志格式

```
2026-03-26 10:30:45.123 {"type":"user","message":{"role":"user","content":"Hello"},...}
2026-03-26 10:30:46.234 {"type":"assistant","message":{"role":"assistant","content":[...]},...}
```

## Boot Banner

应用启动和每个 Sidecar 创建时输出 `[boot]` 单行自检信息：

```
[boot] v=0.3.1 build=release os=macos-aarch64 provider=deepseek mcp=2 agents=3 channels=5 scheduled_tasks=12 proxy=false dir=/Users/xxx/.myagents
[boot] pid=12345 port=31415 node=24.14.0 workspace=/path session=abc-123 resume=true model=deepseek-chat bridge=yes mcp=playwright builtin-mcp-meta=gemini-image,edge-tts
```

**排查第一步**：`grep '[boot]' ./logs/unified-*.log`

### 主窗口启动阶段

白屏排查使用同一组稳定 `[boot] stage=...` 标签：

| 阶段 | Owner | 说明 |
|------|-------|------|
| `native-page-load-started/finished` | Rust `on_page_load` | WebView 导航是否开始/完成 |
| `native-init-script` | Tauri initialization script | HTML 模块执行前的最早 JS 证据 |
| `renderer-entry-evaluated` | renderer | `main.tsx` 已开始执行 |
| `theme-native-bootstrap-*` / `theme-renderer-bootstrap-*` | native bridge / ThemeRuntime | 首帧快照和 renderer prime 是否完成 |
| `react-root-created` / `react-commit` | renderer | React root 创建与真实 effect commit |
| `renderer-uncaught-error` / `renderer-unhandled-rejection` | initialization script | 模块加载或早期 promise 的有界错误 |

所有阶段都带 `window=<label>`，并进入同一个 `~/.myagents/logs/unified-*.log`：Rust page-load 直接走 `ulog_*!`；initialization script 与 `main.tsx` 在 App/Sidecar logger 尚未可用时调用受限 Tauri command `cmd_record_renderer_boot_event`，由 Rust unified logger 持久化。该 command 只接受白名单 stage、有界单行 detail 和合法 window label，不是第二个通用日志 API；禁止绕回 raw `plugin:log|log`，否则阶段链会分裂到 OS LogDir。

`tauri_plugin_log::Builder::default()` 已自带 `Stdout + LogDir`。应用自定义 target 时必须先 `clear_targets()` 再各注册一次；直接在 default builder 上追加同名 target 会让每条原生日志成倍输出。启动观测只能记录证据，不得据此自动 reload、retry 或切换 Theme。

## 日志降噪策略

日志过滤遵循“transport 不记、semantic boundary 只记有界摘要”的 owner 原则：

| 层 | 位置 | 过滤内容 |
|----|------|---------|
| L1 | `sse.ts` `SILENT_EVENTS` + `claude-code.ts` NDJSON reader | 所有 SSE text/thinking/tool/subagent chunk 或 delta，以及 Claude Code raw stream-json（启用 partial messages）；不得按每 N 条采样或聚合后重新落盘，解析后的无正文 semantic summary 可记录 |
| L2 | `http-log-policy.ts` | `/health{,/live,/ready,/functional}`、`/api/unified-log`、`/api/session-state`、`/agent/dir`、`/sessions`、`/api/commands`、`/api/agents/enabled`、`/api/git/branch` 的成功轮询请求行 |
| L3 | `sidecar/stdio.rs` + `sidecar/session_lifecycle.rs` / `sidecar/instances.rs` node-out 去重 | Node.js logger 初始化后停止 stdout 捕获（检测 `[Logger] Unified logging initialized`） |
| L4 | `logger.ts` WARN/ERROR owner | patched `console.warn/error` 只由 Node logger 落盘，不再镜像到 stderr 形成 Rust 第二份副本 |
| L5 | `bridge.rs` + Plugin Bridge compat logger | 过滤 heartbeat，以及插件逐次 `onPartialReply` debug snapshot |
| L6 | `agent-session.ts` SDK message | 摘要替代完整 JSON（`type=assistant model=opus`） |

Builtin / external runtime 在成功持久化边界输出 `[assistant-output]`：组合文本先归一化为单行，仅保留前 100 个 Unicode code point，并记录原始 `chars`。流式 delta 与 raw partial transport 永不进入统一日志；既有低频 SDK result 诊断仍可保留自身的有界字段摘要。Plugin Bridge 的 pending dispatch terminal 只记录 `canonical_final` 的 count/chars/hash，不再复制同一 IM 正文。Codex `thread/start|resume` 的 `developerInstructions` 属于敏感系统提示词，日志只允许 `{present, chars, hash}`，不得记录任何文本前缀；实际 RPC 参数保持原值。

**时间戳格式**：本地时间 `YYYY-MM-DD HH:MM:SS.mmm`（非 UTC ISO 8601）。

## 故障排查

### 日志不显示

1. 检查 `initFrontendLogger()` 是否在 `main.tsx` 中调用
2. 检查 TabProvider 是否正确监听 `REACT_LOG_EVENT`
3. 检查 UnifiedLogsPanel 的 `sseLogs` prop

### 日志不持久化

1. 检查 `serverUrl` 是否已设置（SSE 连接后设置）
2. 检查 `/api/unified-log` 端点是否正常
3. 检查 `~/.myagents/logs/` 目录权限

### Rust 日志不显示

1. 确认在 Tauri 环境中运行（`isTauri()` 返回 true）
2. 检查 Rust 侧是否 emit `log:rust` 事件
3. 检查 TabProvider 中的 Tauri event listener

### 前端整页崩溃（「界面渲染出错」/ 白屏）

`AppErrorBoundary`（`src/renderer/components/AppErrorBoundary.tsx`）挂在 `main.tsx` 的 React 根、**所有 provider 之外，且没有 per-tab / per-message 子边界**——所以任意一个组件 render 抛错就会冒泡到它、把**整个界面**替换成「界面渲染出错」卡片（不是局部某块）。它的 `componentDidCatch` 把 `error` + `componentStack` 经 `console.error('[AppErrorBoundary] ...')` 写进统一日志。

排查：

```bash
grep -E '\[AppErrorBoundary\]|\[REACT\] \[ERROR\]' ~/.myagents/logs/unified-*.log | tail -30
```

- **`error.message`** 保真（运行时字符串，如 `Cannot read properties of undefined (reading 'trim')`）——主要定位线索；配合时间线看崩前发生了什么（常见诱因：**恢复旧 session**、渲染恢复态/流式数据时把可选字段当必有 string）。
- **`componentStack`** 只在 dev / 有 sourcemap 时能定位到组件；release 包被 minify 成 `at t` 这类乱码，别据此硬猜。
- 这类几乎都是真前端 Bug（信任 restored / partial 数据导致 render 抛错），不是用户配置能修的。小助理侧的 triage→报 Bug 流程见 helper `/support` §1.6。

## 相关文件

| 文件 | 说明 |
|------|------|
| `src/renderer/utils/frontendLogger.ts` | React console 拦截 |
| `src/renderer/context/TabProvider.tsx` | 日志状态管理 |
| `src/renderer/components/UnifiedLogsPanel.tsx` | 日志 UI 面板 |
| `src/renderer/types/log.ts` | 日志类型定义 |
| `src/server/logger.ts` | Node.js 日志拦截 |
| `src/server/UnifiedLogger.ts` | 统一日志持久化 |
| `src/server/AgentLogger.ts` | Agent 会话日志 |
| `src/server/logUtils.ts` | 共享常量 |
| `src-tauri/src/logger.rs` | Rust 日志模块 |
