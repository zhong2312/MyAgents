# Multi-Agent Runtime 架构

## 概述

Multi-Agent Runtime 允许用户选择不同的 AI Runtime 驱动 Agent 会话。除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI、OpenAI Codex CLI、Google Gemini CLI 作为外部 Runtime。

**功能门控**：设置 → 关于 → 实验室 → 「更多 Agent Runtime」开关（`config.multiAgentRuntime`），默认关闭。

## 架构总览

```
┌────────────────────────────────────────────────────────────────────┐
│                          Node.js Sidecar                               │
│                                                                    │
│   index.ts/routes ───► session-engine/selector.ts                  │
│                              │                                     │
│          ┌───────────────────┴───────────────────┐                 │
│          ▼                                       ▼                 │
│   builtin-adapter.ts                      external-adapter.ts       │
│          │                                       │                 │
│          ▼                                       ▼                 │
│   agent-session.ts                       external-session.ts        │
│   (builtin facade)                       (external facade)          │
│       │                                       │                     │
│       ▼                                       ▼                     │
│  builtin-session/*                  external-session/* owners       │
│   (SDK owners)                       (CC / Codex / Gemini owners)   │
│       │                    │                                       │
│       ▼                    ▼                                       │
│  Claude Agent SDK   ┌──────────┐  ┌─────────┐  ┌──────────┐       │
│  (内置,直接调用)     │claude-   │  │codex.ts │  │gemini.ts │       │
│                     │code.ts   │  │         │  │          │       │
│                     │NDJSON    │  │JSON-RPC │  │JSON-RPC  │       │
│                     │/stdio    │  │ 2.0     │  │2.0 (ACP) │       │
│                     └────┬─────┘  └────┬────┘  └────┬─────┘       │
│                          │             │            │             │
│                          ▼             ▼            ▼             │
│                     claude CLI     codex CLI    gemini CLI         │
│                     (-p mode)     (app-server)  (--acp mode)       │
└────────────────────────────────────────────────────────────────────┘
```

## 核心抽象

### SessionEngine Facade (`src/server/session-engine/`)

`SessionEngine` 是 Sidecar route 面向“当前会话运行时”的统一门面。Route handler 只负责 HTTP payload shaping、validation 与 response mapping；runtime 选择由 `selector.ts` 通过 `shouldUseExternalRuntime()` 统一完成。

`product-session-binding.ts` 是 facade 内 Product Session identity 的唯一事务入口。当前/切换中的 Session id、待创建 Session，以及 metadata 的冻结和发布都在这里提交；Builtin/External adapter 只执行本 Runtime 的进程清理和绑定操作。SDK UUID、Codex thread id 等 Runtime 原生 identity 不进入该模块，也不能用 builtin `getSessionId()` 为 external 路径兜底。

核心职责：

- `sendDesktopMessage()`：保持 `/chat/send` 的 admission 语义；external runtime 继续立即返回并后台串行 dispatch，避免 Rust proxy 120s 上限。
- `enqueueImMessage()`：保持 IM requestId-aware admission；不等待 assistant turn 完成。
- Inbox 注入若携带 Registered Agent interaction scenario，builtin 与 external adapter 都必须把 exact `spaceId + registeredAgentId` 形成同一 `SessionOrigin.context` 后再 materialize/adopt Session；Runtime 选择不能改变 actor 身份。普通 workspace Session 不允许从本地 registration 数量推断该 context。
- `runInjectedTurn()`：用于 cron sync、heartbeat、memory update、Goal 等同步注入 turn；等待 turn finalization，并用各 runtime 的真成功信号判定结果。Builtin adapter 只保留 domain dispatch guard 与 turn timeout；MCP soft pre-warm 在所有 builtin entrypoint 共用的 generator dispatch seam 执行。
- `stopOwnedTurnByQueueId()`：按 domain owner + `queueId` 精确停止 Task/Goal turn。普通 queued item 被明确移除即可成功；若已进入 promotion，则必须等其结算，`not-dispatched | terminated` 才算成功，`dispatched` 且仍是 current turn 时继续精确 stop，`termination-unconfirmed` 返回失败并保留 exact binding。停止 current external turn 使用 `preserveQueue`，不得清掉后续无关 operation。
- read/config methods：`getRuntimeIdentity()`、`getLiveSessionState()`、`getLatestAssistantResult()`、`getStreamReplaySnapshot()`、`getSessionConfigSnapshot()`、`getLiveSessionOverlay()`、`getSessionCompletionTerminal()` 统一承接 `/api/session-state`、`/api/session-latest-result`、`/chat/stream`、`GET /sessions/:id`、`/api/session/config` 等读取面。
- common operation methods：`rewindToUserMessage()`、`forkAtAssistantMessage()`、`resetForNewDesktopSession()`、`migrateBoundSurfaceSession()` 把真正具有共同产品语义的会话操作留在 adapter 内部处理；unsupported runtime 由 adapter 返回能力错误，而不是 route 层手写分支。IM `/new` 只轮换 Rust Router 的 Agent binding，不属于 Runtime reset。`updateRuntimeConfig`、`prewarm`、startup restore 与 `retryLastExternalUserMessage` 只属于 external runtime，由 selector seam 的显式 helper 校验 runtime 后调用 native owner，不能为 builtin 增加伪对称 stub，也不能让 route/bootstrap 直接 import external facade。打开既有 Session 属于 App 的 Tab 导航，不是 Runtime operation。
- queue/config/permission methods：把 route 层从 `agent-session.ts` / `external-session.ts` 的直接分流中解耦。`/api/mcp/set`、`/api/agents/set`、`/api/interaction-scenario/set` 与 `/api/cc-plugin/session-enable` 都走对应 `SessionEngine` 方法；builtin 委托 SDK config owner，Managed Codex 委托 Product Extension reconciler，其它 external source 返回明确的不适用/不支持状态。`/api/provider/set` 继续由 runtime config owner 处理，route 不静默猜 Runtime。

新增“注入 user 消息 / 同步 config / 等待 idle 后判定 completed”的 endpoint 必须优先接入 `SessionEngine`，不要在 `index.ts` 或新 route module 里重新手写 builtin/external 分支。

Phase5 后的约束：`src/server/index.ts` 与 Phase5 迁出的 route modules（`session-read.ts`、`chat-stream.ts`、`session-config.ts`、`session-operations.ts`）不得直接调用 `shouldUseExternalRuntime()`、`enqueueUserMessage()`、`sendExternalMessage()`、`waitForSessionIdle()`、`waitForExternalSessionIdle()`、`didLastTurnSucceed()`、`getAndClearLastAgentError()`。这些判断只能存在于 `session-engine/selector.ts` 或具体 adapter。

跨 Runtime 的 live/read 契约是行为一致，不是共享 mutable state：`getLiveSessionOverlay()` 返回当前绑定 Session 的 immutable finalized-memory/streaming/state/interactive snapshot 与 `snapshotRevision`；`getSessionCompletionTerminal()` 返回 runtime turn owner 已结算的 immutable identity/owner/origin/status。REST restore、BackgroundCompletion 与通知层只消费这两个 facade 事实，不猜 runtime 类型，也不 import owner internal。

同一原则适用于 Session 绑定渠道投递：这是 runtime-neutral 的行为契约，但 admission、完整 text-block 边界与成功终态 commit 仍由各 Runtime 自己的 turn owner 判定。SessionEngine 的语义入口显式选择 `TurnChannelDelivery`；Builtin 把 assistant owner 与暂存 block 放进既有 per-yield output-owner FIFO，并在 SDK result 边界同步摘下 owner、按原顺序预留 transport，持久化成功后才放行；provider text 自动重试复用原 owner 并清掉被撤回 attempt 的 block。external turn lifecycle 在持久化前 capture 并预留全 Session 顺序、真实成功后 commit、其余路径 discard；两者复用 `utils/im-mirror.ts` transport。Desktop user note 与 assistant response 是两个独立方向；ReplyRouter、Heartbeat/Task caller、Goal outbox 可显式 claim assistant transport，Session Inbox 则只投递 assistant。不得在 route / adapter 层按 Runtime 补发，不得从 `SessionOrigin` / `InteractionScenario` 推断 owner，也不得让 IM-origin requestId 回复再次进入 Session binding 造成双发。

`src/server/session-core/` 承载会话内核的 pure policy：`channel-delivery.ts` 定义 user/assistant transport owner 与 realtime owner 合并规则，`turn-result-policy.ts` 判定 builtin SDK terminal 与 injected turn 是否真成功，`session-activity-policy.ts` 判定 admission/terminal 是否推进 meaningful activity，`heartbeat-ack.ts` 只解析 Heartbeat terminal 的 substantive remainder，`runtime-config-policy.ts` 统一 snapshot/source guard，`turn-queue.ts` 统一 desktop queue admission，`mcp-sync-policy.ts` 统一 MCP authority 与 fingerprint/restart 决策，`mcp-prewarm-policy.ts` 统一 10 秒 absolute grace、status 分类与 soft outcome。它不持有 SDK/CLI 进程、SSE、SessionStore 或文件系统副作用。

`agent-session.ts` 是 builtin SDK 的 public facade，`session-engine/builtin-adapter.ts` 只委托该 facade。Phase6 后，builtin 内部 mutable state 的真实 owner 是 `src/server/builtin-session/`；Phase7 后，turn terminal 与 transcript persistence 的行为 owner 也在同一目录：

| Owner module | 职责 |
|---|---|
| `lifecycle.ts` | SDK `Query` 进程、abort/termination + pre-dispatch rollback barrier、generator wakeup、pre-warm control readiness、Query-scoped MCP pre-warm/mutation owner、exact Query background-task registry |
| `queue.ts` | realtime / mid-turn / turn-boundary queues、in-flight slot、admission ticket |
| `turn.ts` | current turn usage/output/error、activity facts、completion terminal、SDK output-owner FIFO、injected turn outcome |
| `turn-lifecycle.ts` | SDK `result` / stopped / error terminal 解释、usage stamping、message-complete/empty-result、IM/inbox/watch/analytics/title hook 顺序 |
| `config.ts` | MCP/agents/plugins/model/permission/provider state、deferred restart latch |
| `transcript.ts` | live messages、sequence、SessionStore transcript cursor、SDK UUID freshness sets |
| `transcript-persistence.ts` | SessionStore mapping、tail-only persist chain、load/cursor seeding、命名 rewind/retraction/rollback mutation |

Route modules 和 `SessionEngine` adapters 不直接 import `builtin-session/*` 或 `runtimes/external-session/*` 内部模块；新增 route-facing 能力仍先接入 `SessionEngine`，再由 adapter 调用 builtin/external public facade。`runtime-boundary.unit.test.ts` 扫描 route、session-engine、builtin-session 和 external-session 目录，防止 facade 再次直接修改内部状态，或重新实现已经迁出的终态与持久化逻辑。External Runtime 同样采用 facade + owner modules，但没有抽象出 builtin/external 共用的生命周期框架；两边只共享 `session-core/*` 的纯策略。

#### 中性边界类型

跨 Runtime、跨进程或同时被 Renderer/Server 使用的类型放在最窄的中性模块中，而不是借用某个实现模块：

- `ProviderEnv` 由 `src/server/provider-types.ts` 定义，属于 Server provider domain，不依赖 builtin facade。
- queue admission、cancel 和 turn owner 结果由 `src/server/session-core/turn-queue.ts` 定义。Builtin/External 共用同一语义，但各自保留自己的队列状态。
- `ToolInput` 由 `src/shared/types/tool-input.ts` 定义。Renderer 可以通过本地 barrel 做 type-only re-export；Server 不得 import Renderer 类型。

这些文件只拥有数据合同，不拥有 Runtime 状态，也不建立新的共享生命周期。

#### Builtin 公共 MCP soft pre-warm 契约

`initializationResult()` 只证明 Claude subprocess 控制面可用，streamed `system_init` 也只是当前 turn metadata。初始 Query / MCP map 或成功 live mutation 建立 owner-created absolute deadline（默认 10 秒）；owner identity 包含 Query object、generation、单调 installed-map revision 与 runtime fingerprint。`messageGenerator()` 在 promotion 后先等待真实 live mutation fence，再对 Desktop、IM、Cron、Goal、Heartbeat、Memory Update 等所有 queue item 消费同一 generation 的剩余 grace。

只有 `pending` 会继续 polling；`failed`、`needs-auth`、`disabled`、missing、status read error 或 deadline 到期均 settle 为 degraded，基础 AI turn 继续。ready / degraded 在 owner 上只结算一次，后续 turn 不再读 status。用户取消仍取消 exact promotion；owner replacement 不属于 MCP degraded，旧 generator 必须 requeue 并退出。`runInjectedTurn()` 不再创建 MCP pre-persistence guard、promotion 二次 fence或 MCP 408/503；Goal/Task domain guard 的 claim / rollback / active-turn handoff 顺序保持原契约。

Live `setMcpServers()` 仍由 Query-generation mutation owner 单飞；promoted item、active turn 和 SDK command in-flight 都是 quiescence blocker。mutation claim 与 promotion 同步互斥：先 promotion 就锁存 restart，先 claim 就由 promotion 等待 mutation promise。真实 mutation 失败或 30 秒 timeout 仍意味着 transport map 不确定，旧 generator requeue 后隔离到 exact Query abort/replacement并退出；这条硬 fence 不与 startup soft grace 合并。`mcpServerStatus()` 只在当前 generation 首次 observation 内单飞，status timeout settle degraded，不再触发按 injected request 重建。External adapters 继续保持 runtime-native MCP ownership；仅 Managed Codex 的 MyAgents-injected config采用下述同一 policy。

### AgentRuntime 接口 (`src/server/runtimes/types.ts`)

所有外部 Runtime 实现此接口：

```typescript
interface AgentRuntime {
  type: RuntimeType;  // 'claude-code' | 'codex' | 'gemini'
  detect(): Promise<RuntimeDetection>;       // 检测 CLI 是否安装
  queryModels(): Promise<RuntimeModelInfo[]>; // 查询可用模型
  getPermissionModes(): RuntimePermissionMode[];
  startSession(options, onEvent): Promise<RuntimeProcess>;
  sendMessage(process, message, images?): Promise<void>;
  respondPermission(process, requestId, approved, reason?): Promise<void>;
  stopSession(process): Promise<void>;
}
```

### UnifiedEvent 统一事件

Runtime 内部协议差异通过 `UnifiedEvent` 联合类型统一，`external-session.ts` 消费同一套事件：

| 类别 | 事件 | 说明 |
|------|------|------|
| 文本 | `text_delta`, `text_stop` | AI 回复流式文本 |
| 思考 | `thinking_start/delta/stop` | 推理过程 |
| 工具 | `tool_use_start`, `tool_input_delta`, `tool_use_stop`, `tool_result` | 工具调用全生命周期 |
| 权限 | `permission_request` | 委托 MyAgents UI 审批 |
| 生命周期 | `session_init`, `turn_complete`, `session_complete` | 会话状态 |
| 元数据 | `usage`, `log` | Token 用量、日志 |
| 工具目录 | `runtime_tool_catalog` | 外部 Runtime 实际发现且可用的 MCP 工具快照；独立于一次性的 `session_init` |
| 诊断 | `runtime_diagnostics` | Runtime 自检快照（Codex 启动后 fire-and-forget 收集，详见「Runtime 诊断 + envPolicy」） |
| 状态面板 | `agent_plan_update` | Runtime 原生计划 / todo 快照（Codex `turn/plan/updated`），由 `external-session.ts` 转为 `chat:agent-plan-update`，前端仅作为 transient AgentStatusPanel 状态，不写入 transcript |

