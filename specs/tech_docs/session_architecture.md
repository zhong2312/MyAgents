# Session 架构

> Session 的标识、存储、状态同步机制。Sidecar Owner 模型、Session 切换四场景见 `ARCHITECTURE.md` 的核心抽象与模块地图。

## Session ID

每个 Session 由一个 UUID v4 标识，作为消息存储、前端展示、SDK 上下文恢复的统一 key。SDK 通过 `query({ sessionId })` 接收并使用此 UUID 作为它内部的 session_id，两端 ID 始终一致。

### 数据结构

```typescript
interface SessionMetadata {
    id: string;                 // UUID v4
    agentDir: string;           // 工作区路径
    title: string;
    createdAt: string;
    lastActiveAt: string;
    sdkSessionId?: string;      // SDK session_id（统一架构下 === id）
    unifiedSession?: boolean;   // true = 当前架构创建
    stats?: SessionStats;
    cronTaskId?: string;
    runtime?: RuntimeType;      // 'builtin' | 'claude-code' | 'codex' | 'gemini'
    runtimeSessionId?: string;  // external runtime thread/session id（Codex threadId 等）
    // 分层 config snapshot 字段（owned session 冻结）
    model?: string;
    // #324 推理强度：存字面 'default' | level（'default' 是有意义的值——session
    // 显式回退默认可盖过 agent 级非默认值；owned session 下 undefined =
    // 产品默认/未 pin，不得静默回落 agent）。变更经
    // /api/reasoning-effort/set（external 分流）；Anthropic 协议 effort 是
    // query() spawn 选项 → 变更走 abort+prewarm / deferred restart（reason:
    // 'reasoning-effort'）；OpenAI 协议经 bridge live resolver 每请求注入。
    // 注意：刻意没有 mount 期 push effect（sidecar 自解析 + send payload 兜底
    // 已覆盖，mount push 会让 Anthropic 协议双付 respawn）。
    reasoningEffort?: string;
    permissionMode?: PermissionMode;
    mcpEnabledServers?: string[];
    enabledPluginIds?: string[];
    providerId?: string;
    providerRoute?: ProviderRoute; // canonical builtin provider/model identity
    providerEnvJson?: string;      // read-only legacy fallback; new route snapshots do not persist env
    configSnapshotAt?: string;  // 存在即 owned snapshot；读侧不得用 Agent 补 owned 缺字段
    materializationState?: 'prepared'; // pending->real 两阶段 materialize、runtime-backed 首 query 前草稿隐藏行
    materializationSourceSessionId?: string; // prepared 来源 pending/desktop draft id
}

interface SessionStats {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}
```

`configSnapshotAt` 是配置权威边界：存在时，session snapshot 拥有当前会话配置；缺字段不是“自动读 Agent 默认值”的许可。Agent/Project 只作为新 session 模板、legacy/no-snapshot 兼容源、以及 IM 无 Tab owner live-follow 源。

`lastActiveAt` 表示 Session 最近一次 meaningful activity，是历史排序时间，不是真人输入时间，也不是任意 transcript 写入时间。被 turn lifecycle 真正接纳的普通 desktop、Space、Task/Cron/Goal、Session Inbox 等工作在 admission 推进一次，并在 complete/stopped/error terminal 再反映终态时间；Memory、silent Heartbeat、prewarm、replay、纯持久化重写与 system maintenance Session 不推进。Heartbeat 只有携带 visible work，或终态在移除 `HEARTBEAT_OK` 与格式空白后仍有内容时才算 meaningful。`isHumanUserMessage` 只服务真人 query/Memory/统计语义，不拥有 recency。用户显式编辑 title/model/permission/provider 等 Session 设置仍可由 metadata PATCH 推进排序时间，favorite 不推进。`SessionStore.updateSessionMetadata` 在 sessions file lock 内保证 `lastActiveAt` 单调不回退；读取方若需要真人 query 时间，必须按 JSONL message timestamp 精确判断，不能用 `lastActiveAt` 预筛。

`providerRoute` 是 owned builtin snapshot 的 canonical provider/model 身份。它只持久化 `{kind, providerId, model}`，不持久化 `baseUrl`、`apiKey`、`authType`、`modelAliases` 等运行时 env。真正发起请求时，Sidecar 用 `providerRoute` + 当前磁盘配置 materialize 出 `ProviderEnv`；subscription route materialize 为 `'subscription'` sentinel，API route 必须能从当前配置解析出 API key，否则本次发送失败并提示用户修复配置。

`providerEnvJson` 已降级为 read-only legacy fallback：只有没有 concrete `providerRoute` 的旧 session 才会读取它。新写入路径（Tab snapshot、session freeze、IM detach、Task new-session initialization）必须写 `providerRoute` 并清空/省略 `providerEnvJson`，避免把密钥、baseUrl 或 alias 冻结进历史会话。第一轮把 legacy/no-snapshot session promote 成 owned snapshot 时，baseline + 显式 patch 必须基于最新 metadata 写入，避免并发 config edit 用旧 baseline 覆盖已提交字段。

旧 `model + configSnapshotAt` 但缺 provider 身份的 session 只做确定性自修复：在“声明了该 model 且本地有凭据/账号证据”的 provider 集合里匹配。API provider 的凭据证据是非空 `apiKeys[providerId]`；Anthropic subscription 的账号证据是 verify status valid、或记录过 `accountEmail`、或记录过 `verifiedAt`。修复不检查 provider enabled，也不实时校验 token/余额。唯一候选则静默写回 `providerRoute`；多个或没有候选时，前端模型选择器进入“需重新选择模型”的状态，发送会被拦截，用户感知是需要手动重新选一次模型，而不是消息无响应或错路由。

### Session ID 前缀约定

| 前缀 | 格式 | 用途 | 何时生成 |
|------|------|------|---------|
| 无 | UUID v4 | 标准 session | `createSessionMetadata()` / 首条消息 |
| `pending-` | `pending-{tabId}` | 新 Tab 占位符 | Tab 创建时，等待首条消息产生真实 UUID |
| `cron-standalone-` | `cron-standalone-{uuid}` | 独立定时任务 | 创建不绑定 Tab 的定时任务 |

### SDK `sessionId` 与 `resume` 互斥

SDK 约束：`sessionId` 和 `resume` 参数不能同时传递。

```typescript
querySession = query({
    prompt: messageGenerator(),
    options: {
        // 新 session：传 sessionId 让 SDK 使用我们的 UUID
        // 历史 session：传 resume 恢复对话上下文
        ...(resumeFrom
            ? { resume: resumeFrom }
            : { sessionId: sessionId }
        ),
        // 可选：rewind 截断点（与 resume 配合）
        ...(rewindResumeAt
            ? { resumeSessionAt: rewindResumeAt }
            : {}
        ),
    }
});
```

### Resume 的真正用途

持久 Session 架构下（`messageGenerator()` 全程 `while(true)` yield），`resume` 不是每轮对话的机制，仅用于：

| 场景 | 说明 |
|------|------|
| 恢复历史 session | 用户从历史记录切换到旧 session |
| Rewind 后截断历史 | `resumeSessionAt` 截断 SDK 消息树 |
| Subprocess crash 恢复 | `finally` 块触发 `schedulePreWarm()` 重建 session |
| 配置变更重启 | MCP / Agent 变更导致 session 中止后恢复 |

`resumeSessionAt` 是 `resume` 的精确截断锚点，不是 session 存在性的证明。SDK
会用自己的 transcript 链校验该 UUID；若 SDK 拒绝锚点（`No message found with
message.uuid`），MyAgents 必须清掉该 stale anchor 并降级为裸 `resume`。这类恢复
是内部一致性降级：保留日志用于排障，但不向用户 toast / Agent Error。

### Session 间事件协议（send / watch）

`myagents session send` / `watch` 不是普通文本拼接，而是结构化的 session event
协议。CLI 经 `/api/admin/session/*` 进入当前 Sidecar，事件统一渲染为
`<myagents-session-event ...>` prompt，正文 payload 先经过结构标签 neutralize，
避免被跨 session 内容伪造协议边界。

