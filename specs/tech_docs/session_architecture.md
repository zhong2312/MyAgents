# Session 架构

> Session 的标识、存储、状态同步机制。Sidecar Owner 模型与既有 Session 的 new / jump / revive 导航见 `ARCHITECTURE.md` 的核心抽象与模块地图。

## Session ID

每个 Product Session 由一个稳定 ID 标识，拥有消息存储、前端展示、Tab/Sidecar scope、title 与 config。Claude Agent SDK 另有 execution identity：普通新会话两者通常相同，但 Rewind 或 provider history 边界可以只把 `sdkSessionId` 从 S1 换成 S2，Product Session A 始终不变。

### 数据结构

```typescript
interface SessionMetadata {
    id: string;                 // UUID v4
    agentDir: string;           // 工作区路径
    title: string;
    createdAt: string;
    lastActiveAt: string;
    sdkSessionId?: string;      // exact SDK create/resume candidate；不证明 transcript 已存在
    unifiedSession?: boolean;   // legacy birth marker；true 时缺省 SDK candidate 为 id
    stats?: SessionStats;
    cronTaskId?: string;
    runtime?: RuntimeType;      // 'builtin' | 'claude-code' | 'codex' | 'gemini'
    runtimeSessionId?: string;  // external runtime thread/session id（Codex threadId 等）
    historyGroupPath?: string[]; // 项目内最多两级的可选历史分组；缺失 = 项目根
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

`id` 与 `sdkSessionId` 不能相互代写。Product owner 决定 A 的创建、持久化、Tab/Sidecar 绑定和释放；builtin lifecycle 只决定 SDK candidate S 的 create/resume。启动时先 probe `sdkSessionId ?? (unifiedSession ? id : undefined)`：有 SDK transcript 才 resume；空结果用同一 candidate fresh create；probe error 拒绝启动。禁止把 candidate 字段当作“必然可 resume”，也禁止 probe 失败后回退到 Product id 或随机 S3。

`configSnapshotAt` 是配置权威边界：存在时，session snapshot 拥有当前会话配置；缺字段不是“自动读 Agent 默认值”的许可。Agent/Project 只作为新 session 模板、legacy/no-snapshot 兼容源、以及 IM 无 Tab owner live-follow 源。

MCP 是分层 authority：`mcpEnabledServers` 冻结该 Session 选择的 server ID；`command / args / env / headers / url` 定义和全局 enabled 安全总闸仍以当前 `config.json` 为权威。任何输入先解析成“snapshot IDs ∩ global enabled ∩ current definitions”，再比较完整 fingerprint；因此 Project 默认变化不能偷改 owned Session 的选择，同 ID 定义变化与全局 disable/re-enable 又都能更新并重启 SDK/MCP。新会话 pre-warm 前按当前 Project/global 配置重新解析有效 MCP，不能复用旧 Session 留在 Sidecar 内存里的启动对象。

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

### Session identity 迁移与删除线性化

- `pending-* → SDK UUID` 不是“先创建 target、再尽力删除 source”的两次独立写入。`SessionStore.migratePendingSessionIdentity()` 同时持有 source/target JSONL 锁与 sessions index 锁；若 pending transcript 已落盘，先为 target 建立同 inode hard link，再用一次 `sessions.json` 写入替换 identity，最后移除 source 名称。进程在 metadata commit 前退出时，source metadata/data 仍是权威；重试只接纳与 source 同 inode 的 staged target，不明 target data 一律 fail-closed。source 清理失败时先补回已移除的 source link、恢复原始 metadata，再清 target，因此不会把部分迁移发布成两个可分叉副本。
- 用户删除的唯一 lifecycle authority 是 Rust `cmd_delete_session_if_unowned`。它只接受 `[A-Za-z0-9-]{1,99}` 的 canonical 单路径段 ID，持有 per-Session lifecycle guard，并同时检查 durable Task/Goal、闲置、显式停止或 hot-reload replacement 后仍保留的 IM peer binding 与全部 Sidecar owner；App 只可提交自己当前 mounted 的 exact Tab ids，Rust 必须拒绝任何未授权 Tab 或非 Tab owner，在 Node `user-delete` 存储 mutation 成功（或幂等 not-found）后才在同一 fence 内释放这些 Tab owner。这样 storage/owner 任一拒绝都原样保留 Tab，不需要 renderer rollback。IM binding 的 snapshot、owner query 与删除 preflight 共用同一 predicate，同时扫描 live router 与当前配置 Channel 的 health state；删除预检发生在 lifecycle guard 外（IM 既有锁序是 router → lifecycle），锁内只重读 disk binding 与 Task/Goal，预检后新建的 live binding 必须先在同一 lifecycle fence 下附加 `Agent` owner，再由锁内 Sidecar-owner 检查兜底，禁止反向持 lifecycle 再等 router。App 是 mounted Tab 集合的 owner，因此所有用户删除入口、固定 Session 打开/恢复/迁移入口（包括 fork attach、pending→real identity adoption、Task Center / 通知的 `OPEN_SESSION_IN_NEW_TAB` 与 `TabProvider` recovery）和 mounted Tab turn submission必须使用 App 的同一 per-Session admission map 与 delete 互斥；opening claim 携带既有 Tab ID，同一 Tab 在自己的 adoption await 内提交 turn 时只获得 no-op nested release，不能清除 outer claim，其它 Tab 与 deletion 仍 fail closed。旧 generation 的 terminal / reconcile 事件在 opening claim 持有期间也不得清理该 Session 的 Tab；成功与失败回滚均由 opening path 负责。先实时查询非 Tab owner，再由 Rust 把运行中的 turn 接管成 `BackgroundCompletion` 或权威确认 idle，只有明确 idle 才把匹配 Tab ids 交给 Rust authority，并在 lifecycle fence 内以 `SessionEngine.isBusy()` 复核已接纳的 builtin/external 队列，成功后才把对应 Chat Tab 退回 Launcher并停止 SSE proxy。Floating companion 使用独立 `Companion` owner；headless Inbox 的 healthy reuse 与 dead resume 均在 delivery lifecycle fence 内先附加 transient `Agent` owner，成功投递后先接力给 `BackgroundCompletion` 再释放，两者都不是 App 可释放的 Tab，必须进入非 Tab preflight。删除专用 strict handoff 保留 transport / activity-check 错误；失败或不可用必须保留 Tab 并 fail closed，不能拿 renderer `isGenerating` 投影当删除许可。列表、搜索和历史下拉不得直接调用存储删除。Rust 同时输出精确的非 Tab 删除保护快照供 UI 解释阻塞，但它只是投影，最终命令仍在锁内裁决并返回 machine-readable refusal reason。owner-acquiring Sidecar ensure 统一走 lifecycle async entrypoint：普通调用方由入口 acquire，Task metadata creator 或 Inbox delivery 已持 authority 时用 shared held lease 贯穿 readiness，严禁同 key 二次 acquire。health recovery 失败时把携带 owners 的原始 dead sidecar 放回 manager，不能把 owner 只藏在 monitor 私有重试队列。Renderer/browser 不能直接建立删除 authority，browser dev 因而拒绝删除，而不是退化成裸 HTTP DELETE。
- `SessionStore.deleteSession()` 只接受 typed intent。`prepared-materialization-rollback` 必须在 JSONL/legacy data 尚不存在且 metadata 仍由同一 materialization source 拥有时才可执行；用户删除还在 index 锁内复核 system-maintenance 保护。
- prepared rollback 与 turn admission 不靠队列/内存布尔快照互猜。Admission 以 `PendingDesktopMaterialization.targetSessionId + priorSessionId` 调用存储层 typed CAS `claimPreparedSessionForTurnAdmission()`；它与 rollback 在同一 sessions index 锁内检查同一 `materializationState:'prepared'` / source marker。该 CAS 是 admission 最后一个 awaited transition：此前仍可取消，赢锁后则同步把 promoted item 转成 active turn。admission 先赢则 marker 已清、rollback 拒绝；rollback 先赢则 metadata 已删、admission 在发布 accepted 前失败。

### SDK `sessionId` 与 `resume` 互斥

SDK 约束：`sessionId` 和 `resume` 参数不能同时传递。

```typescript
querySession = query({
    prompt: messageGenerator(),
    options: {
        // fresh SDK：传已持久化的 exact SDK candidate（不必等于 Product id）
        // 历史 session：传 resume 恢复对话上下文
        ...(resumeFrom
            ? { resume: resumeFrom }
            : { sessionId: effectiveSdkSessionId }
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

### Agent / Session 协作与事件协议（list / start / send / watch）

`myagents session list --agent` 只读取 history-visible Session metadata，不读取
transcript、不探测 live state，也不唤醒 Sidecar。`myagents session start --agent`
由 source 只解析目标 Agent/workspace，Rust 在 per-Session lifecycle fence 内生成新 ID、
ensure 目标 Agent workspace 的 Sidecar。target 在任何 metadata 写入前重新解析 Agent/Project
lifecycle，并核对当前 Sidecar 的 Session/workspace；随后以 hidden
`materializationState:'prepared'` 写入目标侧当前配置与实际 Runtime 的 owned snapshot。builtin/external
都在 `SessionEngine.enqueueInboxMessage()` 的既有 Runtime dispatch guard claim。claim 赢后 Session 可见，之后的 runtime
error 是已接纳 terminal；明确 rejection 用 source message ID typed rollback。ACK 不明保留
ID、不自动重试。Rust 复用既有 `BackgroundCompletion` handoff；不新增 fresh-start durable
token、恢复状态机、配置 fingerprint 或跨文件事务。

`myagents session start` / `send` / `watch` 不是普通文本拼接，而是结构化的 session event
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

所有事件的结构化 prompt 都位于隐藏的 `system-reminder` envelope 内。renderer
仅对 `send.request` 建立展示投影：读取 `<payload>` 与 `source_label` 形成目标
session 的用户气泡；`event-summary`、session id 等协议元数据不得进入气泡。
`send.result` 与 watch 事件是自动控制流，继续保持隐藏。该投影同时作用于 live echo
与 REST 历史恢复，因此不能通过只在 SSE 分支插一条临时消息实现。

`watch` 的 owner 分两层：Rust Management API 先用 live sidecar 表确认目标 session
是否仍在运行，并在目标 sidecar 上注册 pending watch；目标 sidecar 只在 turn terminal
时调用 `deliverSessionWatchEvents()` 生成最终事件。只有 watcher sidecar 确认 inbox
delivery 成功后，目标 sidecar 才 ack 并清理 pending watch；Management API 暂时不可用
时保留待重试，避免完成事件丢失。

Space Registered Agent 的 `space.issue_delivery` 复用 inbox 的 `sessionEvent`
metadata 来选择 registered-agent scenario 和 lazy session materialization，但最终
prompt 不走通用 `<myagents-session-event>` 外包。Rust Space owner 会直接渲染
`<system-reminder><myagents-space-issue>…</myagents-space-issue></system-reminder>` user message，
让前端隐藏内部处理指令并显示 `Space issue` badge。这个特例只适用于 Space Issue
delivery，不改变 `myagents session send/watch` 的通用事件协议。`system-reminder`
的通用隐藏 payload / badge / visible tail 规则见
`system_reminder_protocol.md`。

0.3.2 起，Registered Agent Session 的持久 origin 必须是
`{ kind:'registered-agent', surface:'space_issue_delivery', context:{ spaceId, registeredAgentId } }`。
Rust delivery event 同时携带两个 exact ID，Inbox 将其组成 `InteractionScenario`，
SessionEngine 的 builtin/external adapter 必须透传同一 context 到 Session metadata。
缺任一 ID 时不能构造 Agent context；普通桌面 Session 即使 workspace 与某个或多个
Registered Agent 相同，也保持 User actor。升级时只允许把明确持久化为
`registered-agent + space_issue_delivery`、且历史结构中完全没有 `context` property 的
origin 补齐为 exact binding；`origin` 缺失、`null`、畸形或属于 desktop/其它 surface
都必须 fail closed，不能因一次定向 Delivery 把普通旧 Session 提升为 Agent。fork 明确重置为
`{ kind:'desktop', surface:'session_fork' }`，不得继承源 Session 的 Agent 身份。

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

主 Stop 仍只中止当前 Turn，不私自调用 SDK 未公开的 `cancel_queued`。SDK 0.3.220 的
公开 `Query.interrupt()` receipt 会返回 `still_queued`：其中 UUID 与
`messageGenerator()` 写入的 queue id 是同一身份。若 receipt 明确包含当前 in-flight
项，UI queue pill 必须保留到 replay / assistant-start 确认消费；receipt 缺失时按旧 CLI
保守兼容，同样保留 queue pill，不能臆造取消。未知 UUID 只记数量并忽略，不创建第二份
队列 owner。

规则 owner：`src/server/session-core/turn-queue.ts`。副作用 state owner：`src/server/builtin-session/queue.ts`。`agent-session.ts` facade 负责把 enqueue / cancel / force / terminal orchestration 接到 SDK、SSE、IM reply 等副作用，但 queue 数组、in-flight slot、turn admission ticket 不再作为 facade 顶层裸状态维护。admission、cancel location、force-start reordering、abort ticket 清理必须继续调用 `turn-queue` policy。

### Goal Mode Session State（0.3.0）

Goal 是 current Session 的独立持久状态，物理存储为 `~/.myagents/session_goals.json`，不嵌入 `SessionMetadata`，也不复用 Task/Cron：

```typescript
type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'canceled';

interface GoalEndConditions {
  deadline?: string;
  maxExecutions?: number;
  aiCanExit: boolean;
}

interface SessionGoalView {
  id: string;              // current Goal incarnation fence
  sessionId: string;       // product lookup key
  workspacePath: string;
  objective: string;
  status: GoalStatus;
  endConditions: GoalEndConditions;
  notifyEnabled: boolean;
  permissionMode: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  controlRevision: number;
  isExecuting: boolean;
  executionNumber?: number; // 正在执行的 current turn；未执行时省略
  totalDurationMs: number; // 已结算 Goal Turn 的实际执行耗时之和
  totalTokens: number;     // 已结算 Goal Turn 的 input + output tokens 之和
  lastExecutedAt?: string;
  terminalReason?: string;
}
```

#### 权威边界

- `SessionGoalManager` 是 Goal 唯一业务 owner。同一 Session 最多一个 unfinished Goal；已终态 Goal 可被下一次 create 替换。
- Goal 不持有 taskId、Cron schedule、tab、runtime/model/provider/reasoning/MCP 或普通 delivery。Session 继续拥有运行配置，Goal 只保存 permission turn policy。
- UI `/goal`、当前 Session 内的 `myagents goal create`、私聊 IM/Agent Channel 都写同一 Goal。创建前必须 materialize 真实 Session id；Rust 拒绝 `pending-*`，没有 post-hoc rebind。
- Goal 与 Task 可以关联同一 Session。二者不互相引用，实际 Turn 顺序由现有 Runtime queue 决定。
- command Task 的 pending Activation Event 属于 Rust TaskStore durable outbox，不是 Session queue。只有 checkpoint + event 落盘后才向 SessionEngine 提交普通 Task queue item；quiet/failure/test 不 materialize Session、ensure Sidecar 或进入 Runtime。

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

Goal scheduler 的 automatic continuation 是 `goalId -> one-shot JoinHandle`：active Goal 在上一轮 finalize 后按成功/失败 backoff 安排一次；paused/terminal/currentTurn/outbox pending 时不轮询。绝对 deadline 由同一 `SessionGoalManager` 的另一条 one-shot handle 按 wall clock 反复复核，因此 paused 和 in-flight Turn 同样受限；到点后在 session lifecycle 锁内持续复用 disk-first terminal + exact/owner-scoped stop，直到 authority 清除与 owner 释放确认，期间新 Goal 不能越过旧 Goal cleanup。max executions 同时在 continuation 调度与原子 Turn claim 处裁决；claim 输给结束条件时仍持久化该 queue authority，等 Node 既有 abort settlement 清除后才允许替换。

automatic continuation 在调用 Node `/goal/execute-sync` 前先附着 `SidecarOwner::Goal(goalId)`；用户 query 最晚在 Turn claim 时附着。它只是 owner token，不创建独立进程。Pause/Cancel/terminal 先提交 durable control 状态，再按 owner + queueId 精确 stop；只有 promotion/transport/进程终止得到确认后才清 `currentTurn` 并释放 owner。Rust 尚无 currentTurn 的 preclaim transport failure 也必须把已知 queueId 发给 Node stop，不能当作 already stopped。关闭 Tab 只释放 Tab owner，Goal owner/continuation 仍可让同一 Session 在后台继续。

发送统一经过 `/goal/execute-sync`。`routes/scheduled-turns.ts` 只负责请求校验和响应映射，`goal-orchestrator.ts` 管理 Goal 的准备、dispatch 和终态生命周期；Builtin/External adapter 通过 `prepareScheduledTurn()` 完成各自的 Session 绑定与配置准备，并共享 queue identity、stop 与 terminal contract。

Task 仍统一经过 `/cron/execute-sync` 的历史兼容路由名与 `task-turn-orchestrator.ts`。可选 Activation Event 使用 strict v1 envelope；Node 只校验并把固定 event/reason/handoff context 交给既有 Task reminder，不接受 Detector 提供 role、system prompt、runtime、provider、permission、MCP 或 Session 目标。orchestrator 返回真实 `turnDispatched`，Rust 只有在 Runtime admission 已发生且 terminal 已确认时才记一次 AI execution；pre-admission failure 保留 pending event，transport/termination 不确定时保留精确 queue authority供 Stop/recovery。

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

Product Session 的当前 identity、待创建的桌面 Session 和 metadata 冻结/发布不属于任何 Runtime，统一由 `src/server/session-engine/product-session-binding.ts` 管理。prepare、commit 和 rollback 使用同一个事务标记；只有 adapter 完成本 Runtime 的进程清理后，commit 才发布新的 Product Session binding。Builtin SDK UUID 与外部 Runtime 的 thread/session id 仍由各自 Runtime 管理；adapter 不能借用另一 Runtime 的 reset、Session 创建函数或 session id 作为兜底。

模块加载本身不会生成 Product Session id，也不会写入 `MYAGENTS_SESSION_ID`。Global Sidecar 可以加载一次性 SDK 工具和共享类型，但不能创建 Product Session。只有 Session 初始化时的 `initializeAgent()`，或 adapter 的显式 reset/select，才能建立当前 binding；生产环境的进程角色检查会阻止 Global 通过 Chat、IM、Inbox 或当前 Runtime 配置路由间接触发这一过程。

`src/server/agent-session.ts` 是 builtin SDK 会话的 public facade：`SessionEngine` adapter、legacy callers、route-facing code 仍从这里 import。Phase6 后，facade 后面的核心 mutable state 分给 `src/server/builtin-session/` owner；Phase7 后，turn terminal 与 transcript persistence 这两类最重行为也拆到明确 owner：

| Owner | 拥有内容 | 典型写入 / 行为入口 |
|---|---|---|
| `lifecycle.ts` | SDK `Query`、可撤销 identity authority、processing/abort、termination + pre-dispatch rollback barrier、generator resolver、pre-warm control readiness、Query-scoped MCP pre-warm/mutation owner、exact Query background-task registry | abort/restart/termination/pre-warm/generator wakeup、system_init authority、domain rollback join、MCP owner publication/mutation serialization、background task quiescence |
| `queue.ts` | `messageQueue`、`pendingMidTurnQueue`、`turnBoundaryQueue`、in-flight metadata、admission ticket | enqueue/cancel/force/rescue/drain |
| `turn.ts` | current turn usage/output/error、SDK output-owner FIFO、injected turn outcomes、inbox binding | turn state mutation API |
| `turn-lifecycle.ts` | SDK `result` / stopped / error terminal 语义、usage stamping、queue/IM/inbox/watch/analytics/title hook 顺序 | terminal complete/stopped/error、SDK result finalization |
| `config.ts` | MCP/agents/plugins/model/permission/reasoning/provider、deferred restart、MCP fingerprint | config setters、provider boundary reset、MCP sync |
| `transcript.ts` | live `messages`、message sequence、SessionStore transcript cursor、current/live SDK UUID sets、reload anchor | transcript state mutation API |
| `transcript-persistence.ts` | SessionStore mapping、tail-only persist chain、load/cursor seeding、命名 rewind/retraction/rollback mutation | load/persist/reset/switch/rewind/fork/retraction persistence behavior |

边界规则：

- `session-engine/*` 和 `routes/*` 不 import `builtin-session/*`，只通过 `agent-session.ts` public facade。
- `builtin-session/*` 不 import route 或 SessionEngine；需要 pure decision 时调用 `session-core/*`。
- `session-core/*` 仍是无副作用 pure policy，不读写 SDK/SSE/SessionStore。
- `abortPersistentSession()` 仍是唯一语义化 abort 入口；abort flag 的内部写入归 `lifecycle.ts`。
- `agent-session.ts` 需要修改 owner state 时走 `builtin-session/*` 的命名 API；`runtime-boundary.unit.test.ts` 有 direct-write guard，防止重新裸写 lifecycle/queue/turn/config/transcript 状态。
- `agent-session.ts` 不再解释 SDK terminal result，也不再实现 transcript persistence mapping/chain；这两类行为分别归 `turn-lifecycle.ts` 与 `transcript-persistence.ts`，facade 只组装必要依赖并委托。
- builtin SDK terminal 的成功判定统一由 `session-core/turn-result-policy.ts::classifyBuiltinSdkTerminalResult()` 提供：`is_error` 不是单独 authority；只有 `completed` 与兼容旧 SDK 的缺失 reason 可以 complete，`aborted_*` 映射 stopped，其它或未来未知 reason 一律 fail closed，避免 Task / Goal 把部分结果误结算为成功。
- builtin pre-warm 遇到 SDK native child 的确定性 exec denial 时，第一次失败只做短暂 control-plane handoff；随后必须采用 Rust admission 返回的 `retryAfterMs`，不得回落为 process-local 500ms/0ms 重启循环。Rust half-open lease 是唯一重试时钟，详见 `bundled_node.md`。

每次 builtin Query launch 由 `lifecycle.ts` 签发仅属于该 Query object 的 identity authority，记录 launch Product Session id 与启动参数实际使用的 expected SDK Session id。`abortPersistentSession()` 先同步 revoke authority，再 interrupt / wake generator；Query replacement 同样撤销旧 authority。streamed 或 pre-warm buffered `system_init` 必须携带原 authority，只有 authority 当前未撤销、Product binding 仍属于 launch identity（或已完成同一 pending adoption）、且 `system_init.session_id` 与 expected SDK id 精确相等时才能产生 metadata side effect。`pending-*` 可原子 adoption 到 SDK UUID；legacy Product A / SDK B 与非 UUID Product A / fresh SDK B 保持 Product A，只记录 `sdkSessionId=B`。未知、缺失或迟到 identity fail closed。

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
| `operation-queue.ts` | direct/queued message operation、每个 operation 的 user-message projection、turn-boundary message/config FIFO（Desktop + busy IM）、drain reservation、generation-based stale dispatch rejection、direct-send tail admission/reset、force/cancel/status | Desktop / IM / Inbox / Background / Injected admission、turn-boundary drain、config deferral、session reset cleanup |
| `turn-lifecycle.ts` | turn completed/success flags、pre-transport promotion token、finalization gate、turn start time、usage/context usage、terminal plan classification、Desktop → IM mirror admission/order | `beforeDispatch` accepted→transport 间 Stop invalidation、`turn_complete` / `session_complete` success/failure/prewarm/idle/user-stop 分类、wait idle、cron/IM true-success gating、mirror user-before-assistant delivery |
| `content-blocks.ts` | streaming text/thinking/tool/subagent content state、tool result/attachment mutation、live/turn snapshot | UnifiedEvent text/thinking/tool/subagent cases、live snapshot、turn persistence snapshot |
| `transcript-persistence.ts` | in-memory `SessionMessage[]`、persisted runtime usage totals、user/assistant append、retry truncate、last assistant read、SessionStore save + metadata preview/context update | restore state、append user/assistant、retry truncate、turn-end SessionStore write；facade 只拿 snapshot/owner API，不拿 mutable message ref |
| `interactive.ts` | permission / AskUserQuestion pending state、active IM request id、IM registry cleanup、inbox/watch reply metadata与错误推送 | permission request/response、AskUserQuestion response、stop/error cleanup、IM complete/error fan-out；permission delivery 成功后才 consume/delete |

边界规则：

- `session-engine/*` 和 `routes/*` 不 import `runtimes/external-session/*` owner modules，只通过 `external-session.ts` public facade。
- `runtimes/external-session/*` 不 import route、SessionEngine 或 `index.ts`。
- `external-session.ts` 需要读写 owner state 时走命名 API；`runtime-boundary.unit.test.ts` 有 facade-state guard，防止 `activeProcess`、operation queue、turn finalization、content raw refs/maps、transcript mutable message ref、interactive pending maps、IM registry、terminal classification helper 回流成顶层裸状态。特别是 facade 不 import/use content raw refs/maps；user/assistant append、retry truncate、last assistant read 与 SessionStore save 归 transcript owner；IM event bus / registry cleanup 与 inbox/watch error delivery 归 interactive owner；terminal success/failure/prewarm/idle/user-stop 分类归 turn-lifecycle owner。External 用户消息的 identity 与 surfaced / in-transcript / persisted / retracted 事实随 accepted operation 存在，由 `operation-queue.ts` 的既有 admission generation 持有；facade 不得再保存 process-scope 的 early-message singleton。`external-session.ts` 仍可保留 watchdog、trace、pending birth等真正 orchestration-local state。
- Phase8 没有抽 builtin/external 通用 runtime framework。两边共享 `session-core/*` pure policy；进程模型和副作用 owner 保持各自 runtime-native。

### `sessionRegistered` 状态

```typescript
let sessionRegistered = false;
```

- `true` —— SDK 已持久化此 session，后续只能用 `resume` 访问
- `false` —— SDK transcript 未证明存在；用 metadata 的 exact SDK candidate 创建，不回退生成其它 identity

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

**新鲜度规则**：若 `lastAssistantUuid ∉ currentSessionUuids`，它不能直接证明 SDK transcript 已失效。已注册 SDK session 只放弃 stale anchor 并裸 resume；确实没有可用 anchor / binding 时，Product Session 不变，只持久化 fresh `sdkSessionId`。

`currentSessionUuids` 是 MyAgents 侧的 freshness cache，不是 SDK transcript 权威。
从磁盘 seed 的 UUID 只能说明 MyAgents store 里存在过该身份；它可用于避免明显
stale 的锚点，但不能证明 `resumeSessionAt` 一定会被 SDK 接受。SDK 报
`No message found with message.uuid` 才是最终拒绝信号；恢复逻辑要驱逐该 UUID，
防止 pre-warm / reload 反复派生同一个坏锚点。

`rewindFiles()` 的 `skippedLinks` 表示 SDK 因 symlink / hard link / 非普通文件安全检查
而没有恢复的文件数。对话截断仍可成功，但该计数必须沿既有 `/chat/rewind` 返回契约
传到 Chat warning，不能把部分文件回溯展示成完整成功；文件路径不进入通知或日志。

### Builtin Rewind 的 identity 与崩溃恢复（0.4.9）

Builtin Rewind 有两条合法路径：SDK anchor 可用时，Product A 与 SDK S1 都不变，只把 `resumeSessionAt` 指向目标前的 assistant；SDK history 不可用时，JSONL 仍在 Product A 下截断，只把 execution binding 从 S1 换成 fresh S2。`setCurrentProductSessionId()`、`clearMessages()`、`resetTranscriptPersistenceForSession()` 与 lazy materialization 都不属于这条路径。

第二条路径同时改变 A 的 JSONL 与 `SessionMetadata.sdkSessionId`，所以 `commitBuiltinConversationRewind()` 使用现有 per-Session lock 和 metadata 内的 bounded intent：`{schemaVersion:1,kind:'builtin-rewind',sourceSdkSessionId,replacementSdkSessionId,sourceMessageCount,targetMessageCount}`。先写 intent，再原子替换 JSONL，最后写 S2、清 intent/usage/context 并重算 stats/preview。恢复只接受 source count（保留 S1、清 intent）或 target count（完成 S2）；count 或 source binding 不匹配时保留证据并拒绝启动。它与 Codex intent 是一个 discriminated union，但不是通用 journal、数据库事务或 renderer 补偿协议。

### Codex root turn 锚点与可恢复 Rewind（0.4.5）

Builtin 的 `sdkUuid` 和 Codex 的 native turn id 是两套独立 identity。Codex 成功 root terminal assistant 额外持久化：

```typescript
runtimeTurnAnchor: {
  turnId: string;
  rootUserMessageId: string;
}
```

`turnId` 由 Codex `turn/start` response 持有，`rootUserMessageId` 是同次 admission 的 MyAgents user row id。失败、中断、child turn、steer 追加和没有精确 admission 的历史消息都不写 anchor。Renderer 只在 exact anchor 存在时展示 Codex Rewind/Fork；服务器仍重新验证 transcript，不能把 UI 门控当 authority。

Codex Rewind 同时改变 JSONL transcript 与 `SessionMetadata.runtimeSessionId`。SessionStore 以 metadata 中单一、bounded 的 `pendingConversationMutation:{schemaVersion:1,kind:'codex-rewind',sourceRuntimeSessionId,replacementRuntimeSessionId,sourceMessageCount,targetMessageCount}` 关闭两文件 crash window：先在既有 per-Session lock 内写 intent，随后同目录 temp + rename 截断 JSONL，最后替换/清除 native binding、清 intent、清 runtime usage/context 并重算 stats/preview。恢复只需要这两个 count 与 source/replacement binding；不持久化恢复器不消费的 message id 或时间字段。恢复时只接受 source count（保留 source、清 intent）或 target count（完成 replacement）；其它 count 或 source binding 不匹配保留证据并拒绝 Runtime 启动。该机制不是通用事务层，不增加 journal 文件、数据库或 renderer 补偿状态。

第一 native Turn 之前的 rewind 以缺失 `runtimeSessionId` 表示，Codex restore 不得回退使用 product Session id；只有 Claude Code legacy history 保留该 fallback。该状态不执行 fresh prewarm，避免持久化不可跨进程 resume 的空 thread；下一条消息由 replacement Sidecar 走正常 fresh-start并回填真正 materialize 的 thread id。存在 native replacement 时，local restore 完成后异步复用既有 prewarm resume；失败不改变 transcript/binding authority。Codex Rewind 只回溯对话上下文，工作区文件保持不变。

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
| 并发写入 | 需要文件锁 | 仍需按 Session 文件锁串行；同一 Session 可被 Tab / Cron / Background 等不同写者提交 |
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
    runtimeTurnAnchor?: {       // 仅成功的 Codex root terminal assistant
        turnId: string;
        rootUserMessageId: string;
    };
}
```

### 写入能力与性能

`loadSessionTranscript()` 在既有 per-Session file lock 内读取 durable rows，并签发仅在当前进程可用的 branded `TranscriptWriteCursor`。cursor 公开 `persistedMessageCount`，私有部分绑定 Session 与 JSONL physical identity；builtin/external owner 只持有该 cursor，不另建行数 cache 或可独立漂移的 persist index。普通 `appendSessionMessages()` 接受 cursor 与新 tail，验证 durable file 仍等于 cursor source 后 O(tail) 追加；live 比 cursor 短或 source 已变化时文件不变，owner 重新 load/rehydrate。

追加后的 stats 只计算新 tail；显式 destructive mutation 才从完整 durable rows 重算 stats/preview：
```typescript
await withSessionFileLock(sessionId, async () => {
    assertCursorMatchesDurableFile(cursor);
    appendFileSync(filePath, serialize(tail)); // transcript commit point
    const incrementalStats = calculateSessionStats(tail);
    await withSessionsLock(() => {
        // sessions.json 派生统计在锁内 read-modify-write
    });
});
```

**文件锁**：JSONL append / rewrite 使用 per-Session `withSessionFileLock`，`sessions.json` 的多 Sidecar read-modify-write 使用全局 `withSessionsLock`。底层走 `withFileLock` / `with_file_lock`（详见 `pit_of_success.md` 的「withFileLock」节）。

JSONL append / atomic replace 是 transcript 的 durability commit point；`sessions.json.stats` 与 preview 等 metadata 是派生投影，后续更新失败只能告警，调用方不得回滚已经落盘的消息。若 append 抛错，SessionStore 在锁内只接受三种可证明状态：旧 EOF 未变、完整 expected suffix 已提交、或 expected suffix 的严格前缀（截回旧 EOF）；其它状态返回 storage consistency error 并使 cursor 失效。Builtin direct 与 turn-boundary user surface 必须在 SDK dispatch 前完成持久化；失败回滚通过 `builtin-admission-rollback` 命名 mutation 先提交 durable target，再撤回 UI/live row，不存在 full-rewrite latch。

缩短/删除不是普通 append 的选项。`mutateSessionTranscript()` 接受 cursor 与 `builtin-rewind`、`sdk-retraction`、`builtin-admission-rollback`、`builtin-transient-retry`、`external-retry` 或 `external-rejected-message` intent，在同一锁内严格读取 durable rows、验证 metadata/cursor/operation 参数、从 source 派生 target 并 temp+rename；`sdk-retraction` 按 durable `sdkUuid` 删除命名 rows，仅允许用 exact message id 额外删除当前 open streaming tail。malformed source 一律拒绝。legacy JSON 迁移先 temp+rename 原子发布 JSONL，成功后才删除 legacy 文件；任何失败保留 source 并向 owner 报错。Builtin/external fork 在写入前验证 target transcript 为空，不能把分支追加到已有历史。只改 transcript 的 builtin rewind 走命名 mutation；同时更换 binding 时走 `commitBuiltinConversationRewind()`；Codex 对应走 `commitCodexConversationRewind()`。两者共用 bounded intent 形状与恢复原则，不抽象成通用事务系统。

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

### 控制请求由 Rust 按 owner / generation 寻址

桌面 Renderer 的普通 Session / Global HTTP 请求只提交相对路径。Session 请求还会提交 `sessionIdHint + SidecarOwner(Tab/Companion)`；Rust 在 `SidecarManager` 锁内找到当前进程 generation，并从该进程的 `DispatchGate` 取得 lease，然后释放 manager 锁，完成请求体发送和响应体物化。响应体完整进入 Rust `HttpResponse` 后立即释放 lease，后续 Tauri / WebKit IPC 投递不再属于 Sidecar 请求生命周期。

进程替换或停止采用同一个两阶段 fence：在 manager 锁内关闭该 exact gate 的新请求准入并保留 generation authority，释放 manager 锁后等待已放行 lease 归零，再以 gate identity 核对并完成移除、恢复或替换。排空期间新 owner 不能附着到旧 generation，stale 完成也不能移除新 generation；同一 Session 的较慢非幂等 POST 因而不会与 replacement 并行，同时一个 Session 的排空不会占用全局 manager、IM Router 或 async runtime worker。应用级 `stop_all` 还必须先通过现有 lifecycle quiesce 关闭进程出生，才能批量 detach 并在锁外排空。

Global 不建立 restart mutex 或第二套候选状态机：`instances[GLOBAL_SIDECAR_ID]` 是唯一进程 authority，`global_sidecar_intent` 仅保存 standing demand。首次启动先把 `process=None` 的 birth reservation 登记到这个唯一槽位，并持有其 gate 的一个私有 lease；端口探测和 spawn 均在 manager 锁外执行，只有 `(generation, gate, intent)` 仍精确匹配才把进程填回该 entry。monitor 将它视为 birth pending，dispatch 则拒绝尚未 ready 的 entry。replacement 在关闭旧 gate 时复用同类私有 lease：普通请求在锁外排空后，旧 entry 仍留在 `instances`，候选进程也在锁外创建；随后按 exact gate 原子替换 entry，再释放 lease。并发 stop 等待同一个 gate，因此不能暴露空 authority 或创建第二个候选。Global generation 直接存于 entry，跨 HTTP await 的健康检查和 restart admission 都核对 `(generation, port)`，即使端口复用也不会误伤新进程。每个 generation 使用独立临时目录，旧候选的锁外清理不能删除新候选资源。

`SessionSidecar` 的 owner 集合是 Tab、Task、Goal 等关联关系的唯一权威来源。Renderer 不维护可写的 owner、port 或 workspace 副本。`ensureSessionSidecar` 已经附加 owner；`reconcile_session_tab_activation` 只确认当前 generation 仍由指定 Tab owner 持有，并释放临时 `BackgroundCompletion` 交接 owner。终端使用的 `MYAGENTS_PORT` 也由 Rust 根据当前 Session entry 生成，Renderer 不传物理端口。

Global Sidecar 使用相同的 per-generation lease。Rust `SidecarManager` 以 `Stopped | DesiredRunning` 保存应用是否仍需要 Global 运行，不能从 `instances`、端口文件或 Renderer 页面状态反推。候选进程的预留、创建或就绪检查失败只清除该候选进程；monitor 看到 `DesiredRunning` 且没有健康进程时，会按有上限的退避继续恢复。只有显式停止 Global、`stop_all`、更新关闭或应用退出才把状态改回 `Stopped`。`~/.myagents/sidecar.port` 只记录当前健康 generation 的端口：旧 generation 退出时删除，新 generation 就绪后再写入。

外部 analytics 走独立 Tauri command 和 proxy-aware client，不能借 Session / Global control command 传 arbitrary absolute URL。登记的数据面 `/refs/:id`、`/attachment/*` 仍允许 native fetch；这不是普通控制面的例外扩张。

### SSE 断连 **不是** 取消权威（load-bearing 不变量）

关 Tab / 网络波动导致 `/chat/stream` 断连，**绝不能**用来取消进行中的 turn。turn 的生命周期归 Rust 的 **Sidecar Owner 模型**（Tab / Companion / Task / Goal / BackgroundCompletion / Agent），不归前端 SSE 连接：

- 零 client 时的 `broadcast()` 是 no-op，turn 照常在 sidecar 跑完并持久化；重连后由 `chat:message-replay` 补发。
- 真正卡死的 turn 由 10 分钟 inactivity watchdog 收口（见 `agent-session.ts` / `external-session.ts`，原语 `utils/inactivity-watchdog.ts`）。
- 用户主动放弃用 **Stop**（`interruptCurrentResponse`），不是关 Tab。

历史教训：`390d38ee`（4-25）曾给 `/chat/stream` 加 last-consumer grace interrupt，把"关 Tab"误当"杀 turn"，regress 了 BackgroundCompletion 与 cron/session-send（turn 被 interrupt → `[ERROR turn_failed]` 投回飞书）。最终修法是**彻底删除该 interrupt**；`index.ts` 留有 load-bearing 注释禁止复活。改 SSE 断连相关逻辑前 MUST 理解这条。

Tauri 的 `/chat/stream` 由 Rust 按 `connectionKey` 维护长期连接。每次连接尝试都使用 `sessionIdHint + SidecarOwner` 向 `SidecarManager` 查询当前已就绪端口；连接失败、非 2xx、响应体错误、读取超时和 EOF 使用同一套有上限的退避重试。

SSE 流可以长期运行，但分隔符之前的单个事件最多为 8MiB。超限属于独立的协议错误，不计为传输进展，也不会把退避时间重置为 250ms；诊断只记录字节数，不记录 payload，下一次 transport generation 仍可正常连接。Renderer 不缓存 SSE URL，也不依赖一次性 error 事件重建代理；`start_sse_proxy` 的返回只表示订阅已经登记。

订阅 replacement generation 防止旧任务清理或写入新订阅；Rust 的 transport generation 随 `{ transportGeneration, data }` envelope 转发，供 Renderer 识别物理连接边界。普通 Tab 与 Floating Ball 共用该传输层；Floating Ball 只接收重连后的实时事件，不负责普通 Chat 的完整快照恢复。

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
| 9 | `restorePersistedSession` | 用户加载历史会话 |

### 会话历史恢复：REST 单一权威（#0608，load-bearing 不变量）

上面的「新会话」靠 `isNewSessionRef` skip 旧事件；**恢复一个已存在会话的历史**是另一条路径，权威源不同。恢复历史的**唯一权威 = REST `GET /sessions/:id`**（磁盘、分页、有序；active session 已 merge 内存未持久化消息）。SSE `chat:message-replay` 让位——它是**重载**事件：SSE-connect 冷历史 backfill **＋** 新发 user/command 气泡的 live echo。

- `TabProvider` 只维护一个同步镜像的 persisted restore lifecycle：`inactive / restoring / ready / failed`，并让 UI state 与 event-handler ref 执行同一套迁移。初始 prop 已是真实 persisted Session 时，state initializer 就进入 `restoring`，不能等待 passive effect；这样任何 SSE cold replay 到达前，首屏 owner 已经成立。`isSessionLoading`、错误壳、发送门禁与“是否已 REST restored”都从该 lifecycle 派生，不再由多个 loading / restored flag 互相校正。
- 冷历史 backfill 打 `replayKind:'cold-history'`，并使用 builtin/external `SessionEngineStreamReplaySnapshot.sessionId` 携带 snapshot scope；snapshot还携带active assistant。external adapter在pending→real启动窗口优先采用已promoted的bound Session，并从既有immutable live snapshot投影accepted in-memory user message与assistant前缀。`/chat/stream` 必须在注册新client前同步取得snapshot，避免snapshot flush把事件排到初始化之前；scope与assistant snapshot合入既有`chat:init`，Renderer按identity/content原子采用并保留structured blocks，只有之后的真实`chat:message-chunk`才按delta追加。新发user/command气泡打`replayKind:'live-user-echo'`并携带创建事件时的`sessionId`。REST-restored session只skip cold history；new session birth只接受通过当前Session scope校验的live echo或cold reconnect snapshot。Route只能消费SessionEngine public facade，不能读取adapter internal或从message推导identity。决策纯核心`sessionRestoreGuards.ts`（可单测）。
- `GET /sessions/:id` 的 active overlay 由 `SessionEngine.getLiveSessionOverlay()` 提供：磁盘历史先与 finalized in-memory tail 按 message id 合并，当前 streaming assistant 独立返回，同时带 live session state、pending interactive requests 与 `snapshotRevision`。builtin/external public facade 都返回 immutable snapshot；Route 只做分页、redaction、response shaping，不直接读取 runtime owner internal。
- `restorePersistedSession` 是只读投影：创建 `AbortController`，读取并统一 normalize structured blocks、JSON-stringified `ContentBlock[]` 与 plain text，提交前核对 `target + restoreToken + connectionGeneration`，再原子替换 history；它不调用 `/sessions/switch`，不修改 App Tab identity，也不改变 Node runtime binding。公开 context 只暴露不接受 target 参数的 `retryCurrentSessionRestore()`，因此调用方不能借恢复 API 跨 Session；普通事件不能越过 `failed` 自动重试，只有用户显式重试或 Rust 发布新的 `session-sidecar:restarted` 进程 epoch 才能生成新 token。Tab 关闭、target 变化或 token/generation 替换会 abort 或静默丢弃旧结果。
- 需要与快照对齐的非幂等 streaming/turn-boundary/interactive SSE 事件由 `participatesInLiveRestore()` 统一选择并包成 `{ sessionId, liveRevision, payload }`。Sidecar 在暴露 snapshot 前先 flush coalesced chunk，因此 `snapshotRevision` 覆盖快照已包含的全部事件。Renderer 在 REST pending 时 buffer；快照落地后丢弃 `revision <= snapshotRevision`，只按序 replay 连续后缀。发现 gap 或没有已采纳基线时，重新请求 REST snapshot，不用 `loading/seenIds` 猜顺序。
- transport generation 变化本身不是历史不连续：同一 Sidecar 上，新 generation 的第一条 revision 若等于 `lastAppliedRevision + 1`，fence 更新 generation 后直接投影，不重新请求 REST、不显示 loading；重复 revision 继续丢弃。只有真实 gap 才进入同一 lifecycle recovery。Recovery 有 overlap 时保留 older prefix 并权威替换 recent tail；无 overlap 时整体采用 snapshot，随后恢复 live assistant/state/interactive requests 并 replay 连续 buffer。持续 gap 只允许一次自动 follow-up snapshot，随后进入 `failed`、保留可信内容并由同一个 `ChatBootOverlay` 覆盖所有 action boundary；普通 revision 继续隔离，用户显式重试或新的 Rust replacement epoch 可在同一 target 上生成新 token。
- `liveRevision` 是当前 Sidecar 进程内、绑定 Session 的内存序号，Session identity 切换或 Sidecar replacement 时归零；它不写 JSONL、不做 checkpoint，也不改变 REST 的历史权威。Rust 发出 `session-sidecar:restarted` 后，Renderer 必须立即废弃旧 baseline 并从 REST 重建新 epoch；不能仅凭 transport generation 猜测进程是否更换。新 Session 在首次被 REST adopt 前仍可走 SSE-native birth，避免为尚未持久化的会话制造恢复状态机。
- 诊断"恢复只显示一部分"：读磁盘 `~/.myagents/refs/<id>` 的 spilled body（后端实发的 JSON，可直接 `node` 解析）对比前端显示，先把"后端发了什么 vs 前端显示什么"一刀切开。

### Turn terminal 与通用完成通知

builtin/external 的 turn owner 在 complete/stopped/error 时生成同一份不可变 `SessionCompletionTerminal`：`sessionId + workspacePath + turnId + optional turnOwner + origin + status`。该描述保存在各 Runtime 已有的 turn lifecycle state 中；terminal SSE payload 与 `GET /api/session-state` 返回同一事实，route 和 Rust 调用方不重新推断 owner/origin。新 turn 被接纳或 Session reset 时会清除上一份描述。

Rust `notification.rs` 是普通 Session 通用完成通知的唯一业务 owner：有 Tab 的路径由 SSE proxy 提交，无 Tab 的路径由 `BackgroundCompletion` 在 active→terminal 后从 `/api/session-state` 提交。两条路径都必须先向 `SidecarManager` 的当前 generation 申请一次性资格；资格集合存放在对应 `SessionSidecar`，键为当前逻辑 session id 与 turn id。旧 generation 的迟到事件会被拒绝，pending→real 改名仍沿用同一进程 generation。取得资格后，`notification.rs` 再统一判断 owner/origin、窗口焦点、通知偏好、系统通知、badge 和 session/workspace deep-link。

Task/Goal owner、Agent Channel、automation/Cron/Task run、Memory 与 Heartbeat 不发送通用通知，仍由各自领域负责；普通桌面对话、registered-agent/Space 与 Session Inbox 可以发送通用通知。一次性资格随对应的 Sidecar generation 一起回收，不持久化，也不新增通知账本、TTL 或重放机制。`TabProvider` 只维护终态 UI 和未读状态，不负责操作系统完成通知。

transport 断线窗口内 turn 仍照常完成并持久化；普通 Chat 的新 generation REST snapshot 恢复 finalized history 与 idle/error UI。现有 live terminal → Rust notification claim 路径保持不变，但不为断线补交通知新增 replay/outbox/ack，因此不能承诺断线窗口的 OS completion notification。

### 会话快照类 SSE 必须按 session scope 过滤

Tab 级 SSE 连接只能保证“事件来自这个 Tab 当前连着的 sidecar 端口”，不能单独保证“事件仍属于这个 Tab 当前展示的 session”。既有 Session revive、新对话 birth、pending session materialization、Sidecar key handover 都可能让旧 sidecar/旧连接的缓存或 live 事件晚到。

反过来也不能把 connection 创建时的 Session label 当作业务 authority：`connectionKey + SidecarOwner` 拥有长期 transport，Session key 可在同一 Sidecar 内通过 pending→real、桌面 reset 或已确认 surface migration 升级。pending→real 只接受 exact Tab owner；real→real 的桌面联合迁移必须在 Node mutation 前证明 source 的完整 owner 集合恰好为发起 `Tab(tabId) + Agent(sessionKey)`，并让 Router、manager、Runtime 与 renderer 采用同一个 Rust 生成的 target ID。IM `/new` 不是这种迁移：它只轮换 Agent binding、释放旧 Agent owner，旧 Tab 与 Sidecar identity 留在 A，新 binding B 等首条 IM 消息按既有 ensure 路径实体化。SSE status callback只报告liveness，attachment identity由connect/reset/migration operation拥有。birth marker不参与transport裁决，离开exact target即清理。带scope事件在live-revision dispatch前按`payload.sessionId === currentSessionId`裁决，旧A payload自然丢弃，B payload即使经A时期建立的physical stream送达也合法。普通历史导航不复用该 identity upgrade：App 必须 new / jump / revive 目标 Tab。

凡是会更新 Tab 会话快照或展示阻塞式交互 UI 的 SSE 事件，payload MUST 带 `sessionId`，前端 MUST 先通过 `src/renderer/context/sessionScopedEventGuards.ts::shouldAcceptSessionScopedSseSnapshot()` 或 `decideSystemInitSessionId()` 过滤，再写 React state。当前范围包括：

- `chat:system-init`：既是 runtime/config 快照，也是新 session birth 信号；只有 pending/null/reset → concrete id 的 birth 窗口允许同步 Tab sessionId，普通历史导航中的 mismatch 一律视为 stale。
- `chat:runtime-tool-catalog`：external runtime 工具目录的可变快照；必须按 sessionId 过滤，重连时由既有 `chat:system-init` replay snapshot 恢复，不能另建第二份 replay 状态。
- `chat:message-replay`：`live-user-echo` 既是用户气泡，也是 server-initiated turn 结束 new-session stale window 的有序边界；`cold-history` 只闭合 stream attach/reconnect snapshot 窗口。两者都必须带各自创建 snapshot/event 时的 `sessionId`；REST-restored Session 仍拒绝 cold history。
- `queue:started`：排队消息正式 promotion 后的用户气泡与 turn 边界；必须带 promotion 所属的 `sessionId`，guarded Goal 只能在 admission accepted 后发送。
- `permission:request` / `permission:expired`
- `ask-user-question:request` / `ask-user-question:expired`
- `exit-plan-mode:*` / `enter-plan-mode:*`

允许 connection label 暂时落后 current Session 的只有已证明复用同一 Sidecar 的 identity upgrade：pending→real、desktop reset 或已完成 surface migration。无论 connection label 如何，payload session 与 current concrete Session 不一致都必须丢弃；历史导航必须通过目标 Tab 的 new / jump / revive，不得把该例外扩展成 real→real hot-swap。新增 request/expired 类 SSE 时，如果它会弹 UI、清 UI、改变 plan-mode 或改变 current session snapshot，必须先把 `sessionId` 加到后端 broadcast / pending replay payload，再接入这层 guard；不要只依赖 Tab-scoped SSE channel。

### Sidecar 配置归置：`sidecarConfigDisposition`（push / adopt / pending，0.2.31）

Tab 翻成 chat 时，Chat 要决定**如何与该 session 的 sidecar 对齐配置**（MCP / agents / model / permission / 插件 / 外部 runtime prewarm）。这是 `Tab.sidecarConfigDisposition` 三态（`src/renderer/types/tab.ts`，**必填**——编译器强制每个 Tab 构造点选择）：

- **`push`** — 把本 tab 的配置推给 sidecar（新起的 sidecar）。
- **`adopt`** — 采纳已在跑的 sidecar 的现有配置、**不推**（接管 IM / Task / Goal / background 占用的 sidecar）。
- **`pending`** — 还不知道：tab 在 sidecar ensure **之前**就 instant-flip 到了 chat（即时进入）。此态下 Chat **既不推也不采纳**，等裁决。

**唯一裁决者**：`ensureSessionSidecar` 返回的 `result.isNew`（在 Rust manager 锁内决定）是 `pending → push|adopt` 的**唯一**来源。新 Session 由 `handleLaunchProject` 创建；已有 Session 的单目标导航只经 `handleOpenTargetSession`，顶部批量恢复与普通导航共同复用 `materializeExistingSessionTab`，并最终由 `reconcileExistingSessionTabOwner` 裁决 exact Tab owner。任何路径都不得用端口探测预测配置方向。

**为什么是三态（#300/#301 实战）**：旧的 `joinedExistingSidecar?: boolean` 有个表达不出的第三态（`undefined → ?? false → push`），instant-flip 时被迫用 `getSessionPort` 预测 → 并发 Rust creator（Task / Goal / IM / 崩溃重启）在"检查"与"ensure"之间起了 sidecar → ensure 接管活的 sidecar，而 Chat 把配置推上去 → **config-stomp + MCP 指纹 abort + 30s 重启循环**（TOCTOU）。三态把"还没定"变成一等公民。

**红线（Pit of Success，改 Chat 配置同步 / 新增 session 打开路径前必读）**：
- Chat 里**任何**"mount 期把配置推给 sidecar"的 effect MUST 门控 `configDispositionRef.current === 'push'`（`pending`/`adopt` 跳过）。漏一个 = 静默 config-stomp。
- **依赖不对称**：推送 effect 依赖布尔 `configPending`（`pending→push` 重跑，`adopt→push` 不重放）；采纳 effect 依赖 `isAdopt`（`pending→adopt` 触发一次）。写反 = 漏推或重复采纳。
- 用户**主动**改配置（`persistTabConfigChange`）走 **defer-while-pending**（仅 `pending` 时延迟推送、磁盘照写；`push`/`adopt` 都推——用户意图）。
- `pending` tab **不得携带 `initialMessage`**（否则 autoSend 的未门控推送会在归置裁决前触发）。
- 已有 Session 的单目标用户入口 MUST 走 `handleOpenTargetSession`：未打开时由 `spawnTabForExistingSession` 建 Tab，已打开时 jump；两者都调用 `materializeExistingSessionTab`。顶部恢复按钮只批量编排既有 persisted targets：先校验，再一次提交最终 live Chat Tabs / active correlation，然后为每个仍存在的 Tab 独立调用同一 materialization。该 helper 通过 `reconcileExistingSessionTabOwner` 为精确 Tab owner 幂等执行 ensure，再由 Rust 确认当前 generation 仍包含该 owner，并释放临时 `BackgroundCompletion` 交接 owner。批量恢复的所有 Tab 首帧仍挂载真实 `TabProvider`，但重型 `Chat` 视觉子树必须 active-first：provider-owned 启动壳先绘制，active Chat 在下一次 post-paint commit reveal，inactive Chat 到首次选中后 reveal，且 reveal 后保持挂载。禁止把视觉 deferral 退化成依赖首次切换才挂载 `TabProvider` 的无 owner 空壳，禁止 Renderer 维护 owner/port 副本，也禁止使用 `hasSessionSidecar → ensure` 的 TOCTOU 两阶段判断。
- replacement / recovery commit 属于 Rust ensure 流程：旧进程进入 `recovering_sidecars` 后，同一个 manager entry 保留完整 owner 集合、独立 `recovery_epoch`、`dead_generation`、候选 generation、尝试次数和下一次重试时间。owner release 在候选进程等待就绪期间仍同时更新候选进程与恢复记录；候选 generation 的预留、创建、TCP/ready 失败都不会结束 recovery epoch。快速重试用尽后转为有频率上限的慢重试；update quiesce 只暂停派发，解除后 active 和 recovering entry 会重新进入扫描。只有就绪候选进程原子接管剩余 owner、owner 全部释放或 Session 被删除，才结束该 epoch；恢复失败不能冒充“已没有 owner”的终态。Renderer 不复制 owner、端口或重试队列。
- Global recovery 也把“应用仍需要 Global”与“当前候选进程”分开，但使用更小的状态模型。`DesiredRunning` 在候选进程失败后继续保留；`instances`、当前 generation 和 CLI 端口文件都不能决定是否继续恢复。Global monitor 原子读取 `Stopped | DesiredMissing | Present`：`DesiredMissing` 按与不健康进程替换相同的有界退避重试，成功后才发布健康 generation 和 restarted event。Global 不进入 `recovering_sidecars`；Renderer、请求重放和端口文件也不能另建一套恢复状态。
- `BackgroundCompletion` 是逻辑 Session owner，poller 只保存 Session 和期望的进程 generation，不长期保存端口。首次 activity probe 后附加 owner 也由 manager 处理：若 probe 期间发生进程替换，manager 在同一把锁内把 owner 绑定到当前可复用进程，或保留在 recovery entry 中等待新进程就绪；若当前进程已死但 monitor 尚未迁移，附加操作会先完成 dead→recovery。每轮 poll 都从 manager 解析当前 `(port, generation)`，HTTP 返回后再次校验同一 binding；终态提交和 owner release 也必须在 manager 锁内匹配精确 generation。旧 generation 的 idle/running/HTTP failure 响应一律丢弃，不能终止或释放新 generation。用户 reconnect/cancel 则按逻辑 owner 同时覆盖 active/recovering 间隙。
- Rust 是 Sidecar process epoch 的唯一 authority；共享 ensure authority 每次实际创建进程都发 `session-sidecar:restarted`。TabProvider 只处理当前绑定 Session，既能在 replacement 时重置 live revision baseline，也不会让无绑定消费者为首次创建建立第二套状态。

即时进入还包含 `ChatBootOverlay` 的"AI 启动中"毛玻璃蒙层（翻页瞬时出现、就绪时淡出衔接），它同时是 App 的 lazy-Chat Suspense fallback。

从全局侧栏等资源入口“在新 Tab 打开已有 Session”时，`spawnTabForExistingSession` 必须用 `flushSync` 先把带真实 `sessionId`、`view:'chat'`、`sidecarConfigDisposition:'pending'` 的 Tab 加入并激活，再等待 `ensureSessionSidecar` 与 Tab owner 确认。这里仍用 functional `setTabs` 与既有 render-mirror `tabsRef`，禁止提前手写 `tabsRef.current` 形成第二 authority。Chat owner 子树立即挂载，由 `ChatBootOverlay` 覆盖进程启动窗口；不能用 `isLoading` 条件替换整个 `TabProvider/Chat`，否则会破坏 SSE/Session 生命周期。ensure 完成只结算 `pending → push|adopt`，不得再次强制 active（用户可能已主动切走）。ensure 或 owner 确认失败则移除临时 Tab；只有它仍是 active 时才恢复仍存在的前一 Tab。planner 必须先于 Tab 构造运行，避免把刚预塞的 Tab 误判为既有 owner。侧栏 flyout / 搜索 overlay 的关闭只消费 active Tab projection 与发起时的 resource-surface interaction generation；Sidecar 的晚到完成不是 UI authority。

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
- IM 仍通过每轮 `ExternalSendContext` 读取实时配置。Task 配置只用于初始化新 Session；已有 Session 继承自己的配置，Rust 为 adopt 构造的 payload 不携带 model/provider/runtime/MCP 初始化字段。新 Task Session 的 metadata 创建权由 scheduler 在 per-Session lifecycle guard 内根据 `SessionStore` 决定，不能绑定到 Sidecar 的 `EnsureSidecarResult.isNew`。同一个 guard 会共享给 Sidecar ensure，并保留到 metadata 创建完成或该次精确执行被确认终止；Node 在同一串行边界内处理 dispatch 授权、Stop 取消和 `createSession()`。完整事务与异常路径见 `task_center.md`。
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
| `src/renderer/App.tsx` | `handleLaunchProject`（只创建新 Session）、`handleOpenTargetSession`（已有 Session 单目标导航 owner）、`materializeExistingSessionTab`（导航 / 批量恢复共用 live materialization）、`reconcileExistingSessionTabOwner`（exact owner 编排）、各 Tab 构造点 disposition 映射 |
| `src/renderer/pages/Chat.tsx` | 9 个 disposition 门控的配置同步 effect + `persistTabConfigChange` defer-while-pending |
| `src/renderer/components/ChatBootOverlay.tsx` | "AI 启动中"蒙层 + 淡出过渡 |
| `src/server/types/session.ts` | `SessionMetadata` 类型定义、`createSessionMetadata()` |
| `src/server/SessionStore.ts` | 存储层实现 |
| `src/server/agent-session.ts` | builtin SDK public facade + session orchestration glue、`switchToSession()`、system-init 处理 |
| `src/server/builtin-session/turn-lifecycle.ts` | builtin SDK result/stopped/error terminal 语义、usage stamping、IM/inbox/watch/analytics/title hook 顺序 |
| `src/server/builtin-session/transcript-persistence.ts` | builtin transcript ↔ SessionStore mapping、tail-only persist chain、load/cursor seeding、命名 destructive mutation |
| `src/renderer/api/sessionClient.ts` | 前端 API 客户端 |
| `src/renderer/utils/formatTokens.ts` | Token / 时长格式化工具 |
| `src/renderer/context/TabProvider.tsx` | 前端 reset / 防护标志 |

## 相关文档

- `ARCHITECTURE.md` 的核心抽象「Sidecar Owner 模型」「持久 Session」「Pre-warm 机制」
- `ARCHITECTURE.md` 的模块「既有 Session 打开与持久历史恢复」（new / jump / revive + 分层 config snapshot）
- `pit_of_success.md` 的「withFileLock」「Snapshot Helpers」
- `multi_agent_runtime.md` 的「External Session Handler」（外部 Runtime 的会话生命周期）