### RuntimeType (`src/shared/types/runtime.ts`)

```typescript
type RuntimeType = 'builtin' | 'claude-code' | 'codex' | 'gemini';
```

### Runtime Source

外部 runtime 还带有 `RuntimeConfig.source` / `MYAGENTS_RUNTIME_SOURCE`，用于区分同一个 runtime 协议由谁管理：

| Source | 含义 | 典型入口 |
|---|---|---|
| `system-cli` | 用户自行安装并登录的本机 CLI | 实验室「更多 Agent Runtime」里选择 Codex / Claude Code / Gemini |
| `managed-provider` | MyAgents 管理 runtime 二进制、安装状态与登录状态 | Provider 列表里的 `codex-sub`（Codex 订阅） |

`managed-provider` 不受 `config.multiAgentRuntime` 门控；它由自己的 Provider readiness gate 控制：provider gate 开启、managed runtime 已安装到要求版本、managed Codex auth 有效（`chatgpt` 或兼容的 `access-token`），且 provider 未被禁用。Rust `runtime_identity.rs` 在新 Session、IM 或 Task Sidecar 出生时，仅将 Agent 当前的 `runtime:'builtin' + providerId:'codex-sub'`（以及可读兼容的旧 `runtime:'codex' + source:'managed-provider'`）投影成 `runtime='codex'`、`source='managed-provider'`；显式 system Codex / Claude Code / Gemini Runtime 胜过遗留的 `codex-sub` 字段。

每次 Rust Sidecar ensure attempt 只解析一次 owner-aware `RuntimeIdentity(runtime + runtimeSource)`；同一次 attempt 的既有进程复用校验与新进程 spawn 必须消费这个同一快照，不能在两者之间重读 Session/Agent 配置。Task 首次 materialize metadata 时，Node 以 live `SessionEngine.getRuntimeIdentity()` 和同一时刻的 live config snapshot 绑定实际进程身份，避免 Rust payload 与 Node 进程发生 TOCTOU 漂移。

持久化边界：

- Chat session birth 保存 `runtimeSource:'managed-provider'` 与 `providerExecutionIdentity`；Task/Cron 执行 override 保存 `runtimeConfig.source:'managed-provider'` 与 model。两类 payload shape 不同，但都用于重建执行 runtime。
- IM / Agent Channel 是 live-follow owner：session birth 只保存 runtime identity（`runtime` + `runtimeSource`），model / provider / permission / MCP 每条消息从当前 Agent 配置重新 resolve。漂移判定必须比较完整 identity，`codex/system-cli` 与 `codex/managed-provider` 不可互相复用。
- Agent/Channel 默认配置只保存 `providerId:'codex-sub'` 与 model；不得把 managed runtime projection 写入默认 `runtimeConfig`，否则会和用户手动安装的 Codex CLI runtime 混淆。

所有 helper 边界都必须保留 source：`snapshotForImSession` / `snapshotForOwnedSession` 的 override 形态是 `runtimeOverride` + `runtimeSourceOverride`，Rust IM router / heartbeat / `/model` wake path 则从 `RuntimeConfig.source` 传入 drift check。只传 `runtime:'codex'` 等价于 system CLI，不代表 Codex 订阅 Provider。

Analytics 同样使用完整 runtime identity：`session_new` / `history_open` /
`message_send` / `message_complete` / `ai_turn_complete` 都上报
`runtime_source`。统计 Managed Codex 使用量时按
`runtime='codex' AND runtime_source='managed-provider'` 查询；用户自行安装
Codex CLI 则是 `runtime='codex' AND runtime_source='system-cli'`。

## Claude Code Runtime (`src/server/runtimes/claude-code.ts`)

### 协议：NDJSON over stdio

CC 以 `-p` (prompt) 模式运行，每轮对话一次进程生命周期：

```bash
claude -p \
  --output-format stream-json --input-format stream-json \
  --verbose --include-partial-messages --bare \
  --append-system-prompt "..." \
  --permission-mode acceptEdits \
  --permission-prompt-tool stdio \
  --model sonnet \
  --resume <runtimeSessionId>
```