| 事件 | 语义 | 投递路径 |
|------|------|----------|
| `send.request` | 源 session 给目标 session 投递工作或通知 | 源 Sidecar → Management API `/api/inbox/deliver` → 目标 Sidecar |
| `send.result` | 目标 turn 结束后把结果回推给源 session | 目标 Sidecar turn terminal → Management API → 源 Sidecar |
| `watch.already_idle` | 注册 watch 时目标已无活跃 turn，立即返回最近结果 | 调用方 Sidecar 本地生成 event prompt |
| `watch.completed` | watch 注册时目标正在运行，该 turn 正常 terminal 后回推结果 | 目标 Sidecar pending watch registry → Management API → watcher Sidecar |
| `watch.error` | 被 watch 的目标 turn 中止、错误或无法确认正常完成 | 同 `watch.completed` |

`watch` 的 owner 分两层：Rust Management API 先用 live sidecar 表确认目标 session
是否仍在运行，并在目标 sidecar 上注册 pending watch；目标 sidecar 只在 turn terminal
时调用 `deliverSessionWatchEvents()` 生成最终事件。只有 watcher sidecar 确认 inbox
delivery 成功后，目标 sidecar 才 ack 并清理 pending watch；Management API 暂时不可用
时保留待重试，避免完成事件丢失。

Space Registered Agent 的 `space.issue_delivery` 复用 inbox 的 `sessionEvent`
metadata 来选择 registered-agent scenario 和 lazy session materialization，但最终
prompt 不走通用 `<myagents-session-event>` 外包。Rust Space owner 会直接渲染
`<system-reminder><myagents-space-issue><myagents-space-event ...>` user message，
让前端隐藏内部处理指令并显示 `Space issue` badge。这个特例只适用于 Space Issue
delivery，不改变 `myagents session send/watch` 的通用事件协议。`system-reminder`
的通用隐藏 payload / badge / visible tail 规则见
`system_reminder_protocol.md`。

### Desktop 连续 Query 队列模式（0.2.37）

内置 AgentSDK 的桌面 `/chat/send` 支持两种连续发送策略，由
`AppConfig.chatQueueResponseMode` 控制，默认值为 `realtime`：

| 模式 | 语义 | 队列归属 |
|------|------|----------|
| `realtime` | 保持旧行为：当前 turn 忙时尽快把 query 投递给 SDK，让 SDK 在持久 `messageGenerator()` 中尽早消费 | 原 `messageQueue` / `pendingMidTurnQueue` / in-flight slot |
| `turn` | 轮次响应：只有上一轮完整 terminal（complete / stopped / error）后，才把下一条 query 投递给 SDK | 独立 `turnBoundaryQueue` |

隔离边界：

- 只有 `/chat/send` 调 `enqueueUserMessage(..., { fromDesktopChatSend: true })` 时读取该设置；IM / Task / Inbox drain / external runtime 继续走原有实时语义。
- `turnBoundaryQueue` 不直接复用 `messageQueue` 的 mid-turn 投递语义；它只在 clean turn boundary 由 `startNextTurnQueuedItem()` 启动，避免轮次模式污染实时模式。
- 一旦 `turnBoundaryQueue` 或 turn-mode admission ticket 已存在，后续同 session 的桌面 `/chat/send` 忙时发送必须继续排到 turn boundary；非桌面来源不读取该 UI 设置，保持各自既有队列语义。
- abort / stop / crash recovery 必须同时清理或恢复 `messageQueue`、`pendingMidTurnQueue`、`turnBoundaryQueue` 和 admission ticket，避免只处理旧队列造成 orphan query。

规则 owner：`src/server/session-core/turn-queue.ts`。副作用 state owner：`src/server/builtin-session/queue.ts`。`agent-session.ts` facade 负责把 enqueue / cancel / force / terminal orchestration 接到 SDK、SSE、IM reply 等副作用，但 queue 数组、in-flight slot、turn admission ticket 不再作为 facade 顶层裸状态维护。admission、cancel location、force-start reordering、abort ticket 清理必须继续调用 `turn-queue` policy。

### Goal Mode Session State（0.3.0）

Goal 是 current Session 的独立持久状态，物理存储为 `~/.myagents/session_goals.json`，不嵌入 `SessionMetadata`，也不复用 Task/Cron：

```typescript
type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'canceled';

interface SessionGoalView {
  id: string;              // current Goal incarnation fence
  sessionId: string;       // product lookup key
  workspacePath: string;
  objective: string;
  status: GoalStatus;
  turnCount: number;
  revision: number;
  controlRevision: number;
  isExecuting: boolean;
  totalDurationMs: number; // 已结算 Goal Turn 的实际执行耗时之和
  totalTokens: number;     // 已结算 Goal Turn 的 input + output tokens 之和
  terminalReason?: string;
}
```

#### 权威边界

- `SessionGoalManager` 是 Goal 唯一业务 owner。同一 Session 最多一个 unfinished Goal；已终态 Goal 可被下一次 create 替换。
- Goal 不持有 taskId、Cron schedule、tab、runtime/model/provider/reasoning/MCP 或普通 delivery。Session 继续拥有运行配置，Goal 只保存 permission turn policy。
- UI `/goal`、当前 Session 内的 `myagents goal create`、私聊 IM/Agent Channel 都写同一 Goal。创建前必须 materialize 真实 Session id；Rust 拒绝 `pending-*`，没有 post-hoc rebind。
- Goal 与 Task 可以关联同一 Session。二者不互相引用，实际 Turn 顺序由现有 Runtime queue 决定。

#### Turn authority

Node queue 是所有待发送消息的唯一队列。Rust 不再持久化 pending admissions；只有 queue item 到达 builtin/external Runtime promotion boundary 时，才原子 claim：

```text
currentTurn = {
  queueId,              // 现有 Runtime queue item id，唯一 Turn identity
  kind,                 // user_query | continuation
  turnNumber,
  sidecarGeneration
}
```

没有 Goal 专用 injected turn id、第二套 outcome cache或 Node authority map。

- `sidecarGeneration` 拒绝旧 Sidecar 对 replacement 进程的迟到回写；模型终态在持有 Goal 写锁的 `commit` 闭包内同时核对 current turn 与当前 generation，和 Goal 状态变更共享一个线性化边界。
- Goal `id` 拒绝旧 incarnation 回写新 Goal。
- `revision` 对所有持久变化递增，renderer 用它拒绝乱序 hydrate/event。
- `controlRevision` 只在 pause/resume/objective/terminal 等控制变化时递增，使 Stop 前准备的 continuation 失效；普通 bookkeeping 不制造新 control epoch。
- `goal-orchestrator.ts` 只在真实 dispatch boundary claim，并在真实 terminal 后 finalize。builtin direct turn 在长 await 前发布 admission ticket，取消可立即按 owner/queueId 寻址；图片处理等最后一个 await 后、queue item 构造与 callbacks 转移前必须再次确认 ticket 未取消。Management/claim/adapter 失败全部 fail closed，不留下伪 bubble、history 或 running 状态。

user query 对 paused Goal 的成功 claim 会原子恢复为 active。automatic continuation 对 paused Goal 必须拒绝。

#### Continuation 与 Sidecar

Goal scheduler 只有 `goalId -> one-shot JoinHandle`。active Goal 在上一轮 finalize 后按成功/失败 backoff 安排一次；paused/terminal/currentTurn/outbox pending 时不轮询。

automatic continuation 在调用 Node `/goal/execute-sync` 前先附着 `SidecarOwner::Goal(goalId)`；用户 query 最晚在 Turn claim 时附着。它只是 owner token，不创建独立进程。Pause/Cancel/terminal 先提交 durable control 状态，再按 owner + queueId 精确 stop；只有 promotion/transport/进程终止得到确认后才清 `currentTurn` 并释放 owner。Rust 尚无 currentTurn 的 preclaim transport failure 也必须把已知 queueId 发给 Node stop，不能当作 already stopped。关闭 Tab 只释放 Tab owner，Goal owner/continuation 仍可让同一 Session 在后台继续。

发送统一经过 `/goal/execute-sync` 与 `src/server/session-engine/` selector，builtin/external adapter 共享 queue identity、stop 与 terminal contract。

#### 用户消息与展示

- 桌面 Goal 创建先持久化为 Paused（等待首条用户 turn）；首条 claim 在现有 queue admission 边界原子激活。创建期间切换 Session 或 `/chat/send` 失败只留下可恢复的 Paused Goal，不会把 query 发到新 Session，也不会留下 Active 空转状态。
- Goal 首轮 query：`GOAL_CONTINUATION` hidden envelope + 原 objective visible tail。模型看到完整 Goal context，用户看到自己的原文、Goal badge 与正常实时 streaming。
- 第二轮起自动 continuation：同一 tag，但没有 visible tail，纯隐藏，不产生伪 user bubble。
- Goal 中用户普通 query：`GOAL_CONTEXT` hidden envelope + visible query。
- 所有 automatic continuation 都是 turn-boundary-only，不能 steer/merge 到当前 Turn。

Renderer 的 `useSessionGoal` 只是 `goal:changed` + hydrate 投影。Tab birth/session switch/history restore 按 `sessionId + workspacePath` 查询；active/paused 恢复横条，terminal 只在实时变化时展示，不在历史打开时复活。pause/resume/cancel 的异步返回必须同时核对 `goalId + sessionId + normalize(workspacePath) + current projection`；切换 owner 或同 Session 的新 Goal incarnation 后，旧响应只能被丢弃。

#### Pause、Cancel 与终态

Pause/Cancel 的顺序固定：

```text
disk-first commit Goal control state
-> durable currentTurn / 已知 runtime queueId：SessionEngine.stopOwnedTurnByQueueId(owner, queueId)
-> 尚无 currentTurn 的普通 Pause/Cancel：owner-scoped cancel（只取消该 Goal admission/promotion）
-> wait promotion / transport / process termination confirmation
-> stale queue/generation late result is rejected
-> cancel one-shot continuation
-> release Goal owner when no current Turn/outbox remains
```

外部 Runtime 的 dispatch RPC/stdio write 一旦开始，throw 只表示 acknowledgement 不可得，不证明 prompt 未被消费。即使 Rust 尚无 `currentTurn`，transport ambiguity 也必须用本次已知 queueId 精确 stop；若进程仍可能存活，返回 `terminationUnconfirmed` 并保留 queue binding、`currentTurn`（若已 claim）与 Sidecar owner。fresh/resume promotion 的 Stop 同样要等待 startup settlement，不能以“token 已取消”提前确认。objective 更新使用 lifecycle-lock 内 commit 后的 `currentTurn.queueId` 作为 stop/abort authority，禁止使用锁前 snapshot。

Model 只能提交 complete/blocked；`aiCanExit=false` 在 Rust terminal transaction 硬拒绝，不只依赖提示词。User 只能 canceled，System 可因 end condition 或连续 10 次执行失败进入终态。终态 first-writer-wins。

Turn terminal contract 同时携带该 Turn 已有的 `durationMs` 与 input/output usage。Goal finalize 在清除 Turn 的同一个 `currentTurn.queueId` 权威提交中累加 `totalDurationMs` / `totalTokens`，因此 settlement retry 不会重复计数；模型在 Turn 内先标记 complete/blocked 时，renderer 以 `isExecuting` 显示“正在汇总”，待真实 terminal finalize 后再展示最终总量。统计只覆盖已结算 Goal Turn，不扫描 Session transcript，也不建立 Goal 专用 usage service。

Objective edit 使用 revision CAS；Node SessionEngine 作为 pending queue owner，有普通排队消息时返回 conflict，不代用户删除队列。active Goal 仅在旧 Turn 精确停止成功后启动新 continuation；停止无法确认时使用既有 Paused 状态收敛，paused Goal 只更新持久状态。

#### Channel outbox

desktop/IM/Agent Channel 保留 Session 原 interaction scenario 和输出路由。Goal 不使用 `CronDelivery`。仅 Agent Channel continuation 成功文本进入 Goal outbox：

- stable delivery id + 单 replay worker；
- 无有效 binding 不 ACK；
- 启动与运行时持续恢复；
- at-least-once，push 成功到删除 outbox 之间崩溃可能重复；
- `NO_REPLY` 保持静默。

#### Facade

- Tauri：`cmd_create_session_goal`、`cmd_get_session_goal`、`cmd_pause_session_goal`、`cmd_resume_session_goal`、`cmd_mark_session_goal_terminal`。
- Rust Management API：`/api/goal/get|create|objective|update`、`/api/goal/turn/claim|finalize|abort|pause`。
- Node sync execution：`/goal/execute-sync`。
- CLI/Admin：`myagents goal get|list|create|update`。
- 事件：所有 committed Goal mutation 广播带单调 revision 的 `goal:changed`。

### Builtin Session Owner Split（Phase6 / Phase7）

`src/server/agent-session.ts` 是 builtin SDK 会话的 public facade：`SessionEngine` adapter、legacy callers、route-facing code 仍从这里 import。Phase6 后，facade 后面的核心 mutable state 分给 `src/server/builtin-session/` owner；Phase7 后，turn terminal 与 transcript persistence 这两类最重行为也拆到明确 owner：

| Owner | 拥有内容 | 典型写入 / 行为入口 |
|---|---|---|
| `lifecycle.ts` | SDK `Query`、processing/abort、termination + pre-dispatch rollback barrier、generator resolver、pre-warm control readiness、Query-scoped MCP pre-warm/mutation owner、exact Query background-task registry | abort/restart/termination/pre-warm/generator wakeup、domain rollback join、MCP owner publication/mutation serialization、background task quiescence |
| `queue.ts` | `messageQueue`、`pendingMidTurnQueue`、`turnBoundaryQueue`、in-flight metadata、admission ticket | enqueue/cancel/force/rescue/drain |
| `turn.ts` | current turn usage/output/error、SDK output-owner FIFO、injected turn outcomes、inbox binding | turn state mutation API |
| `turn-lifecycle.ts` | SDK `result` / stopped / error terminal 语义、usage stamping、queue/IM/inbox/watch/analytics/title hook 顺序 | terminal complete/stopped/error、SDK result finalization |
| `config.ts` | MCP/agents/plugins/model/permission/reasoning/provider、deferred restart、MCP fingerprint | config setters、provider boundary reset、MCP sync |
| `transcript.ts` | live `messages`、message sequence、persist cursor/cache、current/live SDK UUID sets、reload anchor | transcript state mutation API |
| `transcript-persistence.ts` | SessionStore mapping、incremental persist chain、load seeding、cursor/cache reset、rewind/fork/retraction persistence consistency | load/persist/reset/switch/rewind/fork/retraction persistence behavior |

边界规则：

- `session-engine/*` 和 `routes/*` 不 import `builtin-session/*`，只通过 `agent-session.ts` public facade。
- `builtin-session/*` 不 import route 或 SessionEngine；需要 pure decision 时调用 `session-core/*`。
- `session-core/*` 仍是无副作用 pure policy，不读写 SDK/SSE/SessionStore。
- `abortPersistentSession()` 仍是唯一语义化 abort 入口；abort flag 的内部写入归 `lifecycle.ts`。
- `agent-session.ts` 需要修改 owner state 时走 `builtin-session/*` 的命名 API；`runtime-boundary.unit.test.ts` 有 direct-write guard，防止重新裸写 lifecycle/queue/turn/config/transcript 状态。
- `agent-session.ts` 不再解释 SDK terminal result，也不再实现 transcript persistence mapping/chain；这两类行为分别归 `turn-lifecycle.ts` 与 `transcript-persistence.ts`，facade 只组装必要依赖并委托。

#### Builtin 公共 MCP soft pre-warm 与 dispatch transaction

`Query.initializationResult()` 只表示 SDK control request 可用，streamed `system_init` 只表示某一 turn 的 metadata；SDK 的 MCP transport 仍可能处于 `pending`、`failed`、`needs-auth` 或 `disabled`。这不是 AI turn 的可用性前置条件：Desktop、Launcher、IM 与 injected turn 全部在公共 `messageGenerator()` dispatch seam 观察同一个 Query/map generation owner，adapter 入口不再因 MCP hard-reject 任务。soft observation 仍串行发生在 domain guard 之前；因此带 `beforeDispatch` 的 injected turn 保持 `soft observation → domain guard → admission/persistence → SDK dispatch` 顺序，`pending` 最多按该 owner 的剩余绝对预算延迟后续步骤，但任何 MCP outcome 都不能拒绝任务。

`builtin-session/lifecycle.ts` 持有 Query/map generation 的一次性 soft pre-warm owner：