**stdin (发送消息)**：
```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

**stdout (接收事件)**：NDJSON 行流，包含 `stream_event`（文本/工具 delta）、`system`（session_init）、`result`（turn 结果）、`control_request`（权限请求）。

**日志 owner**：raw NDJSON 是 transport，且 `--include-partial-messages` 会让其中包含 text/thinking/tool delta，因此不得记录首 N 行、每 N 行采样或正文 preview。`readEvents()` 必须先 `parseLine()`，只对归一化后的非 delta `UnifiedEvent` 输出无正文 semantic summary；delta 继续原样交给 external-session 组合，成功持久化后由 terminal owner 输出一次有界 `[assistant-output]`。

### 多轮续接

CC `-p` 模式每轮退出。续接通过 `--resume <sessionId>` 恢复上下文：

```
Turn 1: claude -p --session-id abc → 执行 → 退出
Turn 2: claude -p --resume abc     → 恢复上下文 → 执行 → 退出
```

### 权限模式

System Claude Code 配置直接使用当前 CLI 的 native vocabulary：
`manual | auto | acceptEdits | dontAsk | plan | bypassPermissions`。未指定时使用
`manual`。旧的产品级调用仍可在执行边界将 `fullAgency` 投影为
`bypassPermissions`；`plan` 同名传递。

**IM native-card 例外**：当 `InteractionScenario` 是 IM / Agent Channel 且 `hostInteraction.askUserQuestion === 'native-card'` 时，`fullAgency` 不能直接传给 Claude Code 的 `bypassPermissions`。`AskUserQuestion` 通过 CC `control_request/can_use_tool` + `--permission-prompt-tool stdio` 回到 MyAgents；bypass 会跳过这条交互通道。`external-session.ts` 在 runtime 边界把启动态权限降为 `acceptEdits`，同时对非 `AskUserQuestion` 的 permission request 做 fullAgency fast-path 自动允许，保持“普通工具自治、结构化提问可交互”的语义。

### SessionStart Hook

生成临时 hook 配置文件，注入 forwarder 脚本。CC 启动后通过 hook POST `session_id` 到 Sidecar HTTP 端点 `/hook/session-start`，确保 session ID 可靠追踪。

## Codex Runtime (`src/server/runtimes/codex.ts`)

### 协议：JSON-RPC 2.0 over stdio

Codex 以 `app-server` 模式运行，进程在整个 session 生命周期内持久存活：

```
Client → Server (Request):   {"jsonrpc":"2.0","id":1,"method":"thread/start","params":{...}}
Server → Client (Response):  {"jsonrpc":"2.0","id":1,"result":{...}}
Server → Client (Notification): {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{...}}
```

### Thread 模型

| RPC 方法 | 用途 |
|---------|------|
| `initialize` | 握手，交换 capability |
| `thread/start` | 创建新 thread |
| `thread/resume` | 恢复已有 thread |
| `thread/read` | 读取完整、有序的 native turns；仅 Rewind 的 before-turn 边界使用 |
| `thread/fork` | 通过 `lastTurnId` 创建独立 native branch |
| `thread/unsubscribe` | 解除 source app-server 对刚创建 branch 的临时订阅 |
| `turn/start` | 发送用户消息到 thread |
| `turn/steer` | 追加用户输入到当前 in-flight turn（Codex 实时响应路径） |
| `turn/interrupt` | 中断当前 turn |

### 对话 Rewind / Fork（0.4.5）

Codex 的稳定 v2 协议可以精确适配产品级时间回溯与分支；System CLI 仅在官方稳定版本 `>= 0.143.0` 开启，Managed Codex 由锁定版本保证。Claude Code / Gemini 不共享这项 capability。

- 每次 root `turn/start` 都传入 MyAgents user message id 作为 `clientUserMessageId`。响应的 native turn id 与该 product id 在本次 admission 内核对；只有成功 terminal assistant 持久化 `runtimeTurnAnchor:{turnId,rootUserMessageId}`。通知和 RPC response 可任意先后，terminal 必须等 admission id 确认后再落盘。
- External transcript persistence 同时创建 assistant 的 canonical product message id；成功落盘后的 `chat:message-complete` 必须回传同一个 `assistant_message_id`，让普通 live stream 与 reconnect live snapshot 在暴露 transcript action 前归一到 SessionStore identity。Renderer 的 provisional streaming id 只属于展示生命周期，不能用于 Rewind/Fork 等持久化操作寻址。
- Fork assistant 使用 `thread/fork({threadId,lastTurnId:anchor.turnId})`。Rewind user 先用 `thread/read({threadId,includeTurns:true})` 精确找到对应 turn：有前一 turn 时 fork through previous；目标是第一 turn 时返回 `fresh-thread`，不预建不可跨进程恢复的空 thread。
- `thread/fork` 会让当前 app-server 临时订阅新 thread，因此交回 product 层前必须 `thread/unsubscribe`。失败则停止 connection；无法确认终止时不提交产品状态。
- native branch 成功后，产品 transcript 仍以 SessionStore 为 authority，不从 Codex rollout 反向重建富消息。Rewind 只截断对话且保留同一个 product Session id；Fork 复制截止目标 assistant 的 transcript prefix 到新的 product Session。若来源是尚未带 `configSnapshotAt` 的 legacy Session，新分支在创建时以来源当下有效的 Agent/runtime 配置冻结 owned snapshot，来源 Session 本身保持不变。
- 一个 Session Sidecar 操作结束时仍只持有一个 root thread。Rewind 提交后停止旧 process 并按 replacement binding restore；有 native replacement 时在 mutation lease 释放后异步复用 `prewarmExternalSession()` resume，新进程启动失败不回滚 durable Rewind，下一条消息仍走既有 resume。首 turn rewind 清除 binding且不预热不可恢复的空 thread，让下一条消息走既有 fresh-start。旧 process 无法确认停止时重启该 1:1 Sidecar，不能继续向 source thread 发送。

不得使用 experimental `thread/rollback`、本地 previous-turn mirror、`beforeTurnId` 猜测或 Renderer 直连 app-server。`CodexRuntime` 是 native RPC/subscription owner，`external-session` 是操作编排 owner，SessionStore 是 transcript/metadata owner。

### `thread/start` 参数 Schema（Codex v0.111.0）

| 参数 | 类型 | MyAgents 对接 | 说明 |
|------|------|-------------|------|
| `cwd` | string? | ✅ `workspacePath` | 工作目录 |
| `model` | string? | ✅ 用户选择的模型 | 模型覆盖（null=Codex 默认） |
| `approvalPolicy` | enum? | ✅ mapped from permissionMode | `untrusted`/`on-failure`/`on-request`/`never` |
| `sandbox` | enum? | ✅ mapped from permissionMode | `read-only`/`workspace-write`/`danger-full-access` |
| `developerInstructions` | string? | ✅ `systemPromptAppend` | MyAgents 三层系统提示词 |
| `ephemeral` | boolean? | ✅ 默认 `false`；Managed Codex 标题任务为 `true` | 是否临时线程 |
| `modelProvider` | string? | ✅ Managed Codex | 新 thread 固定为 MyAgents 持有的 HTTP-only 官方 OpenAI provider；system-cli 不覆盖 |
| `serviceTier` | enum? | ❌ 未对接 | `fast`/`flex` |
| `personality` | enum? | ❌ 未对接 | `none`/`friendly`/`pragmatic` |
| `baseInstructions` | string? | ❌ 未对接 | 基础系统指令（区别于 developerInstructions） |
| `config` | object? | ❌ 未对接 | 通用配置对象（additionalProperties） |
| `serviceName` | string? | ❌ 未对接 | 服务名称标识 |
| `experimentalRawEvents` | boolean | ✅ 仅 Managed Codex 新 thread | 开启官方 raw 通知：`rawResponseItem/completed` 仅恢复 v2 `interacted` 丢失的 `send_message` / `followup_task` 语义；Codex 0.146+ 的 `rawResponse/completed` 仅投影为 turn 级精确 usage。raw payload 本身不进入 UnifiedEvent / SSE / 持久化 |

### `thread/resume` 参数 Schema

| 参数 | 类型 | MyAgents 对接 | 说明 |
|------|------|-------------|------|
| `threadId` | **string (必填)** | ✅ `resumeSessionId` | 要恢复的线程 ID |
| `model` | string? | ✅ | 模型覆盖 |
| `approvalPolicy` | enum? | ✅ | 权限策略覆盖 |
| `sandbox` | enum? | ✅ | 沙箱覆盖 |
| `developerInstructions` | string? | ✅ | 系统提示词覆盖 |
| `cwd` | string? | ✅ `workspacePath` | 工作目录覆盖 |
| `modelProvider` | string? | ✅ Managed Codex（有权威 model snapshot 时） | 与 model 成对覆盖；model 未知的 legacy resume 留给 Codex 恢复持久化 pair |
| `serviceTier` | enum? | ❌ 未对接 | |
| `personality` | enum? | ❌ 未对接 | |
| `baseInstructions` | string? | ❌ 未对接 | |

**Codex RPC / External terminal 日志边界**：`developerInstructions` 是完整系统提示词，`thread/start` / `thread/resume` 调试日志不得输出正文或前缀，只记录 `{present, chars, hash}`；Codex command、path、stderr 与 provider error 的 notification/log 投影遵守同一规则。`external-session.ts` 写 non-success terminal 的 `console` 与 perf trace 时也只记录不可逆摘要，但传给 Chat/IM/turn outcome 的原始 terminal error 保持不变。短 SHA-256 仅用于判断两次诊断是否对应同一值；脱敏只作用于日志副本，发给 Codex app-server 的 RPC params 和用户错误事件必须保留原始值。

**MCP owner 边界**：Codex 的 `thread/start` / `thread/resume` schema 不接受 MCP 配置，但这不等于所有 Codex 会话都只能读取 `~/.codex/`。`runtimeSource:'managed-provider'` 由 MyAgents 持有 app-server 进程，因此在 spawn 时用 `-c mcp_servers.<name>.*=...` 注入当前 workspace 的有效 MCP；`runtimeSource:'system-cli'` 仍由用户自己的 Codex 配置持有 MCP，MyAgents 不覆盖。Managed 注入前必须复用 `utils/mcp-command.ts` 解析绝对 npx 路径、`-y` 与 MyAgents preset 的精确版本，不能和 builtin SDK 路径各自解释同一份 MCP definition。

**Managed transport owner 边界**：Managed Codex 的 app-server launch config 注册 MyAgents 私有 provider id；该 provider 保持 `name:'OpenAI'`、`wire_api:'responses'` 与 `requires_openai_auth:true`，不设置 `base_url` / `env_key`，因此 Codex 仍按现有 ChatGPT 登录态解析官方 Codex endpoint、订阅模型与 entitlement。唯一 transport 差异是 `supports_websockets:false`，让 Responses 从首包开始直接走 HTTPS，不再先做五轮 WebSocket reconnect。新 thread 显式传同一 `modelProvider`；resume 只有在 Session metadata 提供权威 model 时才把 model/provider 成对覆盖，model 未知的 legacy thread 则两者都交给 Codex 持久化 metadata 恢复。Pre-warm 同理优先使用 Session metadata 的 model，而不是 renderer 可能尚未同步完成的 payload。`runtimeSource:'system-cli'` 完全不注入或覆盖 provider。

**标题 utility turn**：自动标题必须从 Session metadata 保留完整 Runtime identity，不能只传 `runtime:'codex'` 后让 `startSession()` 回落到 `system-cli`。Runtime 启动边界用原子的 `initialTurn { message, clientUserMessageId, images? }` 表达首轮输入：普通产品 Session 使用已持久化 `SessionMessage.id`，标题 utility 自己生成一次性 UUID，禁止传入没有 caller identity 的游离首轮消息。Managed Codex 标题使用同一 managed binary / `CODEX_HOME` / auth owner，但显式传空 `mcpServers`，不注入 workspace MCP；同时固定 `suggest`、低 reasoning effort、`maxTurns:1` 和 ephemeral thread。普通 Session 的 MCP 与权限配置不受影响，system-cli Codex 继续由用户自己的原生配置持有。

**Codex usage owner**：`thread/tokenUsage/updated` 始终保留：其 `last.inputTokens` 是实时 context 占用，`total` 是旧 runtime / 缺失 raw usage 时的 turn 累计 fallback。Codex 0.146+ 在开启 raw events 后还会为每个上游 Responses API completion 发 `rawResponse/completed {threadId, turnId, responseId, usage}`；adapter 在 root turn 内按 `responseId` 去重，累加 provider 回传的 input/output/cached/cache-write，最后在 root terminal 之前只发一个 `semantics:'delta'` usage，交给 `external-session` 既有的 SessionStore / analytics owner。任一 response 的 `usage:null` 或必需 token 字段非法会使整轮 raw 聚合失效并回退 `thread/tokenUsage/updated`，禁止把部分和伪装成精确统计。child thread 的 raw/thread usage 都经过 `isChildThreadGatedMethod()` 丢弃，不污染主 Session；raw payload 与 response id 不跨 adapter 边界。

**Codex 0.144.1 models refresh 历史已知问题**：`codex_models_manager ... timeout waiting for child process to exit` 不是 MyAgents 子进程退出超时。Codex 的 models endpoint 把 transport build + `/models` 请求包在固定 5 秒 timeout 中，而通用 `CodexErr::Timeout` 沿用了 command 场景的错误文案。每个 app-server 的周期 refresh worker 启动即请求、完成后等待 180 秒，因此这一路连续失败时约每 185 秒出现一次；response 携带的新 ETag 还会即时触发 refresh，所以 turn / transport retry 附近也可能出现多条 5 秒 timeout 成簇爆发，不能用 185 秒间隔反推是否为同一问题。MyAgents 不用静态 `model_catalog_json`、cache touch、日志过滤或绕开 provider proxy 来掩盖它：这些方案会分别冻结 entitlement、伪造 freshness、隐藏真实失败或破坏用户代理策略。HTTP-only provider 会移除 WebSocket 失败，并避免重复 WebSocket attempt 带来的 ETag refresh 放大；慢代理下的周期 refresh 与正常 response ETag refresh 仍需等待 Codex 上游提供独立 timeout / 修正文案。

### 项目级 Skill / Command 选择（0.4.7）

`AgentConfig.capabilitySelection` 是唯一持久化 authority；写开关时，当前 workspace 必须经唯一 `Project.agentId` 精确找到唯一 Agent。Runtime 读取不借用这条写入约束：owner 暂缺、重复或 selection 无法读取时采用无 disabled override 的默认集合，不能在消息入队前阻断 Session。`src/server/project-capabilities.ts` 统一扫描项目与 `~/.myagents` 候选，按 canonical name 执行 project > global winner，最后应用 disabled override。Required System Skill 是 canonical name 的启用策略，不是项目来源或目录名的真实性边界：真实项目 Skill 与 Required 同名时仍走同一 winner 规则，winner 强制启用；Skill 的同名、目录名差异或局部解析问题只淘汰对应候选，不得提升为整个 workspace / Session 不可用。设置页展示全部 winner；Chat Sidebar 与输入框只消费同一 Sidecar snapshot 的 enabled 集合。Rust slash scanner只保留无 Sidecar 的 Launcher 兼容读取，不解释项目 selection，也不在读取时改动 projection。

Command 必须区分三类身份：`scope + sourceLocalId` 是选择与持久化身份，frontmatter `name` / 首个 H1 只是展示名，斜杠调用名则由 source root 下的词法文件路径稳定派生（去掉 `.md`，嵌套目录 `/` 映射为 `:`）。调用名允许 Unicode 字母、数字以及 `:` / `_` / `-`，不允许空白或其它标点；因此修改标题或展示名不能暗中改写 Runtime 调用协议。`/api/project-capabilities` 同时返回展示 `name` 与 `invocationName`，输入框和侧栏点击必须插入后者；Managed Codex compiler 与 Launcher 兼容扫描遵守同一规则。任何项目级或全局 Skill / Command 成功写入后都触发统一的 capability invalidation，使已挂载 Chat 重新读取权威 snapshot；不得为某个 Runtime 增加独立扫描、轮询或伪造 SDK 动态事件。

`.claude` symlink 只是跨 Runtime 共用的兼容投影，不是项目选择的执行 authority。MyAgents 只维护指向 `~/.myagents` 的全局安装链接；项目自己的目录或目录 symlink 都是普通 Project Skill。Builtin 在每个 Query birth 将 enabled Skill canonical name 写入 SDK `Options.skills`，并在消息跨 SDK 边界前拒绝 disabled custom Command；revision 变化复用既有 deferred Query replacement，当前 turn 不变。Managed Codex 在每次 turn admission 编译同一 snapshot，在 merge 前过滤 project/global Skill 与 Command，并把 capability revision 纳入 desired/effective revision。System Codex、Claude Code、Gemini 在投影成功时看到相同的 project > global winner；它们的 process lifecycle 记录启动时采用的 effective capability revision，下一次 admission 发现 winner revision 变化就走既有 idle-boundary replacement，不能依赖“当前 Sidecar 是否碰巧执行了链接变更”。Plugin selection 不消费项目 override。

#### 输入框斜杠菜单能力投影

斜杠菜单必须按 Session 的真实 Runtime 能力投影，不能按视觉 chrome 推断。`/goal` 是 MyAgents 自己的 runtime-neutral 客户端动作，所有 Runtime 都保留；工作区 Skill / Command 继续消费各自既有的能力快照。静态 `compact/context/cost/init/pr-comments/release-notes/review/security-review` 列表属于 Claude Agent SDK，只在 `runtime:'builtin'` 的 Session 展示。Managed Codex 即使为了产品一致性使用 builtin 输入 chrome，也不继承这份列表，而是仅额外投影已适配的原生 `/compact`；其他 external Runtime 隐藏全部 Claude SDK 系统指令。

工具菜单区分配置 authority 与 Runtime 状态：MyAgents 托管的 builtin / Managed Codex Session 都以 Product Session 的 workspace 配置提供候选项与开关；`runtime_tool_catalog` 只描述实际 Runtime 已加载的工具，不得在 Runtime 尚未启动或目录尚未上报时反向清空配置 UI。用户自行管理的 system-cli Runtime 不由 MyAgents 写入 MCP 配置，继续以 Runtime 目录只读展示。

锁定的 Codex app-server `0.146.0` 中，`thread/compact/start` 与 `review/start` 分别提供原生压缩和审查 RPC，但两者都会创建 Codex 控制回合。当前仅 `compact` 已接入：Renderer 的 `/compact` 与上下文卡片按钮共用 `/api/session/compact`，route 只调用 SessionEngine facade；external Session owner 负责 idle admission、mutation lease、`chat:status`/`chat:system-status` 与排队消息恢复，Codex adapter 负责 RPC、control turn terminal 及隔离其 item/turn 事件，禁止把压缩写成用户/助手 transcript。RPC/timeout 等不确定失败会重启 runtime 进程边界，明确失败 terminal 则保留进程。`review` 尚未建立对应产品语义，继续隐藏；`context` 已由实时上下文指标承担只读展示但没有等价管理 RPC，`cost` 只有 token usage、没有费用语义，其余 Claude 系统指令没有可忠实映射的 Codex RPC。

Required System Skill 名单仍由 `src/shared/systemSkills.ts` 唯一决定；全局安装完整性只产生候选级诊断，项目 effective snapshot 的 `required` 由 winner 的 canonical name 决定。项目同名目录或目录 symlink 都保留 project provenance、服从既有 project > global 优先级并强制启用；目录名不参与真实性判断，也不得让单个 Skill 候选阻断 Session。投影 helper 只替换可证明指向 `~/.myagents` 的 managed symlink，项目文件与项目 symlink 保持原样；若 Project Skill 以任意目录名声明了相同 canonical name，同步入口移除对应 global link，使共享磁盘视图与 project winner 一致。单个候选或 link 无法读取/刷新时只记录日志，Session 继续启动；Builtin 与 Managed Codex 都从本次 admission 排除受影响 canonical。system-cli 兼容 Runtime 直接扫描共享磁盘，若 OS 拒绝清理既有链接，只能记录该物理歧义并继续，不能为了强行一致而阻断 Session 或新增第二套投影协议。依赖 Required Skill 的任务只检查当前受控 Runtime 是否实际加载该 canonical name，不要求 winner 来自官方全局目录；Managed Codex 以启动后的 `skills/list` read-back 为准，缺失时只拒绝该依赖任务，普通对话和 Session 仍可用。

### Skills 加载

Codex 原生扫描 `.agents/skills`，而 MyAgents/Claude Agent SDK 的工作区协议使用 `.claude/skills`。为保持产品层一致性，Codex adapter 在 `startSession()` 中做两步桥接：

1. 调 `syncProjectUserConfigFiles(workspacePath)`，把 `~/.myagents/skills` 中启用的用户级 skills 同步为工作区 `.claude/skills/*` symlink（与 builtin Claude SDK 共用同一套磁盘桥接逻辑，不另建 Codex 专用目录）。
2. `initialize` 握手完成后调 Codex app-server RPC `skills/extraRoots/set`，把 `<workspace>/.claude/skills` 作为额外 skill root 注入当前 Codex 进程。

`runtimeSource:'system-cli'` 与 `runtimeSource:'managed-provider'` 都把 Skill 注入当成可选能力：同步、临时目录 materialization、`skills/extraRoots/set`、`skills/list` 或单个 Skill 解析失败只记录 warning，Codex Session 继续启动；Managed 仍走下节的精确 Product Extension projection，但不会把某个 Skill 的异常提升成 Runtime 失败。临时目录使用短序号作为文件系统名称，单个 Skill / Agent 链接或配置写入失败只跳过该候选。`skills/extraRoots/set` 与首次 `skills/list(forceReload:true)` 的 deadline 都是 30 秒；read-back 按 Skill 名称和 canonical source path 验收，其他 root 的同名 Skill 不算该候选成功。统一日志记录两个阶段的耗时、root/expected/visible/error 计数，并以 workspace/extra-root 相对路径及不可逆 message 摘要记录 Codex 返回的 `errors[]`，不持久化 parser 自由文本。parser warning 与缺失候选只进入日志，不出现在 Chat error banner。

### Managed Codex Product Extensions（0.4.6）

这套投影仅适用于 `runtime:'codex' + runtimeSource:'managed-provider'`。MyAgents 仍是 Product Session、配置、Plugin Store、权限与 transcript 的 authority；Codex app-server 只是 Runtime kernel，`system-cli` Codex 继续使用用户自己的配置，不接管其扩展体系。

`SessionEngine` 的 MCP、Agent、interaction scenario 与 enabled-plugin 配置入口统一触发 `external-session/extensions.ts`。Renderer 对 MCP 只提交 ID 选择意图，Sidecar 必须从 `resolveWorkspaceConfig()` 重新取得 executable definition；不得信任 Renderer 传来的 command/env/url。owner 从当前权威来源编译 immutable snapshot，以 `desiredRevision/effectiveRevision` 协调本次进程 generation：无进程为 `pending_next_start`，running turn 为 `deferred_until_idle`，idle 可安全 replacement；连续更新合并到最终 revision，旧 generation 的迟到事件不能回写新状态。新进程启动且 MCP startup barrier 完成 terminal/timeout 观察后更新 effective；单个 Skill/MCP/Agent/Plugin 的失败只进入对应组件结果与 Logs，不能否定整个 Runtime generation。`RuntimeDiagnostics.extensions` 同时携带顶层应用状态与逐组件结果，禁止 external-runtime 伪成功；`pending_next_start` 是下次 send/pre-warm 会自然消费的正常状态，不额外提示，`deferred_until_idle` 只在用户操作入口显示一次等待提示。Chat banner 只展示 Runtime 本身无法启动等顶层失败；逐组件 `failed` / `unsupported` 是可选能力降级，进入结构化诊断与 Logs panel。生产方的 `requiresUserAction` 仅供用户主动修改扩展配置后的单次 toast 使用，不能作为被动 Chat banner 的 severity。

| MyAgents 组件 | Managed Codex 投影 | 关键边界 |
|---|---|---|
| Workspace/全局/Plugin Skills | 临时精确目录 → `skills/extraRoots/set` + read-back | project > user > plugin；只投影合并后 enabled 的 canonical、非 symlink、限深限大 `SKILL.md`；正文 digest 进入 revision |
| Commands | Sidecar admission-time 展开为 runtime prompt | transcript 保留用户原始 `/command args`；`$ARGUMENTS` 只作用于发给 Runtime 的文本 |
| Agents | 启动时生成临时 native `agents.<role>.config_file` | prompt/model/Skill 可忠实映射；tools/disallowedTools/maxTurns 等字段逐 Agent unsupported，不用 prompt 伪装约束 |
| 外部 MCP | Managed app-server 启动配置 | stdio/streamable HTTP 由服务端权威 MCP definition 逐 server 原子投影；URL/header 的 `{{ENV_NAME}}` 先经共享 MCP 模板解析，再交给 Settings 探活、Builtin SDK 或 Managed Codex 各自的 transport projector。无法安全表达、transport 不支持或 env key 值冲突时只排除该 server，并以 `extensions.components` 的 `failed` / `unsupported` 进入 Logs panel，其他 MCP 与基础 Session 继续；顶层 generation 仍为 `applied`，因此不出现 blocking Chat banner。secret 值只进入进程 apply fingerprint，不进入 revision/diagnostics，也绝不进入 argv |
| SDK in-process MCP / IM Bridge | `thread/start.dynamicTools` +反向 `item/tool/call` | Dispatcher 复用标准 MCP handler、现有权限 owner、AbortSignal、timeout、附件与 large-value spill；exactly-once 且绑定 process generation |
| Plugin | 按 `plugin.json` 的 `skills`/`commands`/`agents`/`mcpServers` 路径与默认目录编译 | 命名组件使用 project > user > plugin；MCP 按 server id 独立合并并显式报告冲突。Hooks/LSP/monitors/bin 和不可表示 transport 逐组件 unsupported，不阻断其它可转换组件 |

协议契约锁定在 app-server `0.146.0`，升级下载锁不能自动放开扩展路径，必须先重新生成 schema 并跑 exact-binary conformance。`thread/start.dynamicTools` 的目录属于 native thread birth：resume 没有替换目录的协议字段。Session metadata 因此只保存 protocol version 与 secret-free catalog fingerprint；相同目录可原生 resume，目录改变或 legacy Session 无法证明一致时返回 `host_tools_catalog_immutable`，要求新建 Product Session。该降级不阻断基础对话：被动恢复时进入结构化诊断与 Logs panel；用户主动配置扩展时可用一次 warning toast 说明新建 Product Session 才能应用。唯一兼容例外是历史 metadata 与当前 desired catalog 都为空，此时没有可漂移的 Host 能力，可继续 resume。不得以 MCP fallback、额外 Extension Host 或第二套 Agent loop 绕过这个限制。

### 事件映射

| Codex Notification | UnifiedEvent |
|-------------------|-------------|
| `item/agentMessage/delta` | `text_delta` |
| `item/reasoning/summaryTextDelta` | `thinking_delta` |
| `item/plan/delta` | `thinking_delta`（v0.2.15+ 真显示，之前 `plan` item silent drop） |
| `item/started` (tool types) | `tool_use_start` |
| `item/completed` (tool types) | `[tool_use_stop, tool_result]` |
| `item/completed` (`subAgentActivity`) | `CollabAgent` 容器/控制 trace + thread 关联（Codex multi-agent v2） |
| `turn/started` | `[status_change(running), agent_plan_update([])]` |
| `turn/plan/updated` | `agent_plan_update` |
| `turn/completed` | raw usage 完整时先发 `usage(delta)`，再发 `[turn_complete, agent_plan_update([])]` |
| `thread/status/changed` | `active` / `idle` 不映射（thread liveness 不是 turn activity）；仅 `systemError` → `status_change(error)` |
| `thread/tokenUsage/updated` | `usage(running_total)` + 实时 context；无完整 raw usage 时 fallback |
| `rawResponse/completed` | adapter 内按 `turnId/responseId` 去重聚合；不透传 raw payload |

### Codex Server Request / 权限协议

`app-server` 还会通过 JSON-RPC Server → Client request 向 MyAgents 要结果。`src/server/runtimes/codex.ts::KNOWN_CODEX_SERVER_REQUEST_METHODS` 是显式 allowlist，升级 Codex CLI 时必须先用 `codex app-server generate-ts --out <dir>` 对照 `v2/ServerRequest.ts`，再决定映射或 fail-closed。当前对接约束：

| Server request | MyAgents 映射 |
|---|---|
| `item/commandExecution/requestApproval` | `permission_request`，`toolName:'Shell'`，保留 `command/cwd/reason` |
| `item/fileChange/requestApproval` | `permission_request`，`toolName:'FileEdit'`，保留 `reason/grantRoot` |
| `item/permissions/requestApproval` | `permission_request`，返回 Codex permission profile + `turn/session` scope |
| `execCommandApproval` / `applyPatchApproval` | 旧协议兼容，仍走 `permission_request` |
| `item/tool/requestUserInput` | 映射到 `AskUserQuestion`，答案按 Codex 原生 question id 回传 |
| `mcpServer/elicitation/request` (`form` / `openai/form`) | 有 schema fields 时映射到 `AskUserQuestion`；`url` / tool approval / generic elicitation 走 `permission_request` |
| `currentTime/read` | runtime adapter 直接返回 `{currentTimeAt}`，不进入 UI |
| `item/tool/call` | 仅 Managed Codex 且命中本 generation 的 Host catalog 时进入既有 permission UI 后由 Dispatcher 执行；重复、stale、unknown、timeout 或 stop 都 exactly-once 失败结算 |
| token refresh / attestation | MyAgents 不托管，显式 error |

IM / Agent Channel 默认不支持桌面结构化提问：若 `hostInteraction.askUserQuestion === 'none'`，Codex `item/tool/requestUserInput` 立即按协议返回空 answers，`mcpServer/elicitation/request` form 立即返回 `action:'cancel'`，并且不登记 `pendingRequests`。`runtimeSource:'managed-provider'` 与 `runtimeSource:'system-cli'` 共享同一个 Codex adapter，因此必须保持一致。

**权限 UI 不允许单槽位。** Codex 可以在同一 turn 一次性发出多个 approval request（例如 4 条 PowerShell 命令），backend 以 `requestId` 同时挂起多条 pending。Renderer 必须把 `permission:request` 当成 FIFO queue keyed by `requestId`；响应成功或后端 stop/error/reset/auto-resolve 时通过 `permission:expired` 精确移除对应项。不能用单个 `pendingPermission` 覆盖新请求，也不能把多条不同请求合并成一次批量批准；`always_allow` 只能通过 runtime 自己的 response protocol 表达。

### ThreadItem 类型对照（v0.128 schema）

`codex app-server generate-ts --out <dir>` 可以生成当前装机版本的真实 TS schema
（不要凭假设，schema 随 Codex 版本飘）。v0.128 schema 见 `/tmp/codex-schema/v2/ThreadItem.ts`，
本 runtime 对接的字段映射：

| Codex item.type | tool_use_start 工具名 | tool_result 内容 / attachments |
|---|---|---|
| `commandExecution` | `Bash` | `aggregatedOutput` + `exitCode` / `durationMs` / `cwd` / `source`；input 带 `commandActions[]`（已 parse 的 read/listFiles/search） |
| `fileChange` | `Edit` | 路径 + diff；`status` (PatchApplyStatus) declined/failed 显式标 isError |
| `mcpToolCall` | `mcp__<server>__<tool>` | `result.content[]` 走 MCP ContentBlock union — `text` join 进 content，`image` / `audio` 生成 ToolAttachment；`mcpAppResourceUri` 透出 |
| `dynamicToolCall` | `<tool>` | `contentItems[]`：`inputText` 进 content，`inputImage{imageUrl}` 生成 ToolAttachment；`namespace` / `durationMs` 透出 |
| `webSearch` | `WebSearch` | `action` union 全分支（search/openPage/findInPage/other） |
| `imageView` | `Read` | `path` |
| `imageGeneration` | `ImageGeneration` | **生图核心**：优先 `savedPath`（零拷贝引用 Codex 自动保存），fallback `result` (base64) 解码落盘 → ToolAttachment[]；content 留 `revisedPrompt` 文字 |
| `collabAgentToolCall` | `CollabAgent` | tool / prompt / model / senderThreadId / receiverThreadIds 摘要 |
| `plan` | — (started 走 thinking_start) | text 通过 `item/plan/delta` 流式 |
| `reasoning` | —（started 不渲染；首个 exact summary/content delta 才走 thinking_start） | summary 通过 `summaryTextDelta` 流式 |
| `enteredReviewMode` / `exitedReviewMode` | — (log level event) | review-mode 进入/退出提示 |
| `hookPrompt` | — (log level event) | hook 注入的提示 fragment |
| `contextCompaction` / `agentMessage` / `userMessage` | — | 通过 turn/agentMessage 路径处理 |

未列出的 item type 会在 `console.warn` 中打印 unhandled，方便 Codex 升级后定位漏接。

`fileChange.changes[].kind` 在 Codex 新 schema 中是对象（如 `{type:"update", move_path:null}`），不是字符串。
Sidecar 必须通过 `src/shared/toolDisplay/filePatch.ts` 归一化后再生成 `tool_result.content`，否则 SSE / 历史会出现
`[object Object]: /path`。`filePatch` 展示协议的 owner 也是这个 shared 模块：new data 的 `Edit` / `Write`
tool block 会写入 compact `tool.display.kind === "file_patch"` descriptor（路径、状态、统计、view kind），不复制
`old_string` / `new_string` / `content` / `diff` 大文本。Renderer 通过同一个 resolver 读取新 descriptor，并对
历史数据继续 fallback 到 `parsedInput -> inputJson -> input`，与 builtin SDK 的 `old_string/new_string` 摘要共用同一展示语义。

### Sub-agent（collab-agent）工具嵌套（PRD 0.2.27）

Codex 主 agent 可派生 sub-agent。**sub-agent 是独立的 Codex thread**，其工具调用、文本、思考通过同一条 app-server stdio 连接多路复用回来——每条 `item/started` / `item/completed` 通知都带顶层 `threadId` + `turnId`。沿用 builtin 的嵌套渲染（`Task` 卡片 → `subagentCalls[]` → `chat:subagent-*` SSE → `TaskTool` 可展开 trace），把 sub-agent trace 折叠进对应协作卡片，而不是平铺进主 transcript。

**双协议兼容（均以对应版本的 app-server 产物与源码确认）**：

| 协议事实 | 用途 / 注意 |
|---|---|
| `ItemStartedNotification` / `ItemCompletedNotification` 带顶层 `threadId` | 区分"哪个 agent/线程发出的工具";**子线程的 item 确实带子线程 id 到达本连接**(实测:子 `commandExecution` 带 child threadId) |
| v1 / Codex 0.135.0：`collabAgentToolCall(spawnAgent).receiverThreadIds` | `item/started` 时为空、`item/completed` 时填入子线程 id；completed 一旦给出 child id 就预留 child lifecycle，避免 root terminal 抢先完成。保留为旧 Codex/System CLI 的兼容关联路径。`wait/sendInput/closeAgent` 仍只引用既有 child，不能重写 spawn 归属 |
| v2 / Codex 0.144.1：`subAgentActivity { id, kind, agentThreadId, agentPath }` | `started` 是 spawn 的唯一 UI/关联信号，且 `id` 就是原 `spawn_agent` call id；`interacted` / `interrupted` 分别归一为消息与中断协作 trace（interrupt 不伪装成 shutdown）。raw discriminator 证明为 trigger-turn 的 follow-up activity 始终成为本 turn 的独立 lifecycle owner，即使同一 child 已在本 root turn 的 spawn 卡下完成；queue-only interaction 仍只是原卡 nested trace |
| v2 spawn / interaction 时序 | Codex 先创建 child 或提交 inter-agent communication，随后才在 sender emit `subAgentActivity(started/interacted)`；child item 与 activity 存在真实并发窗口。typed `interacted` 同时覆盖 queue-only `send_message` 与触发 turn 的 `followup_task`；Managed Codex 新 thread opt-in 官方 `rawResponseItem/completed`，以同一 `call_id` 锁存原 function name，随后只保留 `queue-only` / `trigger-turn` 这一位语义。raw item 在工具执行前已持久化并 emit，故 trigger reservation 不依赖通知时序猜测 |
| 子线程 `thread/started` + `Thread.source` | best-effort 的 parent/nickname/role 辅助来源；0.135.0 不发 child `thread/started`，因此不能作为唯一关联信号 |
| 子线程发**自己的** `turn/started` / `turn/plan/updated` / `turn/completed`(isMain=false) | **必须按 `threadId` 闸掉** —— 否则子线程 turn 完成会提前终结用户 turn + `resetTurnAccumulators()` 清空 `currentContentBlocks`(spawn 卡片 + 嵌套调用),既破坏 turn 完整性又毁掉嵌套；子线程 plan 也不能覆盖主 AgentStatusPanel 的 todo 快照 |

**关联与打标（`codex.ts`）**：`CodexProcess` 持 `subThreadToCard`（child → 本 turn 容器）、`subThreadToParent` / `subThreadMeta`（祖先链与装饰信息）、`collabControlToolParents`（v1 控制动作锁存）、`subAgentThreadsAwaitingActivity`（已开始 child turn 的 activity 因果栅栏）、`subAgentActivitySeenBeforeTurnStart`（activity 早于 turn 的瞬时标记）以及 `deferredSubAgentEvents`（activity 晚到窗口内的 child item）。activity 栅栏只有在进程已确认观察到 v2 协议后才启用；v1 child 因此不会等待一个永远不存在的 `subAgentActivity`。v1 与 v2 只负责把各自 wire shape 投影进这套既有 turn-local 关联，不向 session/renderer 暴露协议版本。child→child 的 activity 即使先于 sender 的祖先关联到达，也要先记录 edge，待祖先出现后整体解析。

- **子线程事件闸门**:`isChildThreadGatedMethod(method)`(`turn/started`/`turn/completed`/`thread/status/changed`/`thread/closed`/`thread/tokenUsage/updated`/`rawResponse/completed`)+ `threadId !== mainThreadId` → 子生命周期绝不作为主 session lifecycle 上抛；其中 child `turn/started` / `turn/completed` 更新内部 ownership，`thread/closed` 与 `systemError` 也会 settle child ownership，并可能在最后一个 child settle 时释放已暂存的 root terminal；其它 child status/token usage 事件忽略。`thread/tokenUsage/updated`(PRD 0.2.32)放行会让子 agent 的占用污染主 context 指示器 + 持久化 `lastContextUsage`；`rawResponse/completed` 放行则会把子 Agent 的 provider usage 计入主 Session。item 通知**不**闸(要的就是子工具)。
- `computeCodexItemEventRoute()` 把 item 明确分成 `main` / `subagent` / `defer`；`computeSubAgentScope()` → `resolveTopLevelSpawnCard()` 沿父链上溯，深层 sub-sub-agent 归并到第一层容器（UI 只一层）。**foreign thread 未关联时只能 defer，禁止退化为 main**。
- `deferredSubAgentEvents` 只属于当前 main turn：任何 ancestor 关联建立且对应 activity 栅栏解除后，按 ancestor depth（父先于后代）释放；最终仍无法关联则丢弃并告警。它解决的是 Codex 源码中“先启动/唤醒 child、后 emit activity”的因果窗口，不是 retry/cache。
- `experimentalApi` handshake 与 `experimentalRawEvents` request 只在 Managed Codex **新 thread** 同时开启；截至 0.146.0，`thread/resume` schema 仍没有 raw-events 参数，System CLI 也必须兼容旧版本。缺少 raw discriminator 时，adapter 不把模糊 `interacted` 猜成 active turn（否则 queue-only 会让 root 永久不完成）。若 root terminal 到达时仍没有 child `turn/started` 给出确定 ownership，adapter 释放该 root terminal 后结束当前 app-server，由既有 session resume 路径重建干净 runtime；不维护跨 turn quarantine，也不允许旧进程的迟到 child 串入下一 turn。
- root terminal 到达时若 child 仍处于 `subAgentThreadsAwaitingActivity`，说明本 turn 的 parent correlation 不完整；与上述模糊 `interacted` 共用同一个进程边界降级：暂存 root terminal、结束 app-server、在 exit 依次发出 root terminal 与 `session_complete`。没有 quarantine、timer、retry 或跨 turn 猜测。
- Codex child turn 是独立执行单元，可能晚于 root model 的 terminal。adapter 观察 foreign `turn/started` / `turn/completed`（不把它们上抛为主生命周期），保留 active child 的精确 `(threadId, turnId)`；仍有 child 时暂存 root terminal，最后一个 child settle 后才把既有 `turn_complete` 交给 external-session。成功 terminal 自然等待；中断/失败 terminal 会请求 interrupt 所有 active child 后等待其 terminal。若 force-send 命中已完成 root、尚未完成 child 的窗口，`interruptTurn()` 同样改为中断 child turn；尚未拿到 turnId 的 child 在 `turn/started` 到达时立即执行 pending interrupt。相同 `(threadId, turnId)` 的并发中断 single-flight；RPC 失败后先重验 root/child ownership，只有仍悬挂时才终止 app-server，并在 exit boundary 恰好一次释放原 root terminal。这样完整 nested trace 在同一 assistant turn 持久化，且不破坏 Stop/force-send。
- 同一份 native child turn observation 还是 lifecycle-eligible `CollabAgent` 的唯一执行 authority。adapter 只在真实 child `turn/started` / terminal 到达时记录本地观察时间，经既有 ancestry 与 activity correlation 映射到顶层父卡，并发出 runtime-neutral `subagent_lifecycle`；spawn / trigger-turn 的预留只保护 root causal fence，不单独制造 `running`。后代 turn 只延迟父卡 terminal，父卡最终结果仍由 direct owner child 决定；queue-only `send_message` 与 wait / interrupt / close 不获得 lifecycle。记录随当前 root turn 的 correlation 一起清空，不建立 Session registry。
- reasoning summary / content trace 在各自首个 delta 才用 exact `threadId + itemId + summary|content index` 开启，`item/completed(reasoning)` 逐一关闭同一批 exact id。不得重新用通用 `reasoning` suffix 结束，也不得依赖 root terminal 批量补关正常 trace。
- 异步 `tool_attachment_update` 的最终 owner 是 external-session 的内容状态：若 placeholder/tool 仍在 Codex 因果缓冲中，attachment update 与它一起等待；一旦 tool 已跨过 runtime boundary，后续事件不再依赖 thread map。sub-agent 同时识别 live child-tool latch 与 settled attachment latch；sub-agent 或 top-level update 若早于异步 tool-result normalization，均由 content owner 暂存并在 placeholder 建立时原子应用。完全无 owner 的迟到 update fail-closed，禁止制造 top-level SSE。
- 主线程 `wait/sendInput/closeAgent` 走 `resolveCollabAgentControlParents(tool, receiverThreadIds, …)`。解析成功时生成合成子 trace id(`originalId::subagent-control::parentToolUseId`)并直接挂 `subAgent`;started 已解析的 parent 集合在 completed 侧优先使用,避免 start/result 分裂。解析不到时 started 不渲染,completed 再解析,仍解析不到才输出一个完整顶层 fallback 卡片(不丢调用)。`status: failed` 透传为 `tool_result.isError=true`。
- 打标在 `UnifiedEvent` 的工具、文本、思考事件挂 `subAgent: SubAgentScope { parentToolUseId, nickname?, role? }`(见 `types.ts`)。已由控制事件预置的 `subAgent` 不会被 thread-level tagging 覆盖。map 在 root terminal 与所有已观察 child turn settle 后清空；中断/失败 terminal 先请求中断 active children，待 child settlement 后再释放 root terminal。若 child interrupt RPC 无法确认，adapter 终止当前 Codex 进程，并在 exit boundary 依次释放原 root terminal 与 `session_complete`；external-session 据此清理 runtime owner，下一条消息沿既有 resume 路径启动新进程。

**路由（`external-session.ts` facade + `external-session/content-blocks.ts` state owner）**:`tool_use_start` 命中 `event.subAgent` 时归并进父卡片 `subagentCalls[]`;若父卡片仍在 streaming、尚未进入 content blocks,先写 `pendingSubagentCallsByParent`,等父 `tool_use_stop` 持久化时合并,不会退化成顶层平铺。归并后写 `childToolToParent`;后续 `tool_input_delta`/`tool_use_stop`/`tool_result(_delta)` **只按 `childToolToParent` 锁存路由**(不再每条重判 `event.subAgent`),杜绝"先平铺后嵌套"闪烁。子线程 `text_delta` / `thinking_delta` 通过合成 `AgentMessage` / `Thinking` trace 行复用 `chat:subagent-tool-*`。`subagent_lifecycle` 由同一 content owner 按父卡 id 单调合并；父卡尚未 materialize 时只暂存最小 lifecycle，无论普通 `tool_use_stop` 还是 root flush 首次物化父卡都必须原子附着。每次 root `turn_complete` / `session_complete` 在持久化或丢弃 partial assistant 前递归关闭残余 nested loading，并把缺失 child terminal 的 running 卡 fail closed 为 `failed`，明确用户 Stop 则为 `interrupted`；resultless nested call 使用共享 pure policy 投影为既有 `Failed` / `Interrupted` error result，已有真实结果原样保留。已确认 terminal 不覆盖，root success 绝不合成 child success。实时状态走 critical `chat:subagent-status`，成功 turn 的 `PersistContentBlock.tool.subagentLifecycle` 与 nested trace 一起持久化；失败 / 停止 turn 维持既有不落 partial assistant 的契约。live snapshot (`getExternalLiveAssistantMessage`) 同样合并 pending calls 与 lifecycle，所以 Tab 重连/重开不会重新平铺或丢状态。

**前端**：`isSubagentContainerTool(name)`（`toolBadgeConfig.tsx`，单一真源）继续统一路由 `CollabAgent` 与 builtin `Task`/`Agent`；`subagentActivity.ts` 的 pure view helpers 让显式 `CollabAgent.subagentLifecycle` 优先于旧 loading 线索，builtin 行为不变。`TabProvider` 对 streaming 与 archived assistant 都幂等应用 `chat:subagent-status`，并在 root archive 前做同一 fail-closed nested projection；Companion 的既有 SSE reducer 消费同一事件并复用同一 content helper，不从父工具的早停 `isLoading` 猜 child 终态。`TaskTool`、`ProcessRow`、Agent Status Panel 与 Companion 共用该状态：terminal icon 明确、elapsed 固定；Panel 只选当前 live assistant message，root terminal 同批归档时保留该 message 的展示资格，全组 terminal 后只做一份 500 ms linger，再走既有淡出，透明过渡期用原生 `inert` 移除键盘交互。缺少 lifecycle 的旧持久 `CollabAgent` 不从 stale nested loading 复活为 active Agent，也不做 transcript migration。

**仅 Codex 设 `subAgent`**；builtin 走自有 `parent_tool_use_id` 路径，Gemini / Claude Code 不设 → 行为不变。旧的正确 `CollabAgent.subagentCalls` 历史无需迁移。已经平铺落库的历史块不含 thread/card provenance，不能从 MyAgents JSONL 安全反推，故不做启发式回填。**非目标**：sub-agent 工具的多级 UI 嵌套（归并到顶层卡片）、已平铺历史的自动回填。

### 富媒体产物（ToolAttachment）

Codex 的 `imageGeneration` / `mcpToolCall` 含 image content / `dynamicToolCall` 含 inputImage 三条
路径都走统一 `saveToolAttachment(...)` → `tool_result.attachments[]`。前端用单一
`ToolAttachmentGallery` 渲染。完整管道（异步落盘 placeholder、5 层路径校验、SSRF 防护、session
resume 重 register）详见 [Tool Attachment 管道](./tool_attachment_pipeline.md)。

Managed Codex 的 `CODEX_HOME` 是运行时状态目录，不整体视作 credential root。共享 Node/Rust 路径
黑名单仅精确保护其中的 `auth.json`；`generated_images` 等非凭据产物仍走既有 externalPath 注册与
attachment URL 服务，并继续接受 canonical path、符号链接、文件类型与大小校验。

### 权限模式映射

| MyAgents | Codex approvalPolicy | sandbox |
|----------|---------------------|---------|
| `suggest` | `untrusted` | `read-only` |
| `auto-edit` | `on-request` | `workspace-write` |
| `full-auto` | `never` | `workspace-write` |
| `no-restrictions` | `never` | `danger-full-access` |

## Gemini Runtime (`src/server/runtimes/gemini.ts`)

### 协议:Agent Client Protocol (ACP) over stdio

Gemini CLI 通过 `gemini --acp` 原生实现了 Zed 的 Agent Client Protocol(ACP)— 同样是
JSON-RPC 2.0 持久进程,与 Codex `app-server` 形态同构。MyAgents 作为 ACP Client,
Gemini CLI 作为 ACP Agent。协议规范见 https://agentclientprotocol.com/protocol/schema。

### Agent 方法(Client → Agent)

| RPC 方法 | 用途 |
|---------|------|
| `initialize` | 握手 + 协商 protocolVersion(当前 1)+ 读取 agentCapabilities |
| `session/new` | 开新会话,参数含 `cwd` + `mcpServers[]`,返回 `sessionId` + 可用 `modes` + 可用 `models` |
| `session/load` | 恢复历史会话 |
| `session/prompt` | 发消息,返回 `{stopReason, _meta:{quota:{token_count,model_usage[]}}}` |
| `session/cancel` | 中断当前 turn(notification,不等 response) |
| `session/set_mode` | 切换审批模式(`default` / `autoEdit` / `yolo` / `plan`) |
| `session/set_model` | 会话中切换模型(ACP 稳定版本,不是 `unstable_*`) |

### 服务端通知(Agent → Client)

通过 `session/update` notification 的 discriminated union:

| `sessionUpdate` | 派生的 UnifiedEvent |
|----------------|-------------------|
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `thinking_start`(首次) + `thinking_delta` |
| `tool_call` | `tool_use_start`(ACP 在 `autoEdit`/`yolo` 模式先发这个) |
| `tool_call_update { status: completed/failed }` | `tool_use_stop` + `tool_result`(late-bind `tool_use_start` if missing) |
| `plan` | `raw`(本期透传,UI 后续升级) |
| `available_commands_update` | 忽略(IDE 命令菜单) |
| `user_message_chunk` | 忽略(session/load 回放) |

### 服务端请求(Agent → Client,需应答)

| RPC 方法 | 处理 |
|---------|------|
| `session/request_permission` | 派生 `permission_request` UnifiedEvent(同时若未发 `tool_use_start` 则 late-bind)。MyAgents 返回 `{outcome:{outcome:'selected',optionId:...}}`;选项 `optionId` 基于 ACP 回传的 `options[].kind`(`allow_once` / `allow_always` / `reject_once`)健壮匹配。`default` 模式下 Gemini 跳过 `tool_call` notification 直接发 permission request,runtime 在此路径补发 `tool_use_start`,保证前端显示一致 |
| `fs/*` / `terminal/*` | **不声明**对应 capability,Gemini 使用自己的内置工具。如仍收到 → `respondError(-32601)` |

### 系统提示词注入:`GEMINI_SYSTEM_MD` + tmp 文件合并

Gemini CLI ACP 协议本身没有 `session/new` 层面的 system instruction 参数。我们采用
Gemini 官方支持的 `GEMINI_SYSTEM_MD` 环境变量(见
https://geminicli.com/docs/cli/system-prompt/):它指向一个 markdown 文件,
内容**整体替换**Gemini 内置系统提示。

**不能简单 replace** — 这样会丢失 Gemini 的工具调用约定、安全规则、tone guidelines。
解决方案:**合并注入**。

1. **基底提取(一次性,按版本缓存)**:`extractGeminiBasePrompt(version)` 启动一个
   `gemini -p "."` 子进程,通过 `GEMINI_WRITE_SYSTEM_MD=<cachePath>` 环境变量让 Gemini
   把内置 prompt 导出到文件。Gemini 写文件发生在启动阶段、API 调用之前,runtime 轮询
   文件出现即 `kill(9)` 子进程 — **不产生 token 消耗**。
   缓存路径:`~/.myagents/tmp/gemini-prompts/base-<version>.md`,v0.37.2 约 25KB。

2. **per-session 合并**:`writeSessionSystemPrompt(sessionId, myAgentsPrompt, version)` 把
   MyAgents 的三层 prompt(base-identity + channel + scenario)前置,基底附在
   `---` 分隔符后并包上 "以 MyAgents 指令为优先" 的说明。写入:
   `~/.myagents/tmp/gemini-prompts/session-<sessionId>.md`。

3. **注入**:`spawn(['gemini', '--acp'], { env: { GEMINI_SYSTEM_MD: promptFile } })` —
   环境变量在 spawn 时即生效。

4. **生命周期**:session 结束(`proc.exited` / `stopSession`)时删除该 session 的 prompt
   文件;启动时扫描并清理超过 1 小时的残留(`cleanupStaleSessionPrompts()`),base 缓存
   文件(`base-*.md`)保留以供下次复用。

### 模式 ID 映射(D5/D6)

| MyAgents 内部值 | Gemini ACP modeId |
|----------------|-------------------|
| `default`       | `default`  |
| `autoEdit`      | `autoEdit` |
| `yolo`          | `yolo`     |
| `plan`          | `plan`     |
| 兼容:`auto`    | `autoEdit` |
| 兼容:`fullAgency` | `yolo`   |

- 桌面场景默认:`autoEdit`(通过 `getDefaultRuntimePermissionMode('gemini')` 返回)
- Cron / IM / agent-channel 场景默认:`yolo`(在 `startSession` 内 `pickDefaultMode` 覆盖)

启动时如果期望的 mode ≠ `default`,runtime 在 `session/new` 后立即调用 `session/set_mode`
应用;失败时非致命,仅打印 warning。

### 模型列表动态发现

不硬编码 `GEMINI_MODELS`(常量里只保留一个"默认"占位)。`queryGeminiModelsViaAcp()` 策略:

1. 先检查非交互鉴权环境，或已选择的 auth 类型及 OAuth credential 存在性；未配置时直接返回可操作错误，绝不 spawn 后台登录向导
2. Spawn 短命 `gemini --acp`(cwd = `$HOME`,避免被当前 workspace 配置干扰)
3. `initialize` 握手 + `session/new`
4. 从 `result.models.availableModels[]` 读取 `{ modelId, name, description, isDefault }`
5. 在首位追加一个空值 `default` 条目(交给 Gemini 自选)
6. 无论成功、失败或请求中断，都通过 `killWithEscalation(killTree=true)` 有界关闭进程树和 stdio drain

v0.37.2 实测返回 8 个模型:`auto-gemini-3`、`auto-gemini-2.5`、`gemini-3.1-pro-preview`、
`gemini-3-flash-preview`、`gemini-3.1-flash-lite-preview`、`gemini-2.5-pro`、
`gemini-2.5-flash`、`gemini-2.5-flash-lite`。TTL 缓存 5 分钟,同 Codex 做法。

**启动稳定性**:`queryModels` 调用前 `await new Promise(r => setTimeout(r, 50))` 让
stdout reader 先进入 `await read()`,防止 initialize 响应在 handler 注册之前到达的
竞态;超时由 10s 上调到 30s,覆盖 Gemini Node.js 冷启动和已有凭据刷新的延迟。
同一 runtime/source 的并发发现由 single-flight owner 合并；单个 HTTP 等待者取消只解除自身订阅，最后一个等待者取消才 abort owner 并清理临时进程树。

### 认证

**凭据完全不由 MyAgents 管理**。Gemini CLI 支持 OAuth、`GEMINI_API_KEY`、Vertex AI 三种方式,
用户自行在本机完成登录(`gemini` 交互式向导或 shell rc 导出环境变量),MyAgents 子进程
只消费既有凭据。短命模型发现会在 spawn 前 fail-closed；它不会替用户启动浏览器登录或写入凭据。
真实 Session 启动仍由 Gemini CLI 使用本机既有 auth authority，鉴权失败原样返回给会话错误面。

## External Session Handler (`src/server/runtimes/external-session.ts`)

`src/server/runtimes/external-session.ts` 是三种外部 Runtime 的 public facade 和高层编排入口。它不直接拥有核心可变状态；这些状态位于 `src/server/runtimes/external-session/`：

| Owner module | 职责 |
|---|---|
| `types.ts` | facade/owner 共享类型：`PersistContentBlock`、`ExternalSendContext`、config result、queue operation、turn snapshot 等 |
| `lifecycle.ts` | active process/runtime、`startingPromise` guard、session binding、runtimeSessionId、prewarm/system-init、user-stop flag |
| `runtime-config.ts` | desired/live model、permission mode、reasoning effort；config coercion 与 snapshot/source guard integration |
| `operation-queue.ts` | direct/queued message operation及其 user-message projection、turn-boundary message/config FIFO（Desktop + busy IM）、adjacent config coalescing、drain reservation、generation-based stale dispatch rejection、direct-send tail admission/reset、force/cancel/status bookkeeping |
| `turn-lifecycle.ts` | turn completed/success flags、activity facts、completion terminal、`TurnFinalizationGate`、turn start time、usage/context usage state；`turn_complete` / `session_complete` terminal plan 分类；显式 channel-delivery admission、success-gated batch commit 与 user-before-assistant delivery tail |
| `content-blocks.ts` | streaming text/thinking/tool/subagent content state；tool result/attachment mutation；live snapshot 与 turn snapshot backing state |
| `transcript-persistence.ts` | in-memory `SessionMessage[]`、SessionStore transcript cursor、persisted runtime usage totals、user/assistant tail append、命名 retry/removal mutation、last assistant read、metadata preview/context update |
| `interactive.ts` | permission / AskUserQuestion pending state、active IM request id、IM registry cleanup、inbox/watch reply metadata与错误推送；permission response delivery 成功后才 consume/delete，并广播 `permission:expired` / `ask-user-question:expired` 清理所有 UI surface |

Facade 仍负责跨模块编排：调用 Runtime 进程、广播 SSE、执行 analytics/title hook，并根据各模块返回的结果依次完成持久化、交互清理和队列 drain。Queue 模块不直接调用 Runtime；lifecycle 模块不接管 stop cleanup；content 的内部引用和 Map 不暴露给 facade，工具、子 Agent 和附件更新都通过命名 API 完成。Turn lifecycle 负责终态分类和本轮 channel delivery 的接纳与顺序；transcript 模块负责用户/assistant 消息、retry truncate、last assistant read 和 SessionStore 写入；interactive 模块负责 IM event bus、registry cleanup 以及 inbox/watch 错误投递，持久化 JSON 结构不变。

External transcript owner 与 builtin 共用 SessionStore cursor 契约，但不共享 runtime lifecycle 抽象：只能追加 cursor 之后的 exact tail；live projection 短于 durable prefix 时先 rehydrate 再拒绝当前操作，不能把短数组当成删除指令。retry/removal 走命名 mutation，fork target 必须为空；冲突向调用方返回可操作错误，不做 blind retry 或历史合并。

每个 direct/queued message operation 保存自己的用户消息，并记录该消息是否已经展示、写入内存 transcript、持久化或撤回。Desktop、IM、Inbox、Background、Injected 与 realtime fallback 复用既有 direct-send tail 和 queue generation，facade 不保存进程级的第二份“首条消息”状态。`external-session.ts` 只保留 watchdog、trace、待创建 Session 等确实属于编排过程的状态。

### 测试护栏

External runtime 的维护入口是 `SessionEngine`，测试也必须沿这条边界验证。`src/server/runtimes/external-session-mock.integration.test.ts` 通过 Vitest mock `runtimes/factory.ts` 注入 test-only fake runtime，fake runtime 的 `type` 使用真实 `RuntimeType`（当前为 `codex`），不在生产 `RuntimeType`、config 或 UI 中新增 `mock` 分支。

这组测试属于 `integration` project：允许触碰 external-session module globals、SessionStore、临时 HOME、operation queue，但由 `src/test/setup-no-egress.ts` 禁止非 loopback 网络。覆盖面固定为：正常 external turn 的 latest/live/persisted read、failed turn 不被当作成功、desktop queue 顺序、同时 idle 的 IM 原子 admission、Desktop/IM 并发 operation 的消息 identity 隔离、pre-accept reject 与持久化失败的精确 bubble retraction、busy IM 连续 admission + FIFO drain + running/queued requestId 精确取消、permission response 成功后清 pending、permission delivery 失败时保留 pending；渠道投递还覆盖 fresh/queued/realtime Desktop、Session Inbox 隐藏输入只投 assistant、已关闭 text block 后失败/停止仍不投递、automation-origin 中途 Desktop steer、慢持久化下 user-before-assistant 顺序、user mirror 失败不抑制 assistant、Builtin result-only 回退与 per-yield owner 隔离，以及 IM-origin / caller-owned turn 保持单路回复。

### 三路消息发送

```typescript
sendExternalMessage(text, images?, permissionMode?, model?, context?)
```

| Case | 条件 | 行为 |
|------|------|------|
| 1 | 无 runtimeSessionId + 不在运行 | 全新 session |
| 2 | 进程已退出（CC -p 模式） | `--resume` 恢复 |
| 3 | 进程存活（Codex 持久模式） | `sendMessage()` 到 stdin |

### 打开历史 Session

桌面 History 不再执行 Runtime 内的 real→real hot-swap。Global Sidebar、Search、通知 / Task deep-link 与开发者 Chat History 都进入 App 的 canonical new / jump / revive 导航：目标已在 Tab 中就跳转，Tab 存在但 Sidecar 已停就复用该 Tab 并由 Rust revive，否则新建从首帧即绑定目标 Session 的 Tab。`codex/system-cli` 与 `codex/managed-provider` 等完整 runtime identity 由目标 Session 自己的 Sidecar 冻结，不需要在当前 Tab 上做兼容性比较。

因此 Renderer 的 persisted restore 只读 `GET /sessions/:id`，不会调用 Node binding mutation；`POST /sessions/switch` 与 `SessionEngine.switchToExistingSession()` 已删除。普通 `cmd_upgrade_session_id(old,new)` 只服务 exact Tab 的 pending→real / desktop reset，不能扩展为 History navigation。桌面绑定 surface 的 real→real 迁移走独立 proof-bearing contract：Rust 先证明 exact `Tab + Agent`，再把同一个 target ID 交给 `SessionEngine.migrateBoundSurfaceSession()`；Builtin 与 External adapter 都不得自行 mint 第二个 ID。IM `/new` 不进入 Runtime facade，只在 Rust 轮换 Agent binding。External adapter 在 target binding 提交后把 metadata publication / pre-warm 失败降为 warning，避免把已提交身份误报为可回滚失败。

所有实际 session identity boundary（桌面「新对话」、pending materialization commit、
pre-warm、IM reset、external config boundary）必须按 runtime process 存活性清理，
而不是只看 active turn。Codex app-server 这类 persistent runtime 在 turn 结束后会进入
idle，但进程仍持有 stdin/thread owner；在 `restoreExternalSessionState(target, ...)`
或 `resetSession()` 前如果不先 stop 这个 idle process，就会把旧 runtime 进程挂到新的
MyAgents session 身份下，造成历史会话和新会话串写。

### 桌面连续发送响应模式

桌面 Chat 的全局 `chatQueueResponseMode` 同时作用于 builtin 与 external runtime：

| 模式 | builtin SDK | Codex app-server | 其它 external runtime |
|---|---|---|---|
| `realtime`（默认） | busy 时进入 SDK async queue，模型在工具边界读取 | busy 且无更早 queued work 时调用 `turn/steer` 追加到当前 active turn | 不支持 same-turn steering，fallback 到 turn-boundary queue |
| `turn` | busy 时进入 turn-boundary queue | busy 时进入 MyAgents turn-boundary queue，当前 turn 完成后再 `turn/start` | turn-boundary queue |

实现边界：
- `AgentRuntime.steerMessage?()` 是可选能力；只有 Codex adapter 实现。`external-session` 只看 capability，不硬编码 runtime 名。
- `turn/steer` 必须带 `expectedTurnId`（来自 Codex 当前 active turn）和 MyAgents user message id 作为 `clientUserMessageId`。
- same-turn steering 不应用新的 model / permission / reasoning effort snapshot；这些仍是下一 turn 边界生效，和 builtin busy 时“配置锁定当前 turn”的语义一致。
- response mode 与 same-turn steering 只作用于桌面 `sendDesktopMessage`。IM 始终保持 turn
  级语义：idle 时等待既有 adapter admission 结果，busy 或已有普通 direct send 占位时由同一个
  external turn-boundary queue 立即接管并返回 admission，不进入 Codex `turn/steer`，也不主动
  走 `sendExternalMessage()` 的上一轮轮询。该轮询仍是非 IM / 内部异常竞态的防御 gate；
  首条 process config invalidation 仍保留 adapter fail-loud，后续 direct-tail 并发请求由正式 queue
  接管并以 request-scoped terminal 报错；Task / Inbox / injected turn 的既有语义不变。

### 内容块持久化

流式事件在 `handleUnifiedEvent()` 中被实时广播到前端（SSE），同时累积到 `PersistContentBlock[]`：

```typescript
interface PersistContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: { id, name, input, inputJson, result, isError, streamIndex };
  thinking?: string;
}
```

`turn_complete` / `session_complete` 的 terminal plan 由 `turn-lifecycle.ts` 分类；finalization 在第一个 `await` 前同步 snapshot inbox/watch meta、context usage、content-blocks turn snapshot、assistant text。随后等待 tool attachment in-flight saves，再由 `transcript-persistence.ts` 序列化为 `JSON.stringify(ContentBlock[])` 写入 SessionStore——与 builtin runtime 格式一致，前端 `TabProvider.tsx` 的 JSON 解析路径直接复用。`TurnFinalizationGate` 在 `turn-lifecycle.ts`，`waitForExternalSessionIdle()` 必须等待 finalization settle 后才允许 cron/IM/injected caller 读取最新 assistant text。

### 配置变更

External runtime 的 model / permission / reasoning effort 统一走
`updateExternalRuntimeConfig()`。desired/live state 在 `external-session/runtime-config.ts`；如果当前 turn
正在运行、已有 queued message/config operation、或 turn finalization 仍在落盘,则把
config patch 放入 `external-session/operation-queue.ts` 维护的 FIFO。turn boundary
drain 时先应用前导 config ops,再启动下一条 queued message,因此不会打断当前轮,
也不会让后来的配置倒灌到更早入队的 message。busy external IM 与 Desktop 共用这条
turn-boundary FIFO，并在入队时把 requestId / terminal observer / runtime config snapshot
绑定到 operation；因此桌面可见 `queue:added/started`，取消和失败也能精确回到原 IM
requestId。Task 仍在每轮 `ExternalSendContext` 中 self-resolve live config。

Snapshot/source guard 由 `session-core/runtime-config-policy.ts` 统一决定。`/api/runtime/config` 接受 `source`，Rust IM router 的热同步必须传 `source:"im-sync"`；`runtime-config.ts` 在写入 desired model / permission / reasoning effort 之前先过滤 snapshotted desktop-owned session 的 IM 字段，避免 channel config 污染 desired state。桌面 runtime config push 继续使用 `source:"runtime-config"` / `source:"desktop"` 并保持权威。

| Runtime | model | permissionMode | reasoningEffort |
|---------|-------|----------------|-----------------|
| Codex | `next_turn_state`：更新 process.model,下一次 `turn/start.model` 生效 | `next_turn_state`：更新 approval/sandbox,下一次 `turn/start` 生效 | `next_turn_state`：下一次 `turn/start.effort` 生效 |
| Gemini | `live_session_rpc`：边界处调用 ACP `session/set_model` | `live_session_rpc`：边界处调用 ACP `session/set_mode` | `unsupported` |
| Claude Code | `next_turn_state`：更新 `lastModel`,下一轮 `-p` spawn 带入 | `next_turn_state`：更新 `lastPermissionMode`,下一轮 spawn 带入 | `next_turn_state`：更新 `lastReasoningEffort`,下一轮 `--effort` 带入 |

旧的 `setExternalModel()` / `setExternalPermissionMode()` /
`setExternalReasoningEffort()` 仍保留为 thin wrappers,供 `/api/model/set` 等旧端点
兼容调用。新增配置入口不得在 active turn 中调用 `stopExternalSession()` 作为生效手段；
需要 process restart 的 runtime 必须在 idle/turn boundary 处理。
Gemini 的 model / permission boundary RPC 失败时 fail-closed：不继续用旧配置启动
queued message,并向前端广播错误。

Official tool id 会改变 external runtime 的 system prompt，因此其 live 配置 owner 也在
`external-session.ts`。每个 active process 记录创建它时实际生效的 id set：相同 set 的
renderer hydration / 重复同步必须是 no-op；真实变化若发生在 active turn 中，锁存到
terminal boundary 后再使进程失效，若已 idle 则直接使进程失效。禁止把“收到一次配置
POST”等同于“配置发生变化”，否则接管 IM 会话时的 hydration 会杀掉已经预热好的进程。

### 预热 Pre-warm

Gemini / Codex 冷启动(spawn CLI + `initialize` + `session/new`)约 10–15 秒,用户在此期间打字无反馈。`prewarmExternalSession()` 把这段时间挪到 Tab 打开的瞬间:

**适用范围**:仅 Gemini / Codex(持久 JSON-RPC 进程)。CC `-p` 模式每轮退出,预热无意义 → HTTP 端点在到达此路径之前就拒绝。

**触发链路**:前端 `Chat.tsx` 在 Tab ready(`isActive && isConnected && sessionId`)的瞬间 POST `/api/runtime/prewarm` → `prewarmExternalSession()` → `startExternalSession({ ...options, initialMessage: undefined })`。**不**等待 `/api/runtime/models` — 该接口自身也 spawn 一个 `gemini --acp` 子进程查模型,会付同样的 ~14s 冷启动。两件事并行进行:prewarm 在用户打字时暖 session,models-fetch 在后台填充模型下拉。首次 prewarm 用 `effectiveModel`(可能 `undefined` → runtime 用自带默认),用户随后在 UI 里切模型时走 `setExternalModel()` → in-place `runtime.setModel()` 路径(见「配置变更」)。

Codex middle-turn Rewind 是同一 Tab / Session / Runtime identity，Renderer 的 mount key 不会重新触发上述 POST。因此 durable replacement binding restore 后由 external-session 编排 owner异步复用同一个 `prewarmExternalSession()`；调用发生在 conversation mutation lease 释放后，并在执行前核对当前 lifecycle Session 与 replacement binding，避免迟到预热覆盖后继 Session。第一 Turn Rewind 不走这条优化，因为 fresh prewarm 会产生尚未 materialize、不可跨 app-server resume 的空 thread id；它保持无 binding，等待下一次真实 send fresh-start。

**Managed Codex readiness**：`initialize` 只证明 app-server 已建立；MyAgents 注入的 MCP 仍可能异步启动。Managed-provider launch config 为每个 stdio / HTTP server 注入由 `MCP_PREWARM_GRACE_MS` 派生的原生 `startup_timeout_sec`；`CodexRuntime.startSession()` 在发起 `thread/start|resume` 的 native startup boundary 启动同一 10 秒 absolute grace，并观察 `mcpServer/startupStatus/updated`。Barrier 等待每个注入 server 各自到达终态：全部 ready 则 ready，任一 `failed` 让最终结果 degraded，但仍等待其他 server 的终态，避免放行首轮时漏掉仍可成功的工具。Codex 可能对同一 server 发出 `starting → cancelled → ready`，所以 `cancelled` 与无状态/`starting` 一样继续等待后继状态，只在 absolute grace 到期时按 pending timeout 降级并继续首个 `turn/start`。不自动调用 `config/mcpServer/reload`、不在下一轮重试；新 Session / process 才重新尝试。`mcpServerStatus/list` 只用于只读 UI 投影（诊断与工具目录），不是 barrier。等待只覆盖 MyAgents 注入的 server name，用户自有 Codex MCP 不归此 owner。Process exit、thread/RPC failure 仍是真 Runtime failure，不能被 degraded 吞掉；`system-cli` launch config 与行为不变。

**IM 冷启动边界**：persistent Agent/飞书 session 一旦已有 live runtime，后续 turn 复用同一 process 与 MCP，不应重复支付 startup。完全没有 Sidecar/runtime 的首个 IM peer 仍要真实创建这些资源；本期不为所有潜在 peer 常驻预热，因为那会把延迟换成无界资源占用。这个首个 cold turn 是显式产品边界，不得和“同 session 每轮重启”混为一谈。

**关键差异**(pre-warm vs 正常 start):

| 项 | pre-warm | 正常 start |
|----|----------|-----------|
| `initialMessage` | 省略 | 普通 turn 含用户消息；带 `beforeDispatch` 的 guarded fresh/resume 先省略，进程归属建立后再 `sendMessage` |
| Session state | 保持 `idle`(UI 不显示 spinner) | 切 `running` |
| 看门狗 | **不启动**(10 分钟进程空等是合法的) | 启动 |
| Session metadata 落盘 | 推迟 | 创建时写入 |
| 失败处理 | **静默**(log-only,不 toast) | broadcast `chat:agent-error` |

`sessionState` / `SessionEngine.isBusy()` / `waitIdle()` 表达的是 **turn activity**，不是 process liveness。Codex/Gemini 预热后进程与 stdin/thread owner 仍存活，但只要 `sessionState='idle'` 就必须对 Goal scheduler、memory update、retry 等上层调用方报告 idle；需要 stop/reset process 的 session boundary 使用 `hasExternalRuntimeProcess()`，不能重新用 busy 判据代替。

**守卫**:
- **双层重复守卫**:`isExternalSessionActive() || isRunning || startingPromise` 任一成立即视为已暖,直接返回。
- **后端 cross-runtime 校验**:读 `getSessionMetadata(sessionId)?.runtime`,若与当前 Sidecar 的 runtime 不匹配则拒绝。前端 `Chat.tsx` 也有对应校验,但 `sessionRuntime` 状态异步注入,后端检查关掉 race-window 漏洞。
- **Resume ID 守卫**:`lastSessionId === options.sessionId && lastRuntimeSessionId` 同时成立才传 `resumeSessionId`,防止 reset / surface migration 后遗留的 runtime session id 误 resume 到新 session → "No conversation found" CLI 错误。

**首条消息路径**:
- 预热成功且进程仍活着 → `sendExternalMessage` 命中 Case 3(进程活着),`ensureExternalSessionMetadataForRealUserTurn({ turnPath:'active-process' })` 在此处写 metadata + 启动看门狗。
- 预热进程已退出但留下 runtime session id → `sendExternalMessage` 命中 Case 2(resume),`_doStartExternalSession` 的 `initialMessage` 分支必须先用 pending birth materialize metadata,再通过 `external-session/transcript-persistence.ts::persistExternalUserMessageAppend()` 写入用户消息。 这是 Codex/Gemini prewarm-exit 的关键路径:虽然传了 `resumeSessionId`,但 MyAgents metadata 还没出生。
- 预热完全失败/无历史 → `sendExternalMessage` 命中 Case 1(fresh),走正常启动路径,metadata 在 `_doStartExternalSession` 的 `initialMessage` 分支写入。
- 三条路径共享 `ensureExternalSessionMetadataForRealUserTurn()`。pending birth 只由 fresh prewarm(`!initialMessage && !resumeSessionId && !metadata`)建立;缺 metadata 只允许 fresh start 或明确的 pending birth 创建。普通 resume / active-process / resume prewarm 缺 metadata 直接 fail-closed,避免删除后的 session 被 runtime 侧状态复活。

**Session Complete 特判**: terminal 分类归 `external-session/turn-lifecycle.ts::markExternalSessionComplete()`。`!turnCompleted && currentTurnStartTime === 0` 判为 pre-warm exit(进程 spawn 后、首轮 turn 开始前崩溃),静默吞掉错误 — 下一条用户消息会走正常启动路径重试；idle death、intentional user stop、success finalization 也由该 owner 返回 plan，`external-session.ts` facade 只落地 broadcast / persistence / cleanup。

### 并发与序列化

所有 external ingress 在进入 Case 1/2/3 前先形成一个 message operation。operation 自己持有 user `SessionMessage` 与其 projection state；direct send 通过既有 promise tail 串行 claim，turn-boundary queue 继续由同一 generation/drain reservation 管理，realtime steer 也携带同一 operation 直到 runtime user echo。未持久化的 loser 只撤回自己的 message id；已经持久化或 transport termination 未确认的 turn 不做猜测性撤回。该结构保留原有 optimistic bubble、`queue:added` / `queue:started` 时序、queue generation 与 exact Stop 语义。

`sendExternalMessage` 在分派 Case 1/2/3 之前有四道 gate:

1. **Start 并发 gate**:`await startingPromise` 等待任何在飞的 `startExternalSession`(包括 pre-warm)完成。否则用户消息可能在 `isRunning=true && activeProcess=null` 的中间态被错分到 Case 2,触发 "session already running" 静默丢弃。
2. **Turn 序列化 gate**:`!turnCompleted && currentTurnStartTime !== 0 && activeProcess` → `waitForExternalSessionIdle(5 分钟, 100ms)`。持久进程运行时(Codex/Gemini)一次只接一个 turn,并发 `turn/start` / stdin 写入会出现 drop 或交错输出。崩溃恢复路径通过 `resetTurnAccumulators()` 把 `currentTurnStartTime` 归零,此 gate 不会误触。例外只存在于桌面 realtime + Codex `turn/steer`:它不走 `sendExternalMessage` 新 turn 路径,而是由 `enqueueExternalSendForDesktop` 调 optional `runtime.steerMessage()` 追加到当前 turn。
3. **Turn finalization gate**(`TurnFinalizationGate`,`external-turn-finalization.ts`,实例由 `external-session/turn-lifecycle.ts` 持有):`turnCompleted` 翻 true 时 fire-and-forget 的 `persistTurnResult()` 可能仍在 await 窗口内(assistant 消息尚未 push 进 transcript owner/落盘)。旧实现里 `turnCompleted` 一旗三义("terminal 事件已发"/"可接下一轮"/"回复可读"),导致 cron/IM 读到上一轮回复、背靠背 send 冲掉未持久化的内容块。gate track 每个 finalization promise;send 侧 `settled(60s)` 有界等待后才绑定本轮 meta,降级放行时依赖 `persistTurnResult` 的**同步入口快照纪律**(inboxMeta/hints/contextUsage/contentBlocks/assistantText 全部在首个 await 前捕获)+ identity 守卫的 reset,最坏只乱序不丢消息。Phase8 后：terminal success/failure/prewarm/idle/user-stop plan 由 `turn-lifecycle.ts` 分类；content snapshot 由 `content-blocks.ts` 生成；user/assistant append、retry truncate、last assistant read、SessionStore save 由 `transcript-persistence.ts` 拥有；IM registry 与 inbox/watch error delivery 由 `interactive.ts` 拥有。
4. **Goal/Task dispatch gate**：带 `beforeDispatch` 的 scheduler/user turn 在 external facade 的 promotion 边界原子 claim。guard accepted 前不得 surface bubble、写 transcript/SessionStore、启动 watchdog 或标记 running；新 turn 开始 guard 时由 `turn-lifecycle.ts` 建立 promotion token，所以 `isBusy` / `waitIdle` 不会把 claim 窗口误判 idle。accepted 后 token 贯穿 metadata/persistence/config 等 await，并在最终 transport 前复核。Stop 原子 invalidate token，但 cancel token 本身不是停止确认：caller 必须等待 promotion 结算为 `not-dispatched | dispatched | terminated | termination-unconfirmed`；fresh/resume startup 尚未返回 process 时也要等 `_doStartExternalSession` 完成。`not-dispatched` 保留 shared prewarm process，`dispatched` 继续精确 stop，只有 `terminated` / 已确认未派送才可释放 owner；`termination-unconfirmed` 保留 process + queue binding。fresh/resume 不能把 prompt 作为 `startSession(initialTurn)` 的隐式副作用交给尚未归属的进程：必须先省略 `initialTurn` 完成 start/resume、注册 active process、复核 token，再显式调用 `runtime.sendMessage`。一旦调用 runtime transport，任何 throw 都可能只是 ack 丢失；必须尝试 stop，未确认终止时不得把它降格为普通 send failure或清 binding。pre-warm Case 3、turn queue drain、realtime steer fallback 同样走该 token；active realtime steer 已由当前 running turn 持有 Stop owner，guard 后不跨 await 直接调用 transport。guard reject 只取消待派送项，不得留下一个本地“假 turn”。

### 安全机制

| 机制 | 说明 |
|------|------|
| **并发守卫** | `startingPromise` 序列化并发 `startExternalSession` 调用 |
| **Turn 序列化** | 持久进程 runtime 下,新消息等待上一个 in-flight turn 结束再派送 |
| **Turn finalization** | `TurnFinalizationGate`:idle 判定与下一轮派送等待 fire-and-forget 的 `persistTurnResult` settle,防读到上轮回复/冲掉未持久化消息(见上方 gate 3) |
| **Process/turn 分离** | `sessionState`/`isBusy`/`waitIdle` 只表达 turn；`hasExternalRuntimeProcess` 单独表达 persistent process liveness，pre-warm idle 不阻塞自动回合 |
| **看门狗** | **Per-turn**(不是 per-process):pre-warm idle 不计时,turn 启动才启动计时器。10 分钟无活动 → kill |
| **Stale text 防护** | `lastTurnSucceeded` 标志,cron/heartbeat 路径检查,防止崩溃后返回上一轮旧回复 |
| **用户消息即时落盘** | 发送后立即通过 `transcript-persistence.ts::persistExternalUserMessageAppend()` 携带 SessionStore cursor 追加 exact tail，崩溃不丢用户消息；stale cursor 先 rehydrate，`unindexed-create-refused` 视为发送失败而不是 log-only |
| **Token 用量** | `thread/tokenUsage/updated` 作为 running-total fallback，与持久化 baseline 做 diff；0.146+ 完整 raw usage 作为 turn delta 累加入同一 baseline。旧 baseline 无法分离历史 cache，fallback 不记 cache 细分，避免把历史量误记到当前 turn |
| **Cross-runtime 守卫** | pre-warm / restore / send 路径均用 `SessionMetadata.runtime` 校验,阻止跨 runtime 污染 |

## Runtime 诊断 + envPolicy（PRD 0.2.16）

外部 Runtime 在 MyAgents 容器内的行为不一定等同于用户终端里直接跑——env、proxy、shell 探测、PATH 都可能差异化。诊断面板把这些差异显式 surface 出来，env policy 让用户在三种 env 注入策略间切换。

### 诊断收集（Codex）

`startSession` 完成 `thread/start`（managed-provider 还需完成一次 ready / degraded MCP soft settlement）之后 **fire-and-forget**（不额外 block 首轮 turn）调用四个 Codex app-server RPC：

| RPC | 用途 | 类型 |
|-----|------|------|
| `getAuthStatus` | OAuth / API key 配置状态 | `RuntimeAuthStatus` |
| `experimentalFeature/list` | 启用 / 已变更的 feature flag | `RuntimeFeatureFlag[]` |
| `mcpServerStatus/list` | MCP server 健康状态（auth / failed / oauth-required） | `RuntimeMcpServerInfo[]` |
| `app/list` | 已配置的 connector（artifact-tool / github 等）+ 可访问性 | `RuntimeAppInfo[]` |

每个 RPC 独立 `tryCall` + 5s 超时，单点失败不级联。统一 `RuntimeDiagnostics`（含 `status: RuntimeDiagnosticsCallStatus` 四元组 + `effectiveEnv: RuntimeEffectiveEnv`）通过 `wrappedOnEvent({ kind: 'runtime_diagnostics' })` → SSE `chat:runtime-diagnostics` → `TabProvider.setRuntimeDiagnostics()` 到 React。

Managed Codex 还把 Product Extension 的 desired/effective revision 与逐组件结果合并进同一个 `RuntimeDiagnostics.extensions`，不建立第二条状态通道。Chat banner 只依据顶层 failed 生命周期决定是否展示；Renderer 不得把逐组件 `failed` / `unsupported` 或 `requiresUserAction` 猜成被动阻断。`pending_next_start` 静默等待下一次 Runtime 启动，`deferred_until_idle` 与生产方标记的 `requiresUserAction` 仅由本次配置操作的轻量提示表达。持久诊断只保存真实 generation 状态；`unchanged` 仅是配置操作的即时返回值。语义相同的 extension 投影不得刷新 Runtime producer 的时间戳，也不得重复写入、记日志或广播 `chat:runtime-diagnostics`。当顶层仍为 `applied` 时，单个 `failed` / `unsupported` 组件表示该可选条目已被安全跳过，只保留结构化诊断和有界 Logs panel 摘要，不打扰普通对话。

Codex MCP 工具目录走独立的可变快照：adapter 记录当前 thread 的 `mcpServer/startupStatus/updated`，短合并窗口后按 threadId 分页调用 `mcpServerStatus/list`，仅把 ready 且无需登录的 server 中由 Codex 实际返回的 tool 映射为 `mcp__<server>__<tool>`。目录变化发 `runtime_tool_catalog`；`external-session` 更新其 system-init replay snapshot 并广播 `chat:runtime-tool-catalog`，所以活跃 Tab 实时更新，重连则从同一 owner 快照恢复。该链路只读，不修改 Codex 配置；查询失败保留仍处于 ready 的上一份目录，明确的 failed / cancelled 通知立即撤回对应 server，不依赖后续查询成功。

**Session-life gate**：广播前检查 `codexProc.exited || codexProc.intentionalKillDuringStartup`——5–10s 的诊断窗口期内若用户已切 tab / kill session，stale event 不允许闪到切走的 tab（详见 `codex.ts::startSession` 末尾的 fire-and-forget 块）。

### `chat:runtime-diagnostics` SSE 事件

注册位置：`src/renderer/api/SseConnection.ts::JSON_EVENTS`。前端消费：`RuntimeDiagnosticsBanner.tsx`——仅在真正阻断时显示：认证阻断、producer 标记的 severity error 或顶层扩展应用失败。Renderer 不得按失败数量、逐组件状态或 actionability 自行提升 severity。单项 RPC、App、MCP、逐组件扩展异常进入结构化诊断与 Logs panel，不单独打断对话；展开区也只把实际触发顶条的问题列为 Problems，不把成功组件冒充故障上下文。

**MCP `state` 派生**：`RuntimeMcpServerInfo.state` 不是直接由 Codex 返回的，而是 `codex.ts` 内部从 `authStatus` 派生。当前 Codex schema 的 `notLoggedIn` 是不可用态；`oAuth` / `bearerToken` 是已认证态，不能按字符串含 `oauth` 误判失败。兼容旧 payload 时仅把明确的 `failed / error / unauthenticated / needs / required` marker 视为 unhealthy。**新增 MCP 健康检测逻辑 MUST 走这条派生链而不是在 banner 端散写 filter**。

### `RuntimeEnvPolicy.proxy` 两档语义（`env-utils.augmentedProcessEnv`）

| 字面量 | 行为 | 适用场景 |
|--------|------|---------|
| `'myagents'`（默认） | 继承 Sidecar 的 `process.env` proxy var——Rust 侧 `proxy_config::apply_to_subprocess` 已在 Sidecar 启动时注入了用户在 MyAgents 设置里配的 proxy | 绝大多数用户；MyAgents 提供一站式 proxy 管理 |
| `'terminal'` | 剥掉继承的 proxy var，恢复用户 interactive shell 在 `~/.zshrc` / `~/.bashrc` 里 export 的（warmup 时 `shell.ts::warmupShellPath` 抓的 8 个 var：`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` × 大小写）；语义上等同于"用户在自己电脑的终端里手动启动这个 CLI 时看到的 env" | 用户终端能调某个 endpoint 但 MyAgents 里调不到（issue #194 原始场景）；用 Clash TUN / VPN 等系统层路由的用户也走这档（shell 通常没 export proxy → 等同于无 proxy） |

**未知字面量 → fallback 到 `'myagents'`**（`env-utils.ts::augmentedProcessEnv` 防御纵深；Codex review #5 catch）。

**0.2.16 dev 历史**：曾短暂存在第三个 `'direct'` 字面量（剥掉所有 proxy var），dogfooding 反馈"三个选项太复杂"后在 0.2.16 release 前移除。已存盘的 `'direct'` 在 `resolveAgentEnvPolicy` 校验白名单里 fallback 到 `'myagents'`（UI 会显示选中"MyAgents 代理"，依赖 strip 行为的用户可手动改成"跟随终端"——shell 里没 export proxy 时效果与原 `'direct'` 一致）。

**校验入口统一**：disk 上的 `agent.runtimeConfig.envPolicy.proxy` MUST 通过 `env-utils.resolveAgentEnvPolicy(workspacePath)` 读，**禁止**裸 `raw as RuntimeEnvPolicy` cast——后者会让 `proxy: 'evil_value'` 这种 typo 在诊断面板上显示成 `'myagents'`，对用户隐藏 misconfig。两个调用点（`external-session.ts` 会话启动 + `admin-api.ts` CLI diagnose handler）现已统一走这个 helper。

### `RuntimeEffectiveEnv` snapshot

每次诊断收集都附带一个 `effectiveEnv` 快照：

```typescript
{
  proxyPolicy: 'myagents' | 'terminal' | 'direct',
  httpProxy?: string,
  httpsProxy?: string,
  allProxy?: string,
  noProxy?: string,
  pathFirstSegments: string[],  // 前 5 段 PATH，验证 NVM/fnm/volta 入选
  cwd: string,
  shell: string,
}
```

用户在 banner 展开后能看到自己 envPolicy 选择实际生效成什么样——`'terminal'` 模式下 `httpProxy` 为空意味着用户 shell 也没 export，不是 bug。

### CLI 自助诊断

```bash
myagents runtime diagnose codex --workspace=<path>   # 主形式
myagents diagnose runtime codex --workspace=<path>   # 别名糖
```

调用 `admin-api::handleRuntimeDiagnose`——spawn 一个短命 `codex app-server` 进程跑 initialize + 4 个 RPC，结构化 JSON 输出可直接贴 issue。CLI 路径同样走 `resolveAgentEnvPolicy` 拿 envPolicy，所以诊断结果反映**真实会话**会看到的 env，不是 baseline。

详见 `tech_docs/cli_architecture.md` 的「`diagnose` 顶层组」节。

### 跨 commit 交互

- **Cron + envPolicy**：cron 走 external runtime 时（`cron/execute` → external-session.ts），envPolicy 通过 `resolveAgentEnvPolicy` 自动从 agent 配置读，与会话路径一致
- **builtin runtime + envPolicy**：envPolicy 当前**只**作用于外部 runtime。builtin SDK 走 `buildClaudeSessionEnv()` 自己的 proxy 路径，envPolicy 设置对 builtin 静默无效（设计意图，但用户视角不显式——若收到困惑反馈考虑加 UI hint）

## 功能门控链路

```
config.multiAgentRuntime (磁盘/React state)
  │
  ├── Rust sidecar/runtime_identity.rs: resolve_agent_runtime_from_config()
  │     → 仅当 multiAgentRuntime=true 时读取 agent.runtime
  │     → sidecar/session_lifecycle.rs 或 sidecar/instances.rs 在 spawn 时注入 MYAGENTS_RUNTIME
  │
  ├── Node factory.ts: getCurrentRuntimeType()
  │     → 读取 process.env.MYAGENTS_RUNTIME
  │     → 未设置 → 'builtin'
  │     → 识别 'claude-code' | 'codex' | 'gemini'
  │
  └── React Chat.tsx:
        const currentRuntime = multiAgentRuntimeEnabled
          ? (currentAgent?.runtime || 'builtin')
          : 'builtin';  // ← 源头门控，下游自动安全
```

## 跨 Runtime Session 保护

当用户关闭功能后打开外部 Runtime 创建的历史 session：

1. **服务端** (`agent-session.ts:initializeAgent`)：检测 `meta.runtime !== 'builtin'` → 设 `sessionRegistered=false` → 跳过 SDK resume（避免 "No conversation found" 崩溃）
2. **前端** (`Chat.tsx`)：检测 `isCrossRuntimeSession` → 发消息时弹 ConfirmDialog → 用户可选择新开会话或留在当前页浏览历史
3. **Fork/Rewind**：Codex 在能力版本满足且消息持有精确 root-turn anchor 时支持；Claude Code / Gemini 仍由前端隐藏并在服务端返回 unsupported

## Context 用量归一化（PRD 0.2.32）

实时「当前 context 窗口用量」指示器（对话框 model 选择器左侧的环 + hover 卡片）。四个 runtime 取数姿势不同，但都收敛到一个归一化纯函数 + 一个 SSE 事件 + 一个前端组件。

**核心不变量**
- **占用 = 最近一次 API 调用的 input 系 token，不是整 turn 聚合**。带工具的一轮发多次 API、每次重发上下文，聚合会严重高估（圆环钉死在 ~100%）。
- **两系 cache 语义相反**：Anthropic 系（builtin / Claude Code）`input` 不含 cache → `input + cacheRead + cacheCreation`；OpenAI 系（Codex）`inputTokens` 已含 cached → 直接用，不再加。
- **分母 = `runtime 报的窗口 ?? lookupModelContextLength(model) ?? 200K`**，永远有值，表示模型的有效完整窗口；builtin 会在该窗口的 90% 处自动压缩，external runtime 保留自己的压缩策略。

OpenAI Bridge 属于 builtin 的协议适配边界：OpenAI Chat / Responses 返回的 total input 已包含 cache read / write，Bridge 必须先转换成 Anthropic 的互斥分区：`ordinary = total - read - create`，再把 ordinary/read/create 交给 SDK。下游仍统一按 builtin 的 `input + cacheRead + cacheCreation` 求占用，恰好还原 OpenAI total，不能直接把 OpenAI total 填进 Anthropic `input` 后再次加 cache。异常负数、非有限值或 cache 分区超过 total 时在 Bridge 边界归零/夹紧并记录仅含字段名与归一化数值的 warning，不把 raw provider payload 写入日志。

**每 runtime 占用来源**

| Runtime | 占用 | 窗口 | 备注 |
|---|---|---|---|
| builtin | `agent-session.ts` 捕获最近一条**主轮**（非子 Agent）assistant message 的 `input+cache`（`broadcastBuiltinContextUsage`）| `lookupModelContextLength ?? 200K`（**不**用 SDK `ModelUsage.contextWindow`——对 bridge 第三方模型只回落 200K，与注入的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 不一致）| `windowSource: registry|default` |
| Codex | `tokenUsage.last.inputTokens`（`mapCodexTokenUsage`，纯函数可测）；`total` 仍喂 watchdog | `tokenUsage.modelContextWindow`（`windowSource: runtime`）| 通知 turn 中流式到达 → 亚轮实时刷新 |
| Claude Code | 最近一条主轮 assistant message 的 `input+cache`（`lastMainAssistantUsage`，**不**用 `result.usage`——那是整 turn 累计）| registry ?? 200K | |
| Gemini | `_meta.quota.token_count.input_tokens`（per-request）| registry ?? 200K | |

**统一通道**：每个 external adapter 在 `kind:'usage'` UnifiedEvent 上显式带 `contextOccupiedTokens` + `runtimeContextWindow`（`types.ts`）。`external-session.ts` 的 `usage` 分支**只用显式 `contextOccupiedTokens`**（缺失则不发——宁可不显示也不显错，避免把 Codex running_total / CC 累计当占用），过 `computeContextUsage` 归一化后 `broadcast('chat:context-usage', ...)`。builtin 走 `agent-session.ts` 旁挂 `chat:message-complete` 广播。前端 `TabProvider.contextUsage`（tab-scoped，session 切换由 `currentSessionId` effect 重置，见下）→ `<ContextUsageIndicator>`（自取数，不穿 SimpleChatInput props）。

**持久化 + 重开恢复**：turn 末算的同一快照既 broadcast、也写进 `SessionMetadata.lastContextUsage`（builtin 在 `updateSessionMetadata`；external 在 `persistTurnResult` 末——turn-scoped 快照须在**同步函数入口**捕获，否则背靠背 `sendExternalMessage` 会在 await 窗口被 `resetTurnAccumulators` 清空而丢盘）。重开会话由 `restorePersistedSession` 从后端 seed，前端规则即「进入会话 `display = lastContextUsage ?? null`」（reset/adopt 才 clear，不再无脑清 null）；seed **仅当 `lastContextUsage.source === session.runtime`** 生效，防 stale builtin 快照把压缩按钮显示到 external 会话。

**智能压缩入口**：卡片按钮按 Runtime capability 注入，builtin 复用 `Chat.tsx` 正常发送链路发 SDK `/compact`（`effectiveModel`/`effectivePermissionMode`/`providerEnv` 同参）；Managed Codex 与斜杠菜单共用 SessionEngine 原生 compact 控制操作。两条路径都复用既有 `chat:system-status` 的 compacting/success/failed 投影，运行中禁用按钮。Claude Code、System Codex 与 Gemini 不注入按钮。纯函数 `computeContextUsage` 见 `src/shared/contextUsage.ts`，单测 `contextUsage.test.ts` + `codex-token-usage.unit.test.ts`。

## 文件索引

| 文件 | 职责 |
|------|------|
| `src/server/runtimes/types.ts` | AgentRuntime 接口 + UnifiedEvent 类型（含 PRD 0.2.32 `contextOccupiedTokens`/`runtimeContextWindow`）|
| `src/shared/contextUsage.ts` | `computeContextUsage` 归一化纯函数（PRD 0.2.32）|
| `src/server/runtimes/codex-token-usage.ts` | Codex running-total/context schema 解析 + 0.146+ 逐 response 精确 usage 聚合纯函数 |
| `src/renderer/components/ContextUsageIndicator.tsx` | Context 用量环 + hover 卡片 + 智能压缩入口（PRD 0.2.32）|
| `src/server/runtimes/factory.ts` | Runtime 工厂 + 检测 |
| `src/server/runtimes/claude-code.ts` | CC Runtime 实现(NDJSON 协议) |
| `src/server/runtimes/codex.ts` | Codex Runtime 实现(JSON-RPC 2.0) |
| `src/server/runtimes/gemini.ts` | Gemini Runtime 实现(ACP JSON-RPC 2.0 + `GEMINI_SYSTEM_MD` 合并注入) |
| `src/server/runtimes/external-session.ts` | 外部 Runtime public facade + high-level orchestration |
| `src/server/runtimes/external-session/*` | 外部 Runtime lifecycle / config / queue / turn / content / transcript / interactive owners |
| `src/server/provider-types.ts` | Runtime-neutral `ProviderEnv` 类型 |
| `src/shared/types/tool-input.ts` | Sidecar 与 Renderer 共用的 `ToolInput` wire 类型 |
| `src/server/session-core/runtime-config-policy.ts` | builtin/external runtime config snapshot/source guard + external runtime config patch policy |
| `src/server/session-core/turn-result-policy.ts` | terminal / injected turn 成败判定：builtin SDK 仅 `completed`（及旧 payload 缺失 reason）成功，abort 映射 stopped，其余未知 reason fail closed；external 同样只以真 turn 成功为 success |
| `src/server/session-core/session-activity-policy.ts` | admission/terminal meaningful activity 判定；human/visible classifier 不拥有 recency |
| `src/server/session-core/heartbeat-ack.ts` | Heartbeat terminal ack remainder 解析纯函数 |
| `src/server/session-core/turn-queue.ts` | desktop realtime / turn-boundary queue admission、取消、turn owner 结果与 force-start 纯规则 |
| `src/server/session-core/mcp-sync-policy.ts` | MCP authority、稳定 fingerprint、snapshot restart 决策 |
| `src/server/runtimes/env-utils.ts` | 环境变量增强：`augmentedProcessEnv(policy)` 三档 proxy 策略 + `resolveAgentEnvPolicy(workspacePath)` 共享校验入口（PRD 0.2.16） |
| `src/server/utils/shell.ts` | 用户 interactive shell PATH + 8 proxy var warmup（PRD 0.2.16，供 `'terminal'` 模式回写） |
| `src/renderer/components/RuntimeDiagnosticsBanner.tsx` | 诊断面板（PRD 0.2.16，只在 unhealthy 时显示） |
| `src/server/runtimes/tool-attachments.ts` | `saveToolAttachment` 落盘 helper + in-flight tracker + external-path registry（PRD 0.2.15） |
| `src/server/utils/path-safety.ts` | Node 镜像 Rust `validate_file_path` 黑名单 + canonicalize symlinks（PRD 0.2.15） |
| `src/shared/types/tool-attachment.ts` | `ToolAttachment` 共享类型（PRD 0.2.15） |
| `src/shared/types/runtime.ts` | 共享类型（RuntimeType、模型列表、权限模式） |
| `src/renderer/components/RuntimeSelector.tsx` | 前端 Runtime 选择器组件 |
| `src/server/runtimes/claude-code.ts` → `FORWARDER_SCRIPT` | CC SessionStart hook 转发脚本（运行时生成至 `~/.myagents/.cc-hooks/forwarder.cjs`） |
### 全局 Skill compatibility projection 准入

所有会从 workspace `.claude/skills/` 原生发现 Skill 的 external Runtime，都在 process start 与下一 turn admission 复用 Node `global-skill-inventory.ts` 的一次 immutable 快照完成 projection reconcile。Managed Codex 还把同一快照的 canonical 内容直接交给 extension compiler，禁止 compiler 再扫描一份 global root。损坏、缺失或无法投影的 Skill 只淘汰对应候选并写日志；Runtime 与 Session 继续启动。external lifecycle owner 随 active process 保存其启动时采用的 effective capability/projection revision；下一次 admission 发现 revision 变化时，沿既有 process config invalidation 在 idle/terminal 边界换代，不中断 active turn。是否换代不依赖本 Sidecar 的 reconcile 是否产生磁盘写入，因此共享 workspace 上由另一 Sidecar 先完成链接收敛也不会复用旧 winner。不得在 adapter 内另建扫描、cache 或 watcher。