- Query object identity 改变时递增 generation；成功安装新 map 时递增 revision，并创建 owner-owned absolute deadline。
- 当前预算由 `MCP_PREWARM_GRACE_MS` 派生，现为 10 秒；用户发送只消费从 owner 创建时起的**剩余**时间，不创建 per-turn 新窗口。
- `connected` 全部到齐即 ready；`failed`、`needs-auth`、`disabled`、missing、status read error 或 deadline 都 terminal degraded，随后照常 dispatch。
- settled outcome 保存在 owner 上；同 generation 后续 turn 是零 control-RPC fast path。owner replacement 时 promoted item 原样 requeue，只交给 replacement Query。
- `mcpServerStatus()` 仍按 owner single-flight，避免无 AbortSignal 的 SDK control request 被重复堆积；它的异常只降级 MCP，不重建 Query。

Cron / Goal / Heartbeat / Memory Update 的领域 `beforeDispatch` guard 仍在公共 soft observation 之后执行，继续负责 claim、cancel、rollback 与 dispatch acceptance；MCP 不参与领域拒绝，也不再拥有 injected-only pre-persistence/final 双 fence。

Live MCP replacement 是独立的 Query-generation **正确性 fence**，不属于 10 秒 soft budget：mutation owner 在异步 map build 前同步发布，使用既有 30 秒 `setMcpServers()` timeout。promotion 与 mutation 按同一 event-loop turn 线性化；promoted item、active turn、SDK command in-flight 任一存在时都不原地替换 transport。真实 Bridge surface drift 会把新消息留在既有 turn-boundary queue，并锁存 deferred restart；旧 turn 继续使用旧 installed surface，replacement Query 安装新 map 后再 dispatch。mutation 失败/超时的等待 item 同样原样 requeue，不能穿越到不确定的 transport owner。

#### Background task 与 deferred restart

SDK background Agent/Bash 不拥有独立 Sidecar；它与父 turn 共用产生它的 builtin Query。`task_started` 因而登记到 `lifecycle.ts` 的 exact Query registry，而不是只留在 `startStreamingSession()` 局部。`applyDeferredRestartIfNeeded()` 与 `schedulePreWarm()` 的既有 drain 点同时检查该 registry：有 active task 时 reasons 保持锁存，不 drain、不 abort；最后一个 `task_updated` / `task_notification` terminal 删除 task 后重试 drain。旧 Query 的 terminal 不能删除 replacement Query 的同名 task。

用户显式 Stop/Reset/Switch、应用退出和真实 Query crash 仍保留终止权；finalizer 对 exact Query 剩余任务发 synthetic `stopped`。这条规则只修 automatic deferred restart 的 quiescence 判断，不为 Cron/config send 新增 waiter，不改变 queue/HTTP lifetime，也不把 startup/watchdog/transcript 等独立竞态并入该 repair radius。

### External Session Owner Split（Phase8）

`src/server/runtimes/external-session.ts` 是 external runtime public facade：`SessionEngine` adapter、external-only legacy endpoints 和 runtime event shell 仍从这里进入。Phase8 后，facade 不再直接拥有 external runtime 的核心 state bags；真实 owner 位于 `src/server/runtimes/external-session/`：

| Owner | 拥有内容 | 典型写入 / 行为入口 |
|---|---|---|
| `lifecycle.ts` | active process/runtime、starting guard、session binding、runtimeSessionId、prewarm/system-init、user-stop flag | start/prewarm/restore/stop/session_init |
| `runtime-config.ts` | desired/live model、permission mode、reasoning effort；snapshot/source guard integration | runtime config setters、message snapshot capture、restore metadata |
| `operation-queue.ts` | desktop queued message/config FIFO、drain reservation、generation-based stale dispatch rejection、desktop send tail reset、force/cancel/status | mid-turn desktop send、turn-boundary drain、config deferral、session reset cleanup |
| `turn-lifecycle.ts` | turn completed/success flags、pre-transport promotion token、finalization gate、turn start time、usage/context usage、terminal plan classification | `beforeDispatch` accepted→transport 间 Stop invalidation、`turn_complete` / `session_complete` success/failure/prewarm/idle/user-stop 分类、wait idle、cron/IM true-success gating |
| `content-blocks.ts` | streaming text/thinking/tool/subagent content state、tool result/attachment mutation、live/turn snapshot | UnifiedEvent text/thinking/tool/subagent cases、live snapshot、turn persistence snapshot |
| `transcript-persistence.ts` | in-memory `SessionMessage[]`、persisted runtime usage totals、user/assistant append、retry truncate、last assistant read、SessionStore save + metadata preview/context update | restore state、append user/assistant、retry truncate、turn-end SessionStore write；facade 只拿 snapshot/owner API，不拿 mutable message ref |
| `interactive.ts` | permission / AskUserQuestion pending state、active IM request id、IM registry cleanup、inbox/watch reply metadata与错误推送 | permission request/response、AskUserQuestion response、stop/error cleanup、IM complete/error fan-out；permission delivery 成功后才 consume/delete |

边界规则：

- `session-engine/*` 和 `routes/*` 不 import `runtimes/external-session/*` owner modules，只通过 `external-session.ts` public facade。
- `runtimes/external-session/*` 不 import route、SessionEngine 或 `index.ts`。
- `external-session.ts` 需要读写 owner state 时走命名 API；`runtime-boundary.unit.test.ts` 有 facade-state guard，防止 `activeProcess`、operation queue、turn finalization、content raw refs/maps、transcript mutable message ref、interactive pending maps、IM registry、terminal classification helper 回流成顶层裸状态。特别是 facade 不 import/use content raw refs/maps；user/assistant append、retry truncate、last assistant read 与 SessionStore save 归 transcript owner；IM event bus / registry cleanup 与 inbox/watch error delivery 归 interactive owner；terminal success/failure/prewarm/idle/user-stop 分类归 turn-lifecycle owner。`external-session.ts` 仍可保留 watchdog、trace、pending birth、early broadcast 等 orchestration-local state，但这些不是跨模块 owner state。
- Phase8 没有抽 builtin/external 通用 runtime framework。两边共享 `session-core/*` pure policy；进程模型和副作用 owner 保持各自 runtime-native。

### `sessionRegistered` 状态

```typescript
let sessionRegistered = false;
```

- `true` —— SDK 已持久化此 session，后续只能用 `resume` 访问
- `false` —— SDK 未注册，可以用 `sessionId` 创建新 session

system-init 事件中验证 SDK 确认使用了我们的 UUID：
```typescript
if (nextSystemInit.session_id) {
    const isUnified = nextSystemInit.session_id === sessionId;
    sessionRegistered = true;
    updateSessionMetadata(sessionId, {
        sdkSessionId: nextSystemInit.session_id,
        unifiedSession: isUnified,
    });
}
```

### sdkUuid 追踪

每条 assistant / user 消息存 SDK 分配的 UUID，用于 `rewindFiles()` 和 `resumeSessionAt` 截断。

**关键规则**：assistant 的 `sdkUuid` 必须存储**最后一条**消息（text）的 UUID，而非第一条（thinking）。SDK 对一轮 assistant 回复输出多条 `type=assistant` 消息——先 thinking（UUID "A"），再 text（UUID "B"）。`resumeSessionAt` 保留指定 UUID 及之前的所有消息，若使用 thinking UUID 会丢失 text 部分。

```typescript
// 每次 type=assistant 都更新，确保最终值是最后一条（text）的 UUID
if (sdkMessage.uuid) {
    currentAssistant.sdkUuid = sdkMessage.uuid;
}
```

**身份边界**：`sdkUuid` 的值就是 SDK stream / transcript 中的 message UUID；MyAgents
不另造这个 ID。但 MyAgents JSONL 里“曾经记录过该 `sdkUuid`”不等于 SDK 当前
`resume` loader 仍能寻址它。SDK 的可寻址性由 SDK 自己的 transcript store 和
`parentUuid` 链决定，可能因 flush race、compact/snip、fork remap、历史清理或
异常重启而变化。因此 `sdkUuid` 是精确恢复的候选锚点；一旦 SDK 拒绝，必须清锚点
并裸 `resume`，不能重试同一个 UUID。

### currentSessionUuids 新鲜度追踪

每个 Sidecar 进程维护 `currentSessionUuids: Set<string>`，记录当前 SDK session 分配的所有消息 UUID。

| 操作 | 时机 |
|------|------|
| 清空 | 非 resume 的新 session 启动时 |
| 从磁盘 seed | `switchToSession` / `loadTranscriptFromSessionMessages` 时 |
| 追加 | SDK 返回 assistant / user 消息时 |
| 校验 | rewind / fork 时判断 UUID 是否属于当前 session |

**新鲜度规则**：若 `lastAssistantUuid ∉ currentSessionUuids`（旧 UUID，来自其他 session），rewind 拒绝使用 `resumeSessionAt`，改为新建 session。

`currentSessionUuids` 是 MyAgents 侧的 freshness cache，不是 SDK transcript 权威。
从磁盘 seed 的 UUID 只能说明 MyAgents store 里存在过该身份；它可用于避免明显
stale 的锚点，但不能证明 `resumeSessionAt` 一定会被 SDK 接受。SDK 报
`No message found with message.uuid` 才是最终拒绝信号；恢复逻辑要驱逐该 UUID，
防止 pre-warm / reload 反复派生同一个坏锚点。

### reloadAnchor：冷加载后的 Rewind 对齐

Rewind 会立即截断 MyAgents store；SDK 侧只能等下一次 `query({ resume,
resumeSessionAt })` 才截断。如果用户 rewind 后没有继续发送消息就切走、关 Tab
或重启，内存里的 `pendingResumeSessionAt` 会消失；裸 `resume` 会让 SDK 回到它
自己的最新 leaf，导致 UI 显示 `[1..N]` 但 AI 实际看到 `[1..M]`。

为关闭这个窗口，`loadTranscriptFromSessionMessages()` 在冷加载时从**持久化尾部**
捕获 `pendingReloadAnchor`：只有尾消息是 `assistant`、带 `sdkUuid`、且通过
`currentSessionUuids` 预筛时才捕获。`startStreamingSession()` 只在非 fork、没有
in-process rewind anchor、且确实是 `resume` 时把它折入 `resumeSessionAt`。成功
收到 `system_init` 后消费该 anchor。

如果 reload / rewind / fork anchor 被 SDK 拒绝，恢复策略统一为：删除对应
freshness cache / 持久 anchor，静默重启为裸 `resume`，并在当前 turn 场景下重投
用户消息。产品取舍是“会话必须能继续，最多退化为 SDK 看到比 UI 更多/更旧的上下文”，
而不是因为一个 stale UUID 让用户消息失败或进入重启循环。

### awaitSessionTermination 超时防护

所有等待 session 终止的操作通过 `awaitSessionTermination(10_000, label)` 执行，带 10 秒超时。超时后强制清理状态（`querySession = null`、`isProcessing = false`、`isStreamingMessage = false`），防止死锁。

调用场景：`resetSession`、`switchToSession`、`rewindSession`、`enqueueUserMessage`（provider change）、`startStreamingSession`、`forceAbortCurrentTurnAndRecover`。

---

## 存储

### 目录结构

```
~/.myagents/
├── sessions.json          # 会话索引（SessionMetadata 数组）
├── sessions.lock/         # 文件锁（目录，非文件）
├── sessions/
│   ├── {session-id}.jsonl # 消息数据（JSONL 格式）
│   └── ...
└── attachments/
    └── {session-id}/      # 附件文件
```

### JSONL 选型理由

| 特性 | JSON | JSONL |
|------|------|-------|
| 追加消息 | O(n) 全文件重写 | O(1) 追加一行 |
| 崩溃恢复 | 文件可能损坏 | 最多丢失最后一行 |
| 并发写入 | 需要文件锁 | 追加通常是原子的 |
| 部分读取 | 需要解析整个文件 | 可以逐行读取 |

### SessionMessage 格式

```typescript
interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;          // JSON 字符串或纯文本
    timestamp: string;
    attachments?: MessageAttachment[];
    usage?: MessageUsage;     // 仅 assistant 消息
    toolCount?: number;
    durationMs?: number;
}
```

### 性能优化

**行数缓存**：避免每次保存消息都读取整个 JSONL 文件计数。`lineCountCache: Map<sessionId, count>` 冷启动时读文件，追加时增量更新。

**增量统计**：只计算新增消息的 token 用量，而非全量重算。统计更新在文件锁内执行避免 TOCTOU：
```typescript
const newMessages = messages.slice(existingCount);
if (newMessages.length > 0) {
    appendFileSync(filePath, linesToAppend);  // JSONL 不需要锁，每个 session 文件单写者
    const incrementalStats = calculateSessionStats(newMessages);
    withSessionsLock(() => {
        // sessions.json 在锁内 read-modify-write
    });
}
```

**文件锁**：`sessions.json` 多 Sidecar 共享需锁。MyAgents 走 `withFileLock` / `with_file_lock`（详见 `pit_of_success.md` 的「withFileLock」节）。

### 损坏行容错

```typescript
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SessionMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            messages.push(JSON.parse(lines[i]));
        } catch {
            console.warn(`Skipping corrupted line ${i + 1}`);
        }
    }
    return messages;
}
```

### Session ID 路径穿越防御

```typescript
function isValidSessionId(sessionId: string): boolean {
    return /^[a-zA-Z0-9-]+$/.test(sessionId)
        && sessionId.length > 0
        && sessionId.length < 100;
}
```

---

## 双重存储：MyAgents 与 SDK

### 背景

Claude Agent SDK 内置了独立的 session 持久化机制（`persistSession` 选项默认 `true`）。MyAgents 调用 SDK 时，**两端各自独立写入会话数据**，形成双重存储。

### 存储位置对比

```
~/.myagents/sessions/                ← MyAgents 写入
├── {session-id}.jsonl               ← 精简业务数据

~/.claude/projects/{project-slug}/   ← SDK 自动写入
├── {sdk-session-id}.jsonl           ← SDK 内部完整格式
```

`{project-slug}` 由 `agentDir` 路径转换而来（例如 `/Users/zhihu/Documents/project/ai-max` → `-Users-zhihu-Documents-project-ai-max`）。

### 数据格式差异

**SDK JSONL**（每行包含完整元数据）：
```jsonc
// 消息链路：parentUuid 构建消息树，isSidechain 标记分支对话
{ "type": "user",      "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "uuid": "...", "timestamp": "...", "permissionMode": "..." }
{ "type": "assistant",  "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "requestId": "...", "uuid": "...", "timestamp": "..." }
// 操作记录
{ "type": "queue-operation", "operation": "...", "timestamp": "...", "sessionId": "..." }
```

**MyAgents JSONL**（精简业务数据）：
```jsonc
{ "id": "...", "role": "user",      "content": "...", "timestamp": "..." }
{ "id": "...", "role": "assistant",  "content": "...", "timestamp": "...", "usage": {...}, "toolCount": 3, "durationMs": 4200 }
```

### 为什么不能禁用 SDK 持久化

设置 `persistSession: false` 会导致两个关键功能失效：

1. **Session Resume**：配置变更（Provider / Model / MCP / Agent）时通过 `resumeSessionId` 恢复对话上下文，SDK resume 机制依赖其自身 JSONL 文件中的消息树（`parentUuid` 链）来重建完整的会话状态。
2. **`/insights` 报告**：SDK 内置命令，扫描 `~/.claude/projects/` 下的 session 数据生成使用分析报告，禁用后无数据源。

### 为什么不能去掉 MyAgents 存储

MyAgents 自身的存储服务于不同的业务场景：

1. **会话列表与历史浏览**：前端通过 `sessions.json` 索引和 `{id}.jsonl` 加载历史消息
2. **业务指标**：`usage`、`toolCount`、`durationMs` 等 SDK 不记录的数据
3. **统一索引**：`sessions.json` 提供全局会话元数据（标题、创建时间、统计摘要），无需遍历文件系统

### 架构决策

**保留双重存储，各司其职。** 两份数据的格式、用途、消费者完全不同：

| 维度 | SDK 存储 | MyAgents 存储 |
|------|----------|---------------|
| 写入者 | SDK 内部自动写入 | MyAgents `agent-session.ts` |
| 读取者 | SDK resume / `/insights` | MyAgents 前端 UI |
| 格式 | 消息树 + 操作记录 | 扁平消息列表 + 业务指标 |
| 索引 | 无（按文件遍历） | `sessions.json` 全局索引 |
| 生命周期 | 跟随 SDK 项目目录 | 跟随 MyAgents 数据目录 |

体积参考：SDK 存储约 1.7× MyAgents 存储（SDK 携带完整上下文元数据 + queue-operation 内部记录）。可定期清理过期的 SDK session 数据（例如 >30 天的已关闭 session）。

---

## 状态同步与新会话机制

### SSE 断连 **不是** 取消权威（load-bearing 不变量）

关 Tab / 网络波动导致 `/chat/stream` 断连，**绝不能**用来取消进行中的 turn。turn 的生命周期归 Rust 的 **Sidecar Owner 模型**（Tab / Task / Goal / BackgroundCompletion / Agent），不归前端 SSE 连接：

- 零 client 时的 `broadcast()` 是 no-op，turn 照常在 sidecar 跑完并持久化；重连后由 `chat:message-replay` 补发。
- 真正卡死的 turn 由 10 分钟 inactivity watchdog 收口（见 `agent-session.ts` / `external-session.ts`，原语 `utils/inactivity-watchdog.ts`）。
- 用户主动放弃用 **Stop**（`interruptCurrentResponse`），不是关 Tab。

历史教训：`390d38ee`（4-25）曾给 `/chat/stream` 加 last-consumer grace interrupt，把"关 Tab"误当"杀 turn"，regress 了 BackgroundCompletion 与 cron/session-send（turn 被 interrupt → `[ERROR turn_failed]` 投回飞书）。最终修法是**彻底删除该 interrupt**；`index.ts` 留有 load-bearing 注释禁止复活。改 SSE 断连相关逻辑前 MUST 理解这条。

### 问题场景

```
1. 用户正在对话，messages = [msg1, msg2, msg3]
2. 用户点击「新对话」→ 前端清空 messages = []
3. SSE 连接断开（网络波动、超时等）
4. SSE 重连 → 后端发送 chat:message-replay 事件
5. 前端收到旧消息 → messages = [msg1, msg2, msg3]  ← BUG
```

**根因**：前后端状态不同步。前端认为是新会话，后端仍持有旧会话数据。

### 解决方案：前后端同步重置 + 防护标志

```typescript
// TabProvider.tsx
const resetSession = useCallback(async (): Promise<boolean> => {
    setMessages([]);
    seenIdsRef.current.clear();
    isNewSessionRef.current = true;            // 防护标志
    const response = await postJson('/chat/reset');
    return response.success;
}, [postJson]);
```

```typescript
// agent-session.ts
export async function resetSession(): Promise<void> {
    abortPersistentSession();                  // 中止持久 session
    messageQueue.length = 0;
    if (sessionTerminationPromise) await sessionTerminationPromise;

    clearMessageState();
    shouldAbortSession = false;
    messageResolver = null;

    sessionId = randomUUID();                  // 生成新 sessionId
    sessionRegistered = false;

    clearSessionPermissions();

    broadcast('chat:init', { ... });
    schedulePreWarm();
}
```

### 防护标志（Defense in Depth）

即使有同步重置，仍可能存在竞态。`isNewSessionRef` 作为额外防护：

```typescript
// 新会话期间，跳过所有可能带来旧数据的事件
case 'chat:init':
case 'chat:message-replay':
case 'chat:message-chunk':
case 'chat:thinking-start':
case 'chat:tool-use-start':
    if (isNewSessionRef.current) break;
    // 正常处理...
```

### 标志重置时机（关键）

renderer 自己发起普通消息时，`isNewSessionRef` MUST 在 **API 调用之前** 重置：

```typescript
const sendMessage = async (text) => {
    isNewSessionRef.current = false;  // ← 必须在这里！
    const response = await postJson('/chat/send', { text });
    return response.success;
};
```

**为什么不能等 API 返回后**：API 是异步的，期间后端会发 `chat:message-replay`（用户消息），如果标志还是 `true` 用户消息会被过滤丢失。

但 Goal scheduler、CLI Goal、Rust direct Cron 等 server-initiated turn 不经过 renderer `sendMessage()`。Runtime 因此必须发送 session-scoped turn 边界：直接消息用 `chat:message-replay { replayKind:'live-user-echo', sessionId, message }`，排队消息实际开始用 `queue:started { sessionId, ... }`。renderer 只有在 `sessionId` 通过当前 SSE/session scope 校验后，才清除 `isNewSessionRef` 并渲染气泡。这样后续 thinking/tool/message chunk 会实时进入当前 turn，同时旧 session 或无身份的迟到事件仍被防护标志拒绝。带 `beforeDispatch` 的 builtin infrastructure turn 在 guard commit 前必须隐藏 `chat:status`、`queue:added`、queue snapshot、append、持久化和上述 turn 边界；commit 时先同步转交 active-turn owner 并确认 dispatch acceptance，再执行异步 SessionStore/user-surface work。这样异步持久化窗口内的 Stop/timeout 仍能精确命中已接纳 turn，不会形成“磁盘已写、调用方却收到未入队”的双重事实。

### Renderer turn activity 的唯一权威

`chat:system-init` 只同步 session birth identity、runtime/config 与 initialization metadata，**不表示 turn 正在运行**。模型、alias、context-window 或 runtime control re-init 都可能在 idle 时产生该事件；由它设置 loading/active 会制造假 Stop UI。

Renderer activity 只来自两种同源快照：

- live SSE `chat:status`：`starting/running` 设置 active + loading，`idle/error` 清理；
- REST `liveSessionState`：历史恢复/重连时使用相同状态分类，即使首个 assistant chunk 尚未出现也必须标记 active。

`isStreamingRef` 仍只表示“React 已有 streaming message”，不能替代 backend activity；prewarm/system-init 也不能替代 `chat:status`。SSE reconnect 的 `chat:init idle` 仅保留为丢失 terminal 事件后的清理兜底，不从 `chat:init running` 推导新 activity。

### 9 种结束场景必须重置的状态

| 变量 | 用途 |
|-----|------|
| `isLoading` | UI 正在等待/展示 active turn |
| `sessionState` | 会话状态（`'idle'` / `'running'`） |
| `systemStatus` | 系统任务状态（如 `'compacting'`） |
| `isStreamingRef` | 内部流跟踪 |
| `isSessionActiveRef` | backend status / REST live snapshot 的 turn activity |

每个场景 MUST 收敛全部 activity 状态；`isStreamingRef` 与 `isSessionActiveRef` 统一通过 `clearSessionActive()` 清理：

```typescript
clearSessionActive();
setIsLoading(false);
setSessionState('idle');
setSystemStatus(null);
```

| # | 场景 | 触发时机 |
|---|------|---------|
| 1 | `chat:message-complete` | AI 正常完成 |
| 2 | `chat:message-stopped` | 用户点击停止，后端确认 |
| 3 | `chat:message-error` | AI 回复出错 |
| 4 | `chat:init` 同步 | SSE 重连，后端状态为 idle |
| 5 | `chat:status` 同步 | 后端广播状态变为 idle/error |
| 6 | `stopResponse` 超时 | 停止请求 5s 后无 SSE 确认 |
| 7 | `stopResponse` 失败 | 停止请求网络错误 |
| 8 | `resetSession` | 用户点击「新对话」 |
| 9 | `loadSession` | 用户加载历史会话 |

### 会话历史恢复：REST 单一权威（#0608，load-bearing 不变量）

上面的「新会话」靠 `isNewSessionRef` skip 旧事件；**恢复一个已存在会话的历史**是另一条路径，权威源不同。恢复历史的**唯一权威 = REST `GET /sessions/:id`**（磁盘、分页、有序；active session 已 merge 内存未持久化消息）。SSE `chat:message-replay` 让位——它是**重载**事件：SSE-connect 冷历史 backfill **＋** 新发 user/command 气泡的 live echo。

- `loadSession` 用**同步**标志 `restoredSessionIdRef`（**不是**异步滞后的 `historyMessagesRef.length`）决定是否 skip replay。在 `setHistoryMessages` 前就放开 loading 标志，会让迟到的 `chat:init` 命中 `!isLoading && length===0` → 清掉刚恢复的 REST 页 + `seenIds` → 内存 replay（可能传输截断）回填**旧**集（#0608 实测：后端发 id 111-190，前端却停在 109）。
- 冷历史 backfill 打 `replayKind:'cold-history'`；新发 user/command 气泡打 `replayKind:'live-user-echo'` 并携带创建事件时的 `sessionId`。REST-restored session 只 skip cold history；新 session birth 只接受通过当前 session scope 校验的 live echo。决策纯核心 `sessionRestoreGuards.ts`（可单测）。
- `GET /sessions/:id` 的 active overlay 由 `SessionEngine.getLiveSessionOverlay()` 提供：磁盘历史先与 finalized in-memory tail 按 message id 合并，当前 streaming assistant 独立返回，同时带 live session state、pending interactive requests 与 `snapshotRevision`。builtin/external public facade 都返回 immutable snapshot；Route 只做分页、redaction、response shaping，不直接读取 runtime owner internal。
- 需要与快照对齐的非幂等 streaming/turn-boundary/interactive SSE 事件由 `participatesInLiveRestore()` 统一选择并包成 `{ sessionId, liveRevision, payload }`。Sidecar 在暴露 snapshot 前先 flush coalesced chunk，因此 `snapshotRevision` 覆盖快照已包含的全部事件。Renderer 在 REST pending 时 buffer；快照落地后丢弃 `revision <= snapshotRevision`，只按序 replay 连续后缀。发现 gap、没有已采纳基线，或 SSE connection generation 变化时，重新请求 REST snapshot，不用 `loading/seenIds` 猜顺序。
- `liveRevision` 是当前 Sidecar 绑定 Session 的 generation-local 内存序号，Session identity 切换时归零；它不写 JSONL、不做 checkpoint，也不改变 REST 的历史权威。新 Session 在首次被 REST adopt 前仍可走 SSE-native birth，避免为尚未持久化的会话制造恢复状态机。
- 诊断"恢复只显示一部分"：读磁盘 `~/.myagents/refs/<id>` 的 spilled body（后端实发的 JSON，可直接 `node` 解析）对比前端显示，先把"后端发了什么 vs 前端显示什么"一刀切开。

### Turn terminal 与通用完成通知

builtin/external 的真实 turn owner 在 complete/stopped/error 时生成同一份 immutable `SessionCompletionTerminal`：`sessionId + workspacePath + turnId + optional turnOwner + origin + status`。descriptor 保存在各 runtime 既有 turn lifecycle state 中；terminal SSE payload 与 `GET /api/session-state` 返回同一事实，route 和 Rust caller 不重建 owner/origin。新 turn admission 或 session reset 会清掉上一份 descriptor。

Rust `notification.rs` 是普通 Session 通用完成通知的唯一业务 owner：Tab-attached 路径由 SSE proxy 提交，headless 路径由 `BackgroundCompletion` 在 active→terminal 后从 `/api/session-state` 提交；两者先经过同一 owner/origin eligibility，再以 `(sessionId, turnId)` 做进程内 exactly-once claim，随后统一执行窗口 focus、通知偏好、系统 toast、badge 与 session/workspace deep-link。Task/Goal owner、Agent Channel、automation/Cron/Task run、Memory 与 Heartbeat 抑制 generic 通知，继续由各自 domain surface 负责；ordinary desktop、registered-agent/Space 与 Session Inbox 可发送 generic 通知。claim 刻意不持久化，不新增 notification ledger。`TabProvider` 只保留 terminal UI 与 unread 状态，不拥有 OS completion toast。

### 会话快照类 SSE 必须按 session scope 过滤

Tab 级 SSE 连接只能保证“事件来自这个 Tab 当前连着的 sidecar 端口”，不能单独保证“事件仍属于这个 Tab 当前展示的 session”。历史切换、新对话 birth、pending session materialization、Sidecar key handover 都可能让旧 sidecar/旧连接的缓存或 live 事件晚到。

凡是会更新 Tab 会话快照或展示阻塞式交互 UI 的 SSE 事件，payload MUST 带 `sessionId`，前端 MUST 先通过 `src/renderer/context/sessionScopedEventGuards.ts::shouldAcceptSessionScopedSseSnapshot()` 或 `decideSystemInitSessionId()` 过滤，再写 React state。当前范围包括：

- `chat:system-init`：既是 runtime/config 快照，也是新 session birth 信号；只有 pending/null/reset → concrete id 的 birth 窗口允许同步 Tab sessionId，普通历史切换中的 mismatch 一律视为 stale。
- `chat:message-replay` 的 `live-user-echo`：既是用户气泡，也是 server-initiated turn 结束 new-session stale window 的有序边界；必须带创建时的 `sessionId`。
- `queue:started`：排队消息正式 promotion 后的用户气泡与 turn 边界；必须带 promotion 所属的 `sessionId`，guarded Goal 只能在 admission accepted 后发送。
- `permission:request` / `permission:expired`
- `ask-user-question:request` / `ask-user-question:expired`
- `exit-plan-mode:*` / `enter-plan-mode:*`

唯一允许的 session mismatch 是新会话 birth：SSE connection 仍标着 pending id，而 SDK / external runtime snapshot 已经带着新 minted concrete session id。除此之外，payload session 与当前 concrete session 不一致就必须丢弃。新增 request/expired 类 SSE 时，如果它会弹 UI、清 UI、改变 plan-mode 或改变当前 session snapshot，必须先把 `sessionId` 加到后端 broadcast / pending replay payload，再接入这层 guard；不要只依赖 Tab-scoped SSE channel。

### Sidecar 配置归置：`sidecarConfigDisposition`（push / adopt / pending，0.2.31）

Tab 翻成 chat 时，Chat 要决定**如何与该 session 的 sidecar 对齐配置**（MCP / agents / model / permission / 插件 / 外部 runtime prewarm）。这是 `Tab.sidecarConfigDisposition` 三态（`src/renderer/types/tab.ts`，**必填**——编译器强制每个 Tab 构造点选择）：

- **`push`** — 把本 tab 的配置推给 sidecar（新起的 sidecar）。
- **`adopt`** — 采纳已在跑的 sidecar 的现有配置、**不推**（接管 IM / Task / Goal / background 占用的 sidecar）。
- **`pending`** — 还不知道：tab 在 sidecar ensure **之前**就 instant-flip 到了 chat（即时进入）。此态下 Chat **既不推也不采纳**，等裁决。

**唯一裁决者**：`ensureSessionSidecar` 返回的 `result.isNew`（在 Rust manager 锁内决定）是 `pending → push|adopt` 的**唯一**来源（`App.handleLaunchProject` 的 ensure 后一步，instant 与非 instant 两条路径都跑）。前端 `getSessionPort` 仅作"绘制时机提示"，**不参与配置正确性**——即便它竞态/出错，最坏只是翻页时机偏差，绝不会推错配置。

**为什么是三态（#300/#301 实战）**：旧的 `joinedExistingSidecar?: boolean` 有个表达不出的第三态（`undefined → ?? false → push`），instant-flip 时被迫用 `getSessionPort` 预测 → 并发 Rust creator（Task / Goal / IM / 崩溃重启）在"检查"与"ensure"之间起了 sidecar → ensure 接管活的 sidecar，而 Chat 把配置推上去 → **config-stomp + MCP 指纹 abort + 30s 重启循环**（TOCTOU）。三态把"还没定"变成一等公民。

**红线（Pit of Success，改 Chat 配置同步 / 新增 session 打开路径前必读）**：
- Chat 里**任何**"mount 期把配置推给 sidecar"的 effect MUST 门控 `configDispositionRef.current === 'push'`（`pending`/`adopt` 跳过）。漏一个 = 静默 config-stomp。
- **依赖不对称**：推送 effect 依赖布尔 `configPending`（`pending→push` 重跑，`adopt→push` 不重放）；采纳 effect 依赖 `isAdopt`（`pending→adopt` 触发一次）。写反 = 漏推或重复采纳。
- 用户**主动**改配置（`persistTabConfigChange`）走 **defer-while-pending**（仅 `pending` 时延迟推送、磁盘照写；`push`/`adopt` 都推——用户意图）。
- instant-flip 的 `pending` tab **不得携带 `initialMessage`**（否则 autoSend 的未门控推送会在 pending 时触发）。
- "在新标签打开已有 session" MUST 走 background-owner 感知的 `spawnTabForExistingSession`（`preserveCronActivation` 是兼容字段名，`updateSessionTab` 保留 Task activation）；**别** pre-seed 一个带 sessionId 的 tab 再 handleLaunchProject——那会让 planner 走 jump-to-tab → Scenario 4 的 deactivate/reactivate 抹掉后台归属。
- 启动失败的 catch MUST 把 instant-flip 的 `pending` tab 重置为终态 `push`（否则永远卡 `pending`，既不推也不采纳）。

即时进入还包含 `ChatBootOverlay` 的"AI 启动中"毛玻璃蒙层（翻页瞬时出现、就绪时淡出衔接），它同时是 App 的 lazy-Chat Suspense fallback。`getSessionPort` 之所以只能是提示：见上方「唯一裁决者」。

### Session 配置写入方向矩阵：setter 边界的 snapshot guard（#327，0.2.32+）

`sidecarConfigDisposition`（上节）管的是**桌面 Chat 这个 writer**"要不要推"；本节管的是 **Rust IM router 这个 writer** 推过来时 sidecar **"要不要接"**。两个 choke point 互补，不可互替。

背景（#327）：desktop Chat 会话与 IM channel 可共享同一 sidecar（handover 把 IM peer 绑到 desktop session_id），channel 可携带不同的 model/provider/permission 覆盖。Rust IM router (re)warm 该 sidecar 时 `sync_ai_config` 把覆盖 POST 进 sidecar 的 process-global setter → 桌面会话的快照配置被冲掉（context 环 1M→200K；live provider 串成 channel 的而 model 还是桌面的 → 上游 500 "Model Not Found"）。

修法 = **setter 边界收权**。纯规则在 `src/server/session-core/runtime-config-policy.ts`，副作用入口在 `src/server/agent-session.ts` / `src/server/runtimes/external-session.ts`；快照会话无视 IM 配置同步：

| 端点 / setter | 调用方 | 守卫形态 | 快照会话行为 |
|---|---|---|---|
| `/api/model/set` → `SessionEngine.updateModel()` → adapter setter | 桌面 picker **和** Rust IM router 共用 | **显式 source flag**：Rust 带 `imConfigSync:true` | 仅 `imConfigSync` 调用被忽略；桌面 picker 保持权威（它自己更新快照） |
| `/api/provider/set` → `SessionEngine.updateProviderEnv()` → builtin `setSessionProviderEnv` / external skip | **仅 Rust IM router**（caller audit；桌面 provider 走 chat-send payload / boot env，从不到这） | builtin 无条件守卫；external runtime 显式 skip | builtin 快照会话任何调用都被忽略（snapshot wins），`console.warn` 记录；external 不接收该 setter |
| `/api/session/permission-mode` → `SessionEngine.updatePermissionMode()` → adapter setter | **仅 Rust IM router**（同上） | 无条件守卫 | 同上。安全相关：fullAgency 的 IM channel 不得静默降级桌面 plan-mode 硬闸 |

配套 Rust 根因：`SessionRouter::ensure_sidecar` 曾在 create 路径无条件返回 `is_new=true`——复用既有健康 sidecar（只加 owner）也被当"新建"推配置。现透传 manager 锁内权威的 `EnsureSidecarResult.is_new`，复用即跳过 `sync_ai_config`（复用的 sidecar 已有配置；per-message enqueue 每轮重解析 channel 配置，不受影响）。

**External runtime 补充（0.2.34+ / 0.2.40 policy owner）**：外部 runtime 的 model / permission /
reasoning effort setter 不再是“直接 stop 进程”的 process-global 操作。`/api/runtime/config`
和旧 `/api/model/set` / `/api/session/permission-mode` / `/api/reasoning-effort/set`
的 external 分支都会进入 `external-session.ts::updateExternalRuntimeConfig()`；desired/live config state 与 snapshot/source filtering 由 `runtimes/external-session/runtime-config.ts` 拥有:

- active turn 中的配置变更进入 `runtimes/external-session/operation-queue.ts` 维护的 queue,当前 turn 继续运行。
- desktop queued message 捕获入队时的 runtime config snapshot,后续 config op 不会倒灌。
- turn boundary drain 先应用前导 config ops,再启动下一条 message。
- Codex / Claude Code 使用 next-turn state；Gemini 的 `session/set_model` /
  `session/set_mode` 也只在 boundary 调用,保持“当前轮不受影响”的产品语义。
- IM 仍通过每轮 `ExternalSendContext` live resolve；Task 只在新 Session 初始化时使用 Task config，已有 Session 继承自己的配置。Task 的 initialize/adopt 由 scheduler reservation 在 per-Session lifecycle 内读取持久 Session metadata 决定，不能绑定到 Sidecar 进程的 `EnsureSidecarResult.isNew`：Tab 可已保活同一 Sidecar，而 Task 仍是合法 metadata creator。adopt payload 在 Rust 构造时即不携带 model/provider/runtime/MCP 初始化字段。reservation 从发布 Session id 起持有 lifecycle guard，并并行等待权威 `SessionStore` metadata 出生；一旦 materialize 立即释放（不得持满整轮，否则同 Session 工具会反向死锁），保证 shared-session joiner 不会抢在 creator 前 adopt。若 turn 先失败且 metadata 仍未出生，creator 释放 guard 与 Sidecar owner，下一次 reservation 重新取得 creator 权；进程是否仍被其它 owner 保活不参与该裁决。
- `/api/runtime/config` 是 source-aware：Rust IM router 热同步传 `source:"im-sync"`；桌面 push 走 `runtime-config` / `desktop`。`updateExternalRuntimeConfig()` 必须先调用 `runtime-config-policy` 过滤 snapshotted session 不应接收的字段，再写 `lastModel` / `lastPermissionMode` / `lastReasoningEffort`，禁止“先污染 desired state 再跳过 restart”。

**红线**：
- provider/permission 两端点"仅 Rust-IM-router 可调"是**注释级契约**——渲染器/桌面侧**禁止**新增对这两个端点的调用；在快照会话上它们会被静默吞掉（守卫处 `console.warn` 可见）。桌面要改 provider/permission：provider 走 chat-send payload（enqueue 每轮 inline 解析），permission 走既有 `/api/permission-mode` 桌面路径。
- 纯 IM / 尚未 materialize 的 backend-created Task Session 不受守卫影响；已有快照 Session 必须保持 snapshot authority（回归测试 `session-config-snapshot-guard.test.ts` 锁定三 setter × 三场景）。
- 合法的 per-turn channel 配置应用走 `enqueueUserMessage` inline 解析（"snapshot wins" 已内建），**不经过**这些 setter。

---

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/renderer/types/tab.ts` | `Tab.sidecarConfigDisposition` 三态 + `buildChatFlipPatch`（必填 disposition） |
| `src/renderer/App.tsx` | `handleLaunchProject`（instant-flip + 单一 post-ensure resolver）、各 Tab 构造点 disposition 映射、`spawnTabForExistingSession`（background-owner preserve） |
| `src/renderer/pages/Chat.tsx` | 9 个 disposition 门控的配置同步 effect + `persistTabConfigChange` defer-while-pending |
| `src/renderer/components/ChatBootOverlay.tsx` | "AI 启动中"蒙层 + 淡出过渡 |
| `src/server/types/session.ts` | `SessionMetadata` 类型定义、`createSessionMetadata()` |
| `src/server/SessionStore.ts` | 存储层实现 |
| `src/server/agent-session.ts` | builtin SDK public facade + session orchestration glue、`switchToSession()`、system-init 处理 |
| `src/server/builtin-session/turn-lifecycle.ts` | builtin SDK result/stopped/error terminal 语义、usage stamping、IM/inbox/watch/analytics/title hook 顺序 |
| `src/server/builtin-session/transcript-persistence.ts` | builtin transcript ↔ SessionStore mapping、incremental persist chain、load seeding、cursor/cache 一致性 |
| `src/renderer/api/sessionClient.ts` | 前端 API 客户端 |
| `src/renderer/utils/formatTokens.ts` | Token / 时长格式化工具 |
| `src/renderer/context/TabProvider.tsx` | 前端 reset / 防护标志 |

## 相关文档

- `ARCHITECTURE.md` 的核心抽象「Sidecar Owner 模型」「持久 Session」「Pre-warm 机制」
- `ARCHITECTURE.md` 的模块「Session 切换与持久化」（四场景 + 分层 config snapshot）
- `pit_of_success.md` 的「withFileLock」「Snapshot Helpers」
- `multi_agent_runtime.md` 的「External Session Handler」（外部 Runtime 的会话生命周期）
