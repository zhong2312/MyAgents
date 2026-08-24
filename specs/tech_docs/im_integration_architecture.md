# MyAgents IM 集成技术架构

## 一、核心架构决策

### 1.1 分层解耦：IM in Rust, AI in Node.js

| 层 | 职责 | 实现语言 | 理由 |
|----|------|---------|------|
| **IM 适配层** | Telegram/飞书/钉钉 连接管理、消息收发、重连、白名单 | Rust | I/O 密集型，零 GC、稳定性高，崩溃不影响 IM 连接 |
| **Plugin Bridge 层** | 加载 OpenClaw 社区 Channel Plugin，代理消息收发 | Node.js 独立进程 | 兼容 TS 生态插件，故障隔离于独立进程 |
| **Session 路由层** | peer→Sidecar 映射、按需启停、消息缓冲 | Rust | 复用 SidecarManager，统一进程生命周期管理 |
| **AI 对话层** | Claude SDK、MCP、工具系统、Session 管理 | Node.js Sidecar | 已有完整生态，不值得用 Rust 重写 |

**关键优势**：
1. **故障隔离**：AI 进程（Node.js）崩溃 → Rust IM 层继续收消息、缓冲 → 自动重启 Node.js Sidecar → resume Session → 用户无感
2. **资源高效**：IM 连接在 Rust，额外内存 < 5MB
3. **连接稳定**：Rust 长轮询天然适合 always-on 场景

### 1.2 多 Bot 架构

支持同时运行多个 IM Bot 实例，每个 Bot 拥有独立的配置、连接、Session 和健康状态。

```
┌─────────────────────────────────────────────────────────────────┐
│ Tauri Desktop App │
├──────────────────────────────────────────────────────────────────┤
│ React Frontend │
│ ┌────────────┐ ┌────────────┐ ┌─────────────────────────────┐ │
│ │ Chat Tab │ │ Chat Tab │ │ Settings → 聊天机器人 │ │
│ │ Tab Sidecar│ │ Tab Sidecar│ │ ┌─────┐ ┌─────┐ ┌─────┐ │ │
│ └──────┬─────┘ └──────┬─────┘ │ │Bot 1│ │Bot 2│ │Bot 3│ │ │
│ │ │ │ └──┬──┘ └──┬──┘ └──┬──┘ │ │
├─────────┼───────────────┼────────┼─────┼──────┼──────┼───────┤ │
│ ▼ ▼ │ ▼ ▼ ▼ Rust │ │
│ ┌─────────────┐ ┌───────────┐ │ ManagedImBots │ │
│ │ Tab Sidecar │ │Tab Sidecar│ │ HashMap<String, ImBotInstance│ │
│ │ :31415 │ │ :31416 │ │ ├── bot_1 → Instance │ │
│ └─────────────┘ └───────────┘ │ │ ├── TelegramAdapter │ │
│ │ │ ├── SessionRouter │ │
│ │ │ ├── HealthManager │ │
│ │ │ └── MessageBuffer │ │
│ │ ├── bot_2 → Instance │ │
│ │ └── bot_3 → Instance │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
 │
 ┌───────────┼───────────┐
 Telegram API Feishu WS Plugin Bridge (Node.js)
 ↕ HTTP
 OpenClaw 社区插件
 (QQ Bot, Matrix, …)
```

---

## 二、Rust 侧实现

### 2.1 核心数据结构

```rust
/// 多 Bot 管理容器（Tauri State）
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// 单个 Bot 实例
pub struct ImBotInstance {
 pub bot_id: String,
 pub shutdown_tx: watch::Sender<bool>, // 优雅关闭信号
 pub health: Arc<HealthManager>, // 健康状态持久化
 pub router: Arc<Mutex<SessionRouter>>, // peer→Sidecar 映射
 pub buffer: Arc<Mutex<MessageBuffer>>, // 离线消息缓冲
 pub started_at: Instant, // 用于计算 uptime
 pub process_handle: JoinHandle<()>, // 消息处理主循环
 pub bind_code: String, // QR 绑定码 "BIND_{uuid8}"
 pub config: ImConfig, // 运行时配置快照
}
```

### 2.2 Tauri Commands（Legacy，已 Deprecated）

> 以下旧命令已标 `@deprecated`，内部转发到新 Agent Channel API。新代码应使用 `cmd_start_agent_channel` 等新命令（见文档末尾"Agent Channel 架构"章节）。

```rust
/// @deprecated — 使用 cmd_start_agent_channel 替代
#[tauri::command]
async fn cmd_start_im_bot(
 botId: String,
 botToken: String,
 allowedUsers: Vec<String>,
 permissionMode: String,
 workspacePath: String,
 model: Option<String>,
 providerEnvJson: Option<String>,
 mcpServersJson: Option<String>,
 availableProvidersJson: Option<String>,
 botName: Option<String>, // Bot 显示名称，传入系统提示词
) -> Result<ImBotStatus, String>;

/// 停止指定 Bot
#[tauri::command]
async fn cmd_stop_im_bot(botId: String) -> Result<(), String>;

/// 查询单个 Bot 状态
#[tauri::command]
async fn cmd_im_bot_status(botId: String) -> Result<ImBotStatus, String>;

/// 批量查询所有 Bot 状态
#[tauri::command]
async fn cmd_im_all_bots_status() -> Result<HashMap<String, ImBotStatus>, String>;

/// 获取 Bot 的对话列表
#[tauri::command]
async fn cmd_im_conversations(botId: String) -> Result<Vec<ImConversation>, String>;
```

### 2.3 Bot 生命周期

#### 启动流程（`start_im_bot()`）

```
cmd_start_im_bot(botId, botToken, ...)
 │
 ├── 若同 botId 已在运行 → 优雅停止（等待 5s 收尾）
 │
 ├── 迁移遗留文件（v1/v2 → v3 子目录）
 │ └── im_state.json / im_{botId}_*.json → im_bots/{botId}/*.json
 │
 ├── 初始化组件
 │ ├── HealthManager（加载上次状态）
 │ ├── MessageBuffer（恢复磁盘缓冲）
 │ └── SessionRouter（恢复 peer→session 映射）
 │
 ├── 创建 TelegramAdapter
 │ └── 传入 allowed_users: Arc<RwLock<Vec<String>>>
 │
 ├── 验证连接
 │ └── getMe() → 获取 bot_username
 │
 ├── 注册 Bot 命令
 │ └── setMyCommands: /new, /workspace, /model, /provider, /status
 │
 ├── 初始化运行时共享状态
 │ ├── current_model: Arc<RwLock<Option<String>>>
 │ └── current_provider_env: Arc<RwLock<Option<Value>>>
 │
 ├── 启动后台任务
 │ ├── 消息处理主循环（tokio::spawn）
 │ ├── Telegram 长轮询（listen_loop）
 │ ├── 健康状态持久化（5s 间隔）
 │ └── 空闲 Session 回收（60s 间隔）
 │
 ├── 生成绑定 URL
 │ └── https://t.me/{username}?start=BIND_{uuid8}
 │
 └── 返回 ImBotStatus（含 bot_username、bind_url）
```

#### 关闭流程（`stop_im_bot()`）

```
cmd_stop_im_bot(botId)
 │
 ├── 发送 shutdown 信号（watch channel）
 ├── 等待 process_handle 完成（超时 10s）
 ├── 持久化缓冲消息到磁盘
 ├── 持久化活跃 Session 到健康状态
 ├── 释放所有 Sidecar Session
 └── 设置状态 Stopped，写入最终状态
```

#### 应用启动自动恢复

```
Tauri app 启动
 │
 └── 遍历 config.imBotConfigs[]
 └── 若 enabled == true && botToken 非空
 └── cmd_start_im_bot(...)
```

### 2.4 消息处理循环

**并发模型**：

```
Per-Message Task:
1. 获取 per-peer 锁（同一用户/群消息串行化）
 ↓
2. 获取 global semaphore（GLOBAL_CONCURRENCY = 5）
 ↓
3. 短暂锁 router（ensure sidecar/consumer + enqueue request）
 ↓
4. `/api/im/events` consumer 按 requestId 接收事件并由 ReplyRouter 渲染回复
 ↓
5. Sidecar 不可用时缓冲入站消息；恢复后重新入队，回复仍按 requestId 归属
```

**命令分发（无需 Sidecar I/O）**：

| 命令 | 行为 |
|------|------|
| `/start BIND_xxxx` | QR 绑定：添加用户到白名单，发射 `im:user-bound` 事件 |
| `/start` | 显示帮助文本 |
| `/new` | 先按 exact Session ID 向 SessionStore 做无副作用分类；仅冻结仍有 metadata 的旧 Session，missing/stale binding 直接轮换；旧 Session 只释放 `Agent(session_key)` owner，新 ID 延迟到首条普通消息实体化 |
| `/workspace [path]` | 显示/切换工作区 |
| `/model [name]` | 显示/切换 AI 模型（支持快捷名：sonnet, opus, haiku） |
| `/provider [id]` | 显示/切换 AI 供应商 |
| `/status` | 显示 Session 信息 |

**普通消息处理（IM Pipeline v2：enqueue + event bus）**：

```
收到普通消息
 │
 ├── ACK：setMessageReaction(⏳) + sendChatAction(typing)
 │
 ├── ensure_sidecar()：获取/创建 Sidecar
 ├── 若新 Sidecar → 同步 AI 配置（model + MCP servers）
 │
 ├── ensure_im_consumer()：每个 peer_session 保持一个 /api/im/events long-poll SSE consumer
 ├── ReplyRouter 预注册 requestId → draft/reply slot
 ├── POST /api/im/enqueue → 同步 ACK（含 requestId、runtime/config、群聊上下文）
 │ └── Node Sidecar 通过 SessionEngine enqueue 到 builtin/external runtime
 │     ├── idle external：等待既有 adapter admission 结果，不把启动/配置错误伪装成排队成功
 │     └── busy external：现有 turn-boundary FIFO 接管后立即返回 accepted
 │
 ├── /api/im/events 推送带 requestId 的事件
 │ ├── "partial" 事件 → ReplyRouter 节流编辑消息（≥1s 间隔，截断平台限制）
 │ ├── "block-end" 事件 → 定稿（超长则分片发送）
 │ ├── "complete" 事件 → 返回 sessionId，slot terminal
 │ ├── "permission-request" / "ask-user-question-request" → 原生卡片或文本 fallback
 │ └── "error" / "cancelled" / "ask-user-question-expired" 事件 → 删除 draft / 失效 pending，发送反馈
 │
 ├── 清除 ACK：setMessageReaction("")
 ├── 更新 Session 状态：record_response(session_key, sessionId)
 ├── 更新健康状态：last_message_at, active_sessions
 │
 └── 重放缓冲消息（若有）
```

**Runtime identity drift**：

IM / Agent Channel 属于 live-follow owner，但 peer session 仍必须绑定执行 runtime identity。Router 在普通消息、heartbeat、`/model` 命令唤醒 Sidecar 前比较 desired identity 与 persisted / live sidecar identity；只要 `runtime` 或 `runtimeSource` 任一变化，就 reset peer session 并释放旧 Sidecar，随后新建会话。`codex/system-cli`（外部 Codex CLI）与 `codex/managed-provider`（Codex 订阅 Provider）必须视为不同身份；`codex-sub` 选择路径要把 `RuntimeConfig.source:'managed-provider'` 传入 drift check，不能只传 `runtime:'codex'`。

配置热更新也必须在同一个 owner / scope 比较 identity：旧值取每个运行中 `ImBotInstance` 的有效 runtime，新的值由完整的落盘后 `AgentConfig + ChannelOverrides` 重新投影；只轮转有效 identity 真正变化的 Channel。`AgentConfig.runtime/runtimeConfig` 是 provider-facing 的原始默认值（managed Codex 可合法保存为 `builtin`），不能和 Channel 的投影结果直接比较，也不能在 `AgentInstance` 上缓存成“有效 runtime”。同一 managed Provider 内仅切换模型不轮转 session。

### 2.5 Telegram Adapter

```rust
pub struct TelegramAdapter {
 bot_token: String,
 allowed_users: Arc<RwLock<Vec<String>>>, // 可热更新白名单
 client: reqwest::Client, // LONG_POLL_TIMEOUT + 10s
 coalescer: Arc<Mutex<MessageCoalescer>>, // 碎片合并 + 防抖
 bot_username: Arc<Mutex<Option<String>>>, // getMe() 后缓存
}
```

**ImAdapter Trait**：
- `verify_connection()` → `getMe()` 验证 Token
- `register_commands()` → `setMyCommands()` 注册命令菜单
- `listen_loop()` → `getUpdates` 长轮询，指数退避重连
- `send_message()` → 自动分片 + Markdown 降级 + 纯文本 fallback
- `ack_received/processing/clear()` → `setMessageReaction` emoji 管理

**MessageCoalescer（碎片合并 + 防抖）**：
- 缓冲 ≥4000 字符的消息为 fragments
- 合并连续 fragments（<1500ms 间隔 + 同 chat_id）
- 非 fragment 消息立即返回（不防抖）
- 500ms 超时后刷出合并结果

**白名单**：
- 空白名单 → 拒绝所有消息（安全默认）
- 检查 user_id 和 username
- QR 绑定请求（`/start BIND_`）绕过白名单
- 群聊需 @mention 或 `/ask` 前缀

**错误处理**：

| 错误类型 | 处理策略 |
|----------|---------|
| 429 Rate Limited | 等待 `retry_after` 秒后重试 |
| 500/503 瞬态错误 | 3 次重试，1s 退避 |
| 401 Unauthorized | 停止长轮询 |
| Markdown 解析失败 | 降级纯文本重发 |
| 消息未修改 | 静默忽略（Draft Stream 常见） |
| 消息过长 | 自动分片（4096 UTF-16 code unit 限制） |

### 2.6 Session Router

```rust
pub struct SessionRouter {
 peer_sessions: HashMap<String, PeerSession>, // peer→session 映射
 sidecar_manager: Arc<ManagedSidecarManager>,
 default_workspace: PathBuf,
 global_semaphore: Arc<Semaphore>, // 默认 5 并发
 peer_locks: HashMap<String, Arc<Mutex<()>>>, // 同一 peer 串行化
}
```

**Session Key 设计**：
```
私聊： im:telegram:private:{user_id}
群聊： im:telegram:group:{group_id}
```

**Sidecar 所有权**：IM Bot / Agent Channel 使用 `SidecarOwner::Agent(session_key)` 作为 Sidecar owner，与 `Tab`、`Companion`、`Task`、`Goal`、`BackgroundCompletion` 并列。当所有 owner 释放时 Sidecar 自动停止。`ensure_session_sidecar()` 和 `release_session_sidecar()` 统一管理生命周期。

**`/new` 的 owner 边界**：命令在现有 per-peer enqueue fence 内按 exact Session ID 查询 SessionStore；仅 metadata 仍存在的源 Session 需要 freeze，missing birth-pending / stale binding 没有可冻结的持久源，直接进入同一个轮换事务。随后生成并持久化 `sidecar_port=0 / metadata_birth_pending=true` 的唯一新 binding，成功后只释放旧 Session 的目标 `Agent(session_key)`。它不得调用 Node reset、不得修改旧 Sidecar key，也不得迁移共享的 Tab/Task/Goal 等 owner。新 binding 在第一条普通 IM 消息到来时复用 `prepare_ensure_sidecar()` 实体化；命令自身不创建空 Sidecar 或 transcript。freeze / health projection / owner transfer 任一步失败都恢复旧 binding，并保留旧 group history 与 consumer。

桌面把现有 Session 接管到 Channel 时复用同一条 SessionStore 分类策略和同一把 per-peer fence：首条 IM enqueue 必须先完成 metadata materialization，再由 handover 判断是否冻结旧源并替换 binding。这样接管与普通消息、`/new`、heartbeat、surface migration 不会对同一 peer 并发裁决。

### 2.6.1 通用代理变化时的 Channel 重连

Rust IM adapter 与 Plugin Bridge 是通用网络 owner。`generalRequests` 的有效值变化后，Channel model-work gate 覆盖普通 enqueue、ReplyRouter 回复、terminal finalizer、heartbeat turn 与 cron hand-off；到达空闲边界时关闭入口并再次复核 ReplyRouter/active work，然后复用标准 Channel stop/start lifecycle 从磁盘权威配置重建实例。显式命令、启动恢复、健康监控、Channel 热配置同步与代理重连共用按 `{agentId, channelId}` / `{botId}` 定位的 lifecycle lock；所有 start/replacement 都在取得锁后重读磁盘权威配置，避免并发 stop/start 重复创建或 replacement 发布旧配置。切换窗口内的新普通消息会收到稍后重试提示。

这里不复制 `SessionRouter` 或 Sidecar owner，也不引入代理专用进程管理器。pending cron 是 Rust Channel 拥有的未完成投递状态，transport replacement 复用同一个 `Arc`，并向新 heartbeat runner 补发首个 pending event 的定向高优先级 wake；每次成功 ACK 后再按整个 queue 的下一项目标级联，因此同一 Channel 的多个 private target 都能继续排空，旧 wake channel 随 shutdown 消失也不会让事件停滞。标准 shutdown 仍负责持久化 session binding、释放 Sidecar owner，标准 start 再恢复。连续代理修改由 reconciliation mutex 串行，generation fence 只让最新一轮落地；即使某一代快照暂时没有运行中 Channel，也仍排队 waiter，保证更新一代不会被旧 replacement 的临时 remove 窗口吞掉。

### 2.6.2 IM / Agent Channel 中的 Goal Mode

Goal Mode 是 current-session 状态，因此 IM / Agent Channel 里由 AI 调 `myagents goal create --objective-file ...` 创建的 Goal，仍属于当前 peer session：

- 创建入口和桌面 `/goal` 等价，最终走 Goal facade / `/api/goal/create`，而不是普通 Cron create。
- 后续自动续跑由 `SessionGoalManager` 的 one-shot continuation 驱动，经 `/goal/execute-sync` 恢复原 IM / Agent Channel interaction scenario；不创建 Task/CronTask。
- ordinary user ingress 由 SessionEngine Goal orchestrator 统一注入 Goal context；现有 queue item 到达真实 Runtime promotion 时由 adapter 原子 claim，terminal 后 finalize，避免 renderer/渠道各自维护 Goal 逻辑。
- 自动 continuation 仅在 Sidecar 明确返回 `goalChannelDeliveryExpected=true`（turn origin 为 `agent-channel`）时把成功文本写入持久 outbox，不创建或读取 `CronDelivery`。每个 Goal 的唯一 replay worker 按 `sessionId -> peer session` binding 投递；没有 binding 不 ACK，并在运行中/启动恢复后持续重试。
- Channel 投递是 at-least-once：稳定 delivery id 防止同一 lease 在健康进程内重复入队，但 push 成功后、outbox 删除前崩溃会在恢复后重发。群聊结果为 `<NO_REPLY>` / `NO_REPLY` 时保持静默。
- 桌面端从历史打开同一个 IM / Agent Channel session 时，应通过 `sessionId + workspacePath` hydrate active/paused Goal 横条。
- Cron / Registered Agent / 群聊场景不主动注入 Goal create prompt。未来如果要做“Bot 发起独立后台 Goal session，完成后回投原 channel”的 detached/new-session Goal，需要单独设计 parent session / return target；不要把它混进 current-session Goal。

### 2.7 Agent Heartbeat 私聊目标

Agent 工作区可以同时绑定多个 Channel（例如微信 + 飞书，或多个飞书 Bot）。Heartbeat 不能逐个 Channel 广播，也不能只根据某个 Channel 的“最近活跃 peer”临场猜测；它必须由 Agent 级状态先解析出一个完整的私聊目标 `{ channel_id, session_key }`，再把 wake 精确投递给对应 Channel 的 heartbeat runner。

权威状态：
- `AgentInstance.last_active_channel` 保留“最近活跃 Channel/Session”历史，但它可以指向 group，只能作为迁移线索。
- `AgentInstance.last_active_private_target` 是 heartbeat / cron / manual wake 的目标权威，只在私聊用户消息或私聊 handover 时更新；群聊消息不会覆盖它。
- `SessionRouter` 提供 private-only helper（exact private target、latest private target、active private port）。Agent 目标解析必须使用这些 helper 验证目标仍是当前 Channel 内有效的 private peer。

解析规则：
- 已有 `last_active_private_target`：只投递到该 Channel 的精确 private session；目标缺失、变成 group、或 Channel 非 Online 时直接跳过，不 fallback。
- 没有 private target 但 `last_active_channel` 指向 Online Channel 的 private session：迁移并 seed `last_active_private_target`。
- `last_active_channel` 指向 group、目标 Channel 不在线、或 session 已不可判定：跳过，不 fallback 到旧私聊。
- 完全没有历史时，才允许 bootstrap 到所有 Online Channel 中最近的 private session。

投递规则：
- Agent 级 `route_agent_heartbeat_once()` 只负责解析一次目标并发送 `HeartbeatWake { target_session_key }`；per-bot `HeartbeatRunner` 收到显式 target 后只验证并投递该 private session，验证失败不得 fallback。
- Cron / Task Center completion 复用同一个 Agent 目标解析器。它先解析当前 private target，再把携带 `target_session_key` 的 `PendingCronEvent` append 到目标 Channel 的 pending queue；per-bot `HeartbeatRunner` 只 snapshot 当前 private session 匹配的 pending event（历史无 target 的 legacy event 仍兼容处理）。没有当前 private target 时只保留 cron 执行历史，不把事件塞进配置里的旧 bot queue。
- Management API `/api/im/wake` 对 Agent Channel 也走 Agent 目标解析器；文本 `manual_wake` 只 POST 到显式 private active session。Legacy standalone bot 保留 targetless latest-private fallback。
- Wake coalescing 同优先级时优先保留带 `target_session_key` 的 wake，避免 target metadata 被普通 interval/manual wake 覆盖。

### 2.8 健康状态持久化

```rust
pub struct HealthManager {
 state: Arc<Mutex<ImHealthState>>,
 persist_path: PathBuf, // ~/.myagents/im_bots/{bot_id}/state.json
}

pub struct ImHealthState {
 pub status: ImStatus, // Online | Connecting | Error | Stopped
 pub bot_username: Option<String>,
 pub uptime_seconds: u64,
 pub last_message_at: Option<String>,
 pub active_sessions: Vec<ImActiveSession>,
 pub error_message: Option<String>,
 pub restart_count: u32,
 pub buffered_messages: usize,
 pub last_persisted: Option<String>,
}
```

`ImHealthState.uptime_seconds` 是持久化健康快照，不是运行中 Channel 的实时计时 authority。
`agent runtime-status` 在持有 Agent registry 锁时复制 `ImBotInstance.started_at`，释放锁后再用
`started_at.elapsed()` 生成 `uptimeSeconds`；健康状态只提供 status、错误、会话数等快照字段。

**持久化**：每 5 秒写入磁盘，供前端轮询展示。

**Per-Bot 文件路径**（v3 子目录结构）：
- 健康状态：`~/.myagents/im_bots/{bot_id}/state.json`
- 消息缓冲：`~/.myagents/im_bots/{bot_id}/buffer.json`
- 去重缓存：`~/.myagents/im_bots/{bot_id}/dedup.json`（仅飞书）
- 遗留文件迁移：启动时自动迁移 v1（`im_state.json`）和 v2（`im_{botId}_*.json`）到 v3 子目录，孤儿文件自动清理

### 2.9 消息缓冲

```rust
pub struct MessageBuffer {
 queue: VecDeque<BufferedMessage>,
 max_size: usize, // 默认 100 条
 persist_path: PathBuf, // 磁盘持久化
}
```

Sidecar 不可用时入站消息进入缓冲队列；恢复后由 peer lock 保护入队顺序，回复生命周期仍由 `/api/im/events` 的 requestId 事件归属，而不是依赖同一 SSE 流内重放。OpenClaw reply 的 requestId/deliveryProtocol 只在当前进程的内存缓冲中保留，以维持仍在等待的 Bridge dispatcher；它们不写入 `buffer.json`，因为 app/Bridge 重启后原 pending owner 已不存在，磁盘重放必须走普通 outbound 路径。

### 2.10 Draft / Reply 渲染（`/api/im/events` → ReplyRouter）

当前实现是 Sidecar 事件总线 + Rust consumer。渲染路径由每个 `ReplySlot` 的 delivery protocol 决定：

```
Rust ImEventConsumer 连接 Node /api/im/events?since=<seq>
 │
 ├── Native adapter（deliveryProtocol 为空）
 │ ├── "partial" → 创建/编辑 draft（节流 + 平台长度限制）
 │ ├── "block-end" → 定稿当前 block
 │ └── terminal → 平台收尾并移除 slot
 │
 └── OpenClaw reply（deliveryProtocol="openclaw-reply"）
   ├── "partial" → 发送当前 raw text block 的 full snapshot
   ├── "block-end" → 仅发送顺序屏障并清空 block accumulator
   ├── "complete" → 透传 terminal outcome 的 canonical finalPayloads
   └── "error"|"cancelled" → 透传 producer-owned terminal payload
```

`ImEventConsumer` 拥有 SSE reconnect lifecycle，使用 `since=<lastSeq>` 恢复 ring-buffered events；`ReplyRouter` 拥有每个 requestId 的 draft/message slot。Native adapter 继续按 block 独立创建/编辑/定稿；OpenClaw 路径中，插件拥有渲染、节奏和 fallback，Rust 只做 request-scoped protocol forwarding。两条路径不得用 channel 全局 capability 相互推导。

OpenClaw pending dispatcher 在 Rust admission 之前已经存在，因此每个早退分支也属于协议生命周期：有用户可见结果时经 `complete`/`abort` 交回插件 renderer，无结果时发送空 `complete`。群聊是否进入模型仍由 Rust 的 `GroupActivation` 权威决定，Bridge 不得用插件侧 `isMention` 跳过 request protocol。协议请求只允许进进程内 buffer；无法 enqueue 时必须 terminal abort，不能写入 `buffer.json` 后让原 dispatcher永久等待。

### 2.11 Tauri 事件

| 事件 | Payload | 触发时机 |
|------|---------|---------|
| `im:user-bound` | `{ botId, userId, username? }` | 用户通过 QR 码绑定成功 |

### 2.12 交互式权限审批

当 IM Bot 使用非 `fullAgency` 模式时，SDK 的 `canUseTool()` 会阻塞等待审批。审批请求通过飞书交互卡片 / Telegram Inline Keyboard 展示给用户。

#### 数据流

```
canUseTool() 阻塞 → checkToolPermission() 通过 IM event bus 发出 permission-request
 → /api/im/events consumer 收到带 requestId 的事件
 → ReplyRouter / adapter.send_approval_card()
 → 存储 PendingApproval{request_id, sidecar_port, chat_id, card_message_id}
 → runtime turn 自然暂停（canUseTool 在等 Promise）

--- 用户点击按钮 / 回复文本 ---

 → approval_tx 通道 → POST /api/im/permission-response
 → handlePermissionResponse() 解除 Promise → runtime turn 恢复，后续回复事件继续从 /api/im/events 到达
 → 更新卡片/消息为"已允许"或"已拒绝"
```

#### 核心类型

```rust
struct ApprovalCallback {
 request_id: String,
 decision: String, // "allow_once" | "always_allow" | "deny"
 user_id: String,
}

struct PendingApproval {
 sidecar_port: u16,
 chat_id: String,
 card_message_id: String, // 空 = 卡片发送失败，文本降级
 created_at: Instant, // 用于 15 分钟 TTL 清理
}

type PendingApprovals = Arc<Mutex<HashMap<String, PendingApproval>>>;
```

#### 文本命令降级

即使交互卡片/按钮不可用，用户也能通过文本完成审批：

| 用户回复 | 等效操作 |
|---------|---------|
| `同意` / `approve` | allow_once |
| `始终同意` / `always approve` | always_allow |
| `拒绝` / `deny` | deny |

系统自动匹配该 chat 最近的 pending approval，无需输入 request_id。

#### 平台实现

- **飞书**：`msg_type: "interactive"` 交互卡片，3 个按钮（允许/始终允许/拒绝），`card.action.trigger` 事件回调
- **Telegram**：`inline_keyboard` + `callback_query`，short_id 映射解决 64 byte `callback_data` 限制

### 2.13 Channel Host Interaction Capability

IM / Agent Channel 的结构化人类交互不是普通工具偏好，而是 host 能力。Rust `/api/im/enqueue` 与 heartbeat payload 都带 `hostInteraction: { askUserQuestion: 'none' | 'native-card' }`，Node 侧 `InteractionScenario` 同步携带该字段。

- 默认值必须是 `'none'`。Telegram、Dingtalk、OpenClaw Bridge（包括官方 Feishu/Lark 插件）不承接 builtin `AskUserQuestion`，Node 会把它作为 channel compatibility overlay 禁用，避免阻塞式 SDK 提问与插件同 chat 串行队列互相等待。插件自带的异步原生卡片工具属于另一套“答案作为新 turn 注入”的协议，不能据此把 Bridge 声明为 `'native-card'`。
- 原生飞书 adapter 当前声明 `'native-card'`，因此 runtime 可放开 `AskUserQuestion`，并通过 IM event bus 的 `ask-user-question-request` / `ask-user-question-expired` 交给 Rust `ReplyRouter`。
- `ReplyRouter` 解析 request 后调用 `adapter.send_question_card()`，并在 `PendingQuestion` 中保存 inner `requestId`、chat、card message id、requester、questions 和 sidecar port。用户按钮或文本 fallback 进入 `QuestionCallback`，Rust POST 现有 `/api/ask-user-question/respond`，只有 HTTP 2xx 且 JSON `{success:true}` 后才删除 pending / 更新卡片状态；失败时保留 pending 让用户重试。
- 敏感问题（`isSecret`）在 IM 渠道 fail-closed：不要求用户在聊天历史里输入 secret，直接通知用户并向 sidecar 回传取消。安全输入能力需要单独设计，不能用普通 IM 文本兜底。
- 文本 fallback 只用于自由文本、多题、多选等卡片按钮无法完整表达的场景；同 chat 多个 pending 时固定路由到最新 pending，并记录 warning。

### 2.14 飞书 WebSocket 事件 ACK

飞书 WS 协议要求客户端对数据帧发送 ACK 确认。未 ACK 的事件在 WebSocket 重连后会被服务端重放。

```rust
// 收到数据帧后立即发送 ACK（相同 seq_id，type: "ack"）
let ack_data = Self::build_ack_frame(&frame);
ws_write.send(WsMessage::Binary(ack_data.into())).await;
```

配合 72 小时 dedup 缓存 TTL（`DEDUP_TTL_SECS = 72 * 60 * 60`）作为防御兜底，防止长时间运行后重连导致消息重复处理。

### 2.15 Plugin Bridge（OpenClaw 社区插件桥接）

**设计动机**：OpenClaw 生态有大量 Channel Plugin（QQ Bot、WeChat、Matrix 等），均为 TypeScript 实现。为避免为每个平台写 Rust 适配器，引入 Plugin Bridge 机制——独立 Node.js 进程加载社区插件，仅做 Channel I/O，AI 推理走现有 Rust → Node.js Sidecar 管道。

#### 架构

```
Rust BridgeAdapter ←─ HTTP ──→ Plugin Bridge (Node.js 进程)
 │ │
 │ POST /send-text │ import(plugin)
 │ POST /send-media │ compat-api → register()
 │ reply protocol │ compat-runtime → OpenClaw dispatcher
 │ GET /status │
 │ │ POST /api/im-bridge/message → Rust
 │ │
 ▼ ▼
SessionRouter → Sidecar(AI) 社区 IM 平台 (QQ/Matrix/…)
```

#### 核心组件

| 组件 | 位置 | 职责 |
|------|------|------|
| `BridgeAdapter` | `src-tauri/src/im/bridge.rs` | 实现 ImAdapter + ImStreamAdapter，通过 HTTP 与 Bridge 进程通信 |
| Plugin Bridge 入口 | `src/server/plugin-bridge/index.ts` | 启动 HTTP server，加载插件，转发消息 |
| compat-api | `src/server/plugin-bridge/compat-api.ts` | OpenClaw API shim，捕获 `registerChannel()` |
| compat-runtime | `src/server/plugin-bridge/compat-runtime.ts` | channelRuntime mock，建立真实 OpenClaw reply dispatcher 并提取用户消息 |
| pending-dispatch | `src/server/plugin-bridge/pending-dispatch.ts` | 按 requestId 串行投递 partial/barrier/terminal；只合并相邻同 lane snapshot |
| sdk-shim | `src/server/plugin-bridge/sdk-shim/` | 为 `openclaw/plugin-sdk` imports 提供运行时 shim |
| Bridge sender registry | `bridge.rs` 静态 `BRIDGE_SENDERS` | bot_id → (sender_channel, plugin_id) 路由映射 |

#### Bridge MCP tool surface 与 Turn context

Plugin tool schema 是 Session 级控制面，sender/chat/account/owner 是 Turn 级调用身份，两者必须由不同 owner 持有：

- `src/server/tools/im-bridge-tools.ts` 以规范化的 `{bridgePort, pluginId, sorted enabledToolGroups}` 作为 stable surface identity；`interaction` group 在规范化时统一加入。新 identity 只请求一次 Bridge `/mcp/tools`；只有发现非空工具 schema 时才创建一次 `createSdkMcpServer()`，零工具则直接 terminal ready，失败/超时则 terminal degraded。
- 同一 surface generation 的连续消息直接复用 settled surface outcome（存在时复用 SDK server）；不再请求 `/mcp/tools`、不重建 SDK server，也不触发 `setMcpServers()`。discovery 失败/超时后该 generation terminal degraded，后续消息不重试；真实 surface identity 变化或新 Session 清空 owner 后才重试。
- Bridge discovery 与随后对 SDK readiness 的观察共享 `MCP_PREWARM_GRACE_MS` 的 absolute soft window。live `setMcpServers()` map mutation 是独立的 30 秒正确性 fence：mutation 本身不被 10 秒 deadline 截断，但 absolute wall clock 继续前进，所以 mutation 结束后只观察原窗口的剩余时间，甚至可能已为 0；mutation 不会重置或延长 soft budget。只有当前 Query 的 installed-map fingerprint 尚未确认该 surface identity 时，`/api/im/enqueue` 才同步 map；零工具或 degraded generation 也会发布 identity 以阻止逐消息重试，但不会伪造一个 SDK tool server。真实 identity drift 若撞上 active turn，则消息留在既有 turn-boundary queue，replacement Query 确认新 surface 后再 dispatch。
- `ImBridgeTurnContext` 只由 exact `requestId` 的 `ImRequestRegistry` entry 持有，不随 SessionEngine request 或 queue item 复制。SDK stdin 的每次 user-message yield 都在 output-owner FIFO 占一个槽位（非 IM turn 占 `null` 槽）；tool callback 只在 FIFO head 是 IM request 时解析 sender/chat/account/owner。realtime 消息 B 即使已 yield，也不会覆盖仍在产出/调用工具的消息 A；terminal unregister 后上下文立即不可读。
- request entry 创建后，取消与异常清理先由 `/api/im/enqueue` admission route 持有；runtime admission 成功后同步移交给 builtin/external runtime。移交前的 catch 由 route unregister；移交后的正常 terminal cleanup 归 runtime，cancel route 仅在成功移除 queued item 时接管 terminal/unregister，running turn 始终由 runtime 收尾。禁止两个 owner 同时清理或在 turn 执行中提前删除 Bridge 身份。
- external runtime busy 时，IM request 复用 `external-session/operation-queue.ts` 的 turn-boundary FIFO，不创建第三套 IM queue，也不主动进入 `sendExternalMessage()` 的 busy polling gate。既有 direct-send tail 本身就是原子 admission 占位：同一事件循环内同时观察到 idle 的后续 IM 也必须进入正式 FIFO，包括首条 direct send 正在等待 process config invalidation 的窗口；首条仍保留 adapter fail-loud，后续请求由 queue 的精确 terminal 报错。operation 持有 requestId 与 terminal observer；queue clear、config apply failure、按 requestId cancel 都必须先移除对应 operation，再向该 request 发唯一 `error/cancelled` terminal 并清 registry。Desktop 与 IM 的 `queue:added/started/cancelled` 可见性由同一 owner 产生。
- graceful interrupt 已收到 SDK `result` 时，该 result handler 同步 claim 并消费当前 output owner，interrupt caller 不再追加 `stopped` terminal；没有 result / Session 直接结束时才由 interrupt caller terminalize。`/api/im/cancel` 以 registry AbortController 的首次 abort 作为原子 cancellation claim，重复请求只确认“取消进行中”，不得二次进入 runtime。route 只为 admission-owned / queued 请求补发 terminal；running turn 始终由 runtime terminal owner 收尾，确保每个 request 恰好一个 terminal emitter、每个 SDK result 恰好消费一个 FIFO 槽。

这条分离保证同一飞书 Session 连续对话只支付一次工具发现，同时群聊不同 sender 或并发相邻消息不会串用 OAuth / chat identity。300 秒工具执行预算从 callback 真正调用 `/mcp/call-tool` 时开始，与 10 秒 surface pre-warm预算无关。

#### 消息流

**入站**（社区平台 → AI）：
1. 社区插件收到消息 → 调 `withReplyDispatcher({ run })` 或 `dispatchReplyFromConfig()`
2. compat-runtime 创建 dispatcher，生成 requestId 并注册 pending dispatch
3. 提取 ctx 字段 → 携带同一 `requestId + deliveryProtocol: "openclaw-reply"` POST `/api/im-bridge/message` → Rust
4. Rust 查 `BRIDGE_SENDERS` registry → `mpsc::Sender<ImMessage>` → 标准消息处理循环
5. SessionRouter → ensure sidecar/consumer → `/api/im/enqueue` → `/api/im/events` → ReplyRouter/BridgeAdapter 回复

**出站**（AI → 社区平台）：
1. ReplyRouter 按 requestId 调 Bridge reply protocol endpoints；HTTP ACK 只表示合法入队
2. pending queue 严格保持 run/block/terminal 顺序，并调用 dispatcher 的 partial/final callbacks
3. 插件依据自身 typed config 选择 CardKit streaming 或静态消息 fallback

`/send-text` 仍是普通 outbound surface，不参与标准 reply dispatcher，也不能作为 pending reply 的隐式 fallback。

#### Dispatch 返回值约定

OpenClaw 插件对 dispatch 函数的返回值做 `{ queuedFinal, counts }` 解构。shim dispatcher 必须实现上游的同步 admission、顺序投递、typing 与 idle contract，并返回此结构：

| 函数 | 返回 |
|------|------|
| `withReplyDispatcher({ run })` | 等待 run 与 dispatcher idle，返回真实计数 |
| `dispatchReplyFromConfig(params)` | 注册 pending、投递 Rust 请求并等待 request terminal |
| `dispatchReplyWithBufferedBlockDispatcher(params)` | 仅作为不支持标准 dispatcher 的 legacy inbound fallback |
| `createReplyDispatcherWithTyping()` | 同步接纳 payload，按序调用 deliver，并暴露 `waitForIdle()` |

#### ctx 字段提取映射

compat-runtime 从 OpenClaw 插件的 dispatch context 中提取以下字段，转发到 Rust：

| 插件 ctx 字段 | compat-runtime 变量 | Rust BridgeMessagePayload | 用途 |
|---|---|---|---|
| `BodyForAgent` / `Body` | `text` | `text` | 消息正文（BodyForAgent 含插件预处理的群聊历史） |
| `SenderId` | `senderId` | `sender_id` | 发送者 ID |
| `SenderName` | `senderName` | `sender_name` | 发送者名称 |
| `ChatType` | `chatType` | `chat_type` | `"group"` 或 `"direct"` |
| `From` | `chatId`（去除 `feishu:` 前缀） | `chat_id` | 会话 ID |
| `MessageSid` | `messageId` | `message_id` | 消息 ID |
| `WasMentioned` / `IsMention` | `isMention` | `is_mention` | 是否 @机器人 |
| `GroupSubject` / `GroupName` | `groupName` | `group_name` | 群名称（人类可读） |
| `MessageThreadId` | `threadId` | `thread_id` | 线程/话题 ID |
| `ReplyToBody` | `replyToBody` | `reply_to_body` | 引用回复原文 |
| `GroupSystemPrompt` | `groupSystemPrompt` | `group_system_prompt` | 群聊自定义系统提示 |

**isMention 默认值逻辑**：

```typescript
// compat-runtime.ts — 与 Rust management_api.rs 保持一致
const isMention = ctx.WasMentioned ?? ctx.IsMention ?? (chatType !== 'group');
// 私聊 → true（消息直达 bot），群聊 → false（需插件明确标记）
```

OpenClaw 飞书插件通过 `mentionedBot(ctx.mentions)` 检测 @mention，结果写入 `ctx.WasMentioned`。若插件未设置此字段，群消息默认 `false`——配合 `GroupActivation::Mention` 策略，未 @bot 的消息会被缓冲到群历史而非触发 AI。

#### 插件生命周期

```
安装：cmd_install_openclaw_plugin(npm_spec)
 → 使用内置 Node.js 执行 npm install <spec>
 → 读取 openclaw.plugin.json manifest
 → 最后写入 sdk-shim → node_modules/openclaw/
 → 返回 manifest + capabilities

启动：start_im_bot(platform="openclaw:<install-or-route-id>")
 → spawn_plugin_bridge() (Node.js 进程)
 → 健康检查 GET /status
 → register_bridge_sender(bot_id, plugin_id, tx)
 → listen_loop + poll_handle watcher

停止：stop_im_bot()
 → POST /stop → Bridge 优雅退出
 → unregister_bridge_sender(bot_id)
 → kill bridge process

卸载：cmd_uninstall_openclaw_plugin(plugin_id)
 → is_plugin_in_use() 安全检查
 → rm -rf plugin 目录
```

### 2.16 群聊处理

#### 群激活策略

| 模式 | 行为 | 配置 |
|------|------|------|
| `GroupActivation::Mention` | 仅 @bot / `/ask` 触发 AI，其他消息缓冲到群历史 | 默认 |
| `GroupActivation::Always` | 所有消息都触发 AI，AI 可回复 `<NO_REPLY>` 跳过 | 需显式配置 |

#### 平台覆盖矩阵

| 平台 | `Mention` 上下文积攒 | `Always` 模式 | 说明 |
|------|------|------|------|
| Telegram | ✅ | ✅ | 完整支持 |
| Feishu 原生 | ✅ | ✅ | 仅识别 @bot / `/ask`，不识别 reply-to-bot |
| Dingtalk | ✅ | ✅ | `is_mention = isInAtList` |
| OpenClaw Bridge（飞书 / QQ 等） | ✅ | ✅ | `compat-runtime.ts::defaultIsMentionForGroup` 默认 `false`，依赖插件设置 `WasMentioned` |
| **OpenClaw Bridge - 企微 (wecom)** | ❌ | ❌ | 企微 AI Bot **平台限制**：webhook 仅在 `@机器人` 时下发 `aibot_msg_callback`，未 @ 的群消息上游就没有事件可推。`compat-runtime.ts::defaultIsMentionForGroup('wecom')` 硬编码 `true` 反映这一事实。前端 UI（`ChannelDetailView.tsx`）已禁用企微的"全部消息"开关并加 tooltip 说明 |

#### 群名解析（3 级 fallback）

```rust
// mod.rs — group_name 解析链
let group_name = group_permissions // 1. 用户在 UI 配置的群名
 .find(|g| g.group_id == msg.chat_id)
 .map(|g| g.group_name.clone())
 .or_else(|| msg.hint_group_name.clone()) // 2. Bridge 插件传来的群名
 .unwrap_or_else(|| msg.chat_id.clone()); // 3. 原始 chat_id
```

#### 群聊 AI Prompt 模板

Rust 构建 `GroupStreamContext` 后，Sidecar `/api/im/enqueue` 端点组装最终 prompt：

```
[群聊信息] ← 仅 isFirstGroupTurn
你正在「{groupName}」{groupPlatform}群聊中。
你的回复会自动发送到群里，直接回复即可。
群内不同人的消息会以 [from: 名字] 标注发送者。
你会收到群里的所有消息。如果你认为不需要回复… ← 仅 GroupActivation::Always

[群聊指令] ← groupSystemPrompt（来自插件配置）
{groupSystemPrompt}

{pendingHistory} ← 积攒的未触发群消息

[引用回复] ← replyToBody（引用回复上下文）
> {quoted original text}

[from: {senderName}] ← 发送者标记
{message text}
```

**私聊引用回复**：非群聊时 `replyToBody` 也会注入（`[引用回复]\n> ...` 前置于消息）。

#### 群工具禁用

群聊默认禁用危险工具：`['Bash', 'Edit', 'Write']`。可通过 `groupToolsDeny` 配置覆盖（空数组 = 全部允许）。

#### ImMessage 群聊相关字段

```rust
pub struct ImMessage {
 // ... 基础字段（chat_id, text, sender_id 等） ...
 pub is_mention: bool, // @bot 检测结果
 pub reply_to_bot: bool, // 回复 bot 消息检测
 pub hint_group_name: Option<String>, // Bridge 插件提供的群名 hint
 pub reply_to_body: Option<String>, // 引用回复原文（Bridge 插件）
 pub group_system_prompt: Option<String>, // 群聊自定义系统提示（Bridge 插件）
}
```

这 3 个 Option 字段由 Bridge 插件透传，原生适配器（Telegram/Feishu/Dingtalk）设为 `None`。`BufferedMessage` 序列化时同步携带（`#[serde(default)]`），崩溃恢复后不丢失。

---

## 三、前端实现

### 3.1 组件结构

```
src/renderer/components/ImSettings/
├── index.ts # re-export BotPlatformRegistry
├── BotPlatformRegistry.tsx # Settings「聊天机器人 Bot」页：内置/插件平台卡、插件安装/更新/卸载、接入指南
├── promotedPlugins.ts # 推荐 OpenClaw 插件列表
├── assets/
│ ├── telegram.png / dingtalk.svg / qqbot.svg / weixin.svg # 平台图标
│ └── Bot*.png / *_step*.png # 平台接入指南图片
└── components/
  ├── BotTokenInput.tsx / FeishuCredentialInput.tsx / DingtalkCredentialInput.tsx
  ├── BindQrPanel.tsx / BindCodePanel.tsx / BotStatusPanel.tsx
  ├── WhitelistManager.tsx / GroupPermissionList.tsx
  ├── PermissionModeSelect.tsx / AiConfigCard.tsx / McpToolsCard.tsx
  └── HeartbeatConfigCard.tsx

src/renderer/components/AgentSettings/channels/
├── ChannelWizard.tsx # per-Agent Channel 创建/编辑向导，复用 ImSettings/components
```

### 3.2 设置页入口与 Channel 向导

当前没有独立 `ImSettings.tsx` 路由容器。`pages/settings/SettingsPage.tsx` 在「聊天机器人 Bot」section 直接渲染 `BotPlatformRegistry`，用于展示可接入平台与社区插件；真正的 per-Agent Channel 创建/编辑在 `components/AgentSettings/channels/ChannelWizard.tsx`，它复用 `components/ImSettings/components/*` 的表单控件和平台素材。

### 3.3 BotPlatformRegistry

`BotPlatformRegistry` 是 Settings 页「聊天机器人 Bot」section 的当前入口：

- 读取 `cmd_list_openclaw_plugins` 展示已安装社区插件。
- 展示内置 Telegram / Dingtalk 平台卡，以及 `promotedPlugins.ts` 声明的推荐 OpenClaw 插件。
- 支持插件安装、更新、卸载；更新后调用 `cmd_restart_channels_using_plugin` 重启相关运行中 channel。
- 展示接入指南图片，不直接创建 per-Agent channel。

### 3.4 ChannelWizard

per-Agent Channel 创建/编辑由 `components/AgentSettings/channels/ChannelWizard.tsx` 拥有。它复用 `components/ImSettings/components/*` 的输入组件和素材，负责：

- Telegram / Feishu / Dingtalk / OpenClaw platform credential 表单。
- `patchAgentConfig` 写入 `agent.channels[]`。
- `invokeStartAgentChannel` 启动 channel，并查询 `cmd_agent_channel_status`。
- QR / bind code / whitelist / group permission / heartbeat / permission mode / AI config / MCP tools 等子配置。

### 3.5 共享表单组件

`components/ImSettings/components/*` 是 ChannelWizard 与 Bot 平台页共享的表单/状态组件：

- `BotTokenInput` / `FeishuCredentialInput` / `DingtalkCredentialInput`
- `BindQrPanel` / `BindCodePanel` / `BotStatusPanel`
- `WhitelistManager` / `GroupPermissionList`
- `PermissionModeSelect` / `AiConfigCard` / `McpToolsCard`
- `HeartbeatConfigCard`
- Deep link URL + 复制按钮
- 3 步说明
- 无白名单用户时显示"推荐"标签

**PermissionModeSelect**：
- 自定义 radio 卡片（`sr-only` 隐藏原生 radio）
- 选中态：品牌色边框 + 背景 + 内圆点
- 读取 `PERMISSION_MODES` 配置（行动/规划/自主行动）

---

## 四、配置持久化

### 4.1 数据模型

```typescript
interface ImBotConfig {
 id: string; // UUID
 name: string; // 展示名（自动同步为 @username）
 platform: ImPlatform; // 'telegram' | 'feishu' | 'dingtalk' | `openclaw:${string}`
 botToken: string;
 allowedUsers: string[]; // Telegram user_id 或 username
 providerId?: string; // AI 供应商（独立于客户端）
 model?: string; // AI 模型
 permissionMode: string; // 'plan' | 'auto' | 'fullAgency'
 mcpEnabledServers?: string[]; // Bot 可用的 MCP 服务 ID
 defaultWorkspacePath?: string;
 enabled: boolean;
 setupCompleted?: boolean; // 向导完成标记
 // OpenClaw 社区插件专属
 openclawPluginId?: string; // 安装 ID / pluginId，用于定位 ~/.myagents/openclaw-plugins/<pluginId>
 openclawNpmSpec?: string; // npm 包名
 openclawPluginConfig?: Record<string, unknown>; // 插件运行时配置
 openclawManifest?: object; // 插件 manifest 缓存
}
```

**OpenClaw 身份边界**：历史配置里的 `platform: "openclaw:<...>"` 可能保存安装 ID（如 `openclaw-lark`、`wecom-openclaw-plugin`），也可能保存协议 Channel ID（如 `qqbot`）。Rust/Renderer 用 `openclawPluginId` 作为安装目录身份保持兼容；Node Plugin Bridge 则必须从 OpenClaw manifest / `package.json.openclaw.channel.id` / `registerChannel()` 得到协议 Channel ID，并用它构造 `cfg.channels.<channelId>`。不要在 Bridge 内用安装 ID 作为 canonical OpenClaw config key。

**配置类型边界**：`openclawPluginConfig` 保留 manifest scalar 的原生 JSON 类型（boolean/string/number）。Renderer 按 schema/default 渲染并持久化 typed value；Rust 在现有 config lock 内只把已知 Lark 身份的历史 `streaming: "true"|"false"` read-heal 为 boolean，未知值及其他插件不猜测、不迁移。插件据此自行决定 streaming/fallback。

**配置写 owner**：Channel detail 不得把 React 中的旧 `channels[]` 全量写回。通用字段走 `patchAgentChannelConfig()`，OpenClaw scalar 走显式 field `set/delete` mutation；两者都在 `atomicModifyConfig` 内合并 disk-latest Agent/Channel。写盘后仍用权威 `channels` 触发 runtime sync；Rust 只把 `patch.channels` 当 refresh signal，运行态 `groupActivation/groupPermissions` 始终从锁内重读的 `updated_agent.channels` 投影，不信任可能乱序的 invoke payload。

**存储位置**：`~/.myagents/config.json` → `imBotConfigs: ImBotConfig[]`

### 4.2 Config Service（磁盘优先）

```typescript
// 三个 IM 专用函数，全部 disk-first + withConfigLock 序列化

addOrUpdateImBotConfig(botConfig) // Upsert by id
updateImBotConfig(botId, updates) // Partial merge by id
removeImBotConfig(botId) // Filter out by id
```

每个函数先 `loadAppConfig()` 读取磁盘最新，修改后 `saveAppConfig()` 写回。原子写入采用 `.tmp` → `.bak` → 目标文件 的安全模式。

### 4.3 React 状态同步

`useConfig()` 新增 `refreshConfig()` 方法：

```typescript
const refreshConfig = useCallback(async () => {
 const latest = await loadAppConfig();
 setConfig(latest); // 只更新 config state，不触发 loading
}, []);
```

**使用模式**：所有 IM 组件的 config 写操作后调用 `refreshConfig()` 同步 React 状态。

```typescript
// ImBotDetail 中的 saveBotField
const saveBotField = useCallback(async (updates) => {
 await updateImBotConfig(botId, updates);
 await refreshConfig(); // 同步到 React state
}, [botId, refreshConfig]);
```

---

## 五、数据流

### 5.1 Telegram 消息 → AI → 回复

```
Telegram 用户发消息
 │
 ▼
TelegramAdapter (getUpdates 长轮询)
 │
 ├── 白名单校验 → 不在白名单 → 忽略
 ├── MessageCoalescer 碎片合并 + 防抖
 ├── 发送到 mpsc channel
 │
 ▼
消息处理循环
 │
 ├── 命令分发（inline，无 Sidecar I/O）
 │ ├── /start BIND_ → 添加白名单 → emit "im:user-bound"
 │ ├── /model → 更新 current_model RwLock
 │ ├── /provider → 更新 current_provider_env RwLock
 │ ├── /workspace → router.switch_workspace()
 │ └── /new → owner-scoped peer binding rotation（B 保持 port 0）
 │
 └── 普通消息
 ├── 获取 per-peer lock + global semaphore
 ├── ensure_sidecar()
 ├── 若新 Sidecar → 同步 AI config
 │
 ├── ensure_im_consumer() + ReplyRouter.register(requestId)
 ├── POST /api/im/enqueue (sync ACK)
 │ └── Node Sidecar SessionEngine enqueue 到当前 runtime
 │
 ├── /api/im/events → ReplyRouter
 │ ├── partial → 编辑 draft（节流）
 │ ├── block-end → 定稿（超长分片）
 │ ├── complete → 返回 sessionId
 │ └── error/cancelled → 发送错误或取消反馈
 │
 ├── 清除 ACK reaction
 ├── 更新 Session + 健康状态
 └── 重放缓冲消息
```

### 5.2 QR 码绑定流程

```
用户在设置页启动 Bot
 │
 ├── Rust 生成 bind_code = "BIND_{uuid8}"
 ├── 构造 bind_url = "https://t.me/{username}?start={bind_code}"
 ├── 返回 ImBotStatus（含 bind_url）
 │
 ▼
前端 BindQrPanel 展示 QR 码
 │
 ▼
用户扫码 → Telegram 打开 Bot → 自动发送 "/start BIND_xxxx"
 │
 ▼
Rust TelegramAdapter 收到消息
 │
 ├── 解析 bind_code → 匹配成功
 ├── 添加 user_id 到 allowed_users（Arc<RwLock>）
 ├── 回复绑定成功消息
 └── emit "im:user-bound" 事件
 │
 ▼
前端 ImBotDetail/ImBotWizard 监听事件
 │
 └── 添加用户到白名单配置 → saveBotField → refreshConfig
```

### 5.3 设置页 → Bot 生命周期

```
用户打开 Settings → 聊天机器人
 │
 ▼
ImBotList（读取 config.imBotConfigs + 轮询 statuses）
 │
 ├── 点击"添加 Bot" → ImBotWizard
 │ ├── Step 1: Token + 验证 + 启动
 │ └── Step 2: QR 绑定 → 完成/跳过
 │
 ├── 点击 Bot 卡片 → ImBotDetail
 │ ├── 修改配置 → saveBotField → refreshConfig
 │ ├── 工作区变更（运行中）→ 重启 Bot
 │ └── 删除 → ConfirmDialog → stop + remove + refreshConfig + onBack
 │
 └── 点击启动/停止 → toggleBot
 ├── 启动：buildStartParams → cmd_start_im_bot → 乐观更新
 └── 停止：cmd_stop_im_bot → 乐观更新为 stopped
```

---

## 六、安全模型

| 层级 | 机制 |
|------|------|
| 连接准入 | 白名单（Telegram user_id / username） |
| 空白名单 | 拒绝所有消息（安全默认） |
| 群聊触发 | 仅响应 @Bot 或 /ask |
| AI 权限 | 默认 `plan` 模式（只分析不执行） |
| 工作区沙箱 | 操作范围不超出 workspacePath |
| Token 重复 | 前端阻止同一 Token 添加多个 Bot |
| QR 绑定 | 随机 UUID bind_code，仅对应 Bot 可识别 |

---

## 七、文件清单

### Rust

```
src-tauri/src/
├── im/
│ ├── mod.rs # facade / public re-exports / 少量共享 helper
│ ├── agent_channel.rs # channel lifecycle、消息入口、ensure sidecar/consumer + enqueue 编排
│ ├── enqueue.rs # Rust → Node /api/im/enqueue 同步 ACK 请求
│ ├── event_consumer.rs # /api/im/events SSE consumer、since 恢复、事件分发
│ ├── reply_router.rs # requestId → draft/reply slot、权限卡与终态归属
│ ├── state.rs # ManagedAgents / ManagedImBots / runtime config sync / channel state
│ ├── config_store.rs # Agent/Bot config 读写、auto-start、missing config reporting
│ ├── commands.rs # Tauri IM/Agent command glue
│ ├── adapter.rs # ImAdapter trait 定义 + AnyAdapter enum
│ ├── telegram.rs / feishu.rs / dingtalk.rs # 内置平台适配器
│ ├── bridge.rs # BridgeAdapter + Plugin Bridge 进程管理 + 插件安装/卸载 + sender registry
│ ├── health.rs / heartbeat.rs / memory_update.rs / runtime_change.rs # 健康、主动 Agent 周期任务、runtime 切换
│ ├── router.rs / buffer.rs / group_history.rs / handover.rs # peer→session 映射、缓冲、群聊上下文、session handover
│ └── types.rs # ImConfig, ImMessage, ImPlatform 等共享类型
├── management_api.rs # /api/im-bridge/message 端点（Bridge 入站消息路由）
└── lib.rs # Command 注册
```

### 前端

```
src/renderer/
├── components/ImSettings/ # 全部 IM 前端组件（见 §3.1）
├── config/configService.ts # IM config CRUD 函数
├── config/types.ts # PERMISSION_MODES + ImBotConfig 相关类型
├── hooks/useConfig.ts # refreshConfig 函数
└── pages/settings/SettingsPage.tsx # "聊天机器人" 导航入口
```

### Plugin Bridge（Node.js 进程）

```
src/server/plugin-bridge/
├── index.ts # Bridge 入口：CLI args 解析、插件加载、HTTP server
├── compat-api.ts # OpenClaw API shim（registerChannel 捕获）
├── compat-runtime.ts # channelRuntime mock（dispatcher 注册 → Rust，ctx 字段提取）
├── pending-dispatch.ts # requestId-scoped 有序 reply transport
├── mcp-handler.ts # Bridge 插件 MCP 工具暴露
└── sdk-shim/
 └── plugin-sdk/
 └── feishu.js # openclaw/plugin-sdk/feishu 的 ~44 符号 shim
```

### 共享类型

```
src/shared/types/im.ts # ImBotConfig, ImBotStatus, ImPlatform, InstalledPlugin, DEFAULT_IM_BOT_CONFIG
```

### 数据文件

```
~/.myagents/
├── config.json # imBotConfigs[] 数组
└── im_bots/ # Per-bot 运行时数据
 └── {botId}/
 ├── state.json # 健康状态
 ├── buffer.json # 消息缓冲
 └── dedup.json # 去重缓存（仅飞书）
```

---

## 八、Telegram Bot API 端点

| 端点 | 用途 |
|------|------|
| `getMe` | 验证 Token + 获取 bot_username |
| `getUpdates` | 长轮询接收消息 |
| `sendMessage` | 发送文本（Markdown → 纯文本 fallback） |
| `editMessageText` | Draft Stream 编辑（流式输出） |
| `deleteMessage` | 删除 Draft（超长回复时） |
| `sendChatAction` | 发送"正在输入"状态 |
| `setMessageReaction` | ACK Reaction（⏳ / 清除） |
| `setMyCommands` | 注册命令菜单 |

---

## 九、现状与后续规划

### 9.1 多端 Session 共享（已实现）

IM peer 与 Desktop Tab 可以打开并共享同一个持久 Session。IM 入站消息及其 AI 回复由 SessionEngine 选中的 runtime owner 写入该 Session，Desktop 打开后可实时看到；requestId-aware ReplyRouter 只负责当前 Channel request 的回复槽与终态渲染。一个 request 结束后，后续 Session Inbox、Desktop、后台触发产生的新 turn 不得尝试复用已释放的 ReplyRouter slot，而应按该 turn 的显式渠道投递计划交付。

Session 绑定投递是跨 Runtime 产品契约：builtin 与 external（Claude Code / Codex / Managed Codex / Gemini）都在各自的 turn owner 内消费 `TurnChannelDelivery`，并复用 `im-mirror.ts → /api/im/mirror → session_delivery` transport。`SessionOrigin` / `InteractionScenario` 只负责归因与 prompt，不能用来猜投递 owner。

| Turn 入口 | user 投递 | assistant 投递 |
|---|---|---|
| Desktop 用户消息 | `session-binding`（显示“来自桌面端用户消息”） | `session-binding` |
| IM 用户消息 | `none` | `reply-router` |
| Session Inbox / 普通后台消息 | `none` | `session-binding` |
| Heartbeat / Cron relay / Agent Channel Goal | `none` | `caller-owned`（保留原有 ACK、outbox、retry/dedup） |
| Memory maintenance / 明确静默内部 turn | `none` | `none` |

user 与 assistant 两个方向相互独立：隐藏 System Reminder、空的 user 可见投影或 user mirror 失败，都不能关闭本应由 Session binding 投递的 assistant 回复。完整的顶层文本 block 先暂存在 runtime turn owner；terminal capture 必须先从输出归属 FIFO 摘下本轮并预留 Session 级 transport 顺序，再由真实成功且持久化完成的终态统一放行。失败、停止、持久化失败或被自动重试撤回的 attempt 直接丢弃，不投递 delta、thinking、tool、subagent、空文本或 `NO_REPLY` / `<NO_REPLY>`。IM-origin turn 只走 ReplyRouter，caller-owned turn 只走自己的 Heartbeat/Goal/Task transport，保证同一回答恰好投递一次。Desktop 用户图片仍沿用 PNG/JPG、5 MiB 上限，其余附件不镜像。

### 9.2 Bot Token 加密存储

当前 Token 明文存储在 `config.json`（与 Provider API Key 一致）。后续应统一迁移到 OS Keychain。

### 9.3 Bridge 插件功能补全

| 功能 | 状态 | 说明 |
|------|------|------|
| 消息分发 | ✅ 已修复 | dispatch 返回 `{ queuedFinal, counts }` |
| 群聊 isMention | ✅ 已修复 | 按 chatType 区分默认值 |
| 群名/引用回复/群系统提示 | ✅ 已透传 | 全链路闭环 |
| 群内 @mention 主动检测 | ⏳ 依赖插件 | Bridge 依赖插件设置 `WasMentioned`，无独立检测 |
| 附件/图片转发 | ⏳ 待实现 | compat-runtime 提取但 Rust `ImMessage.attachments` 为空 |
| 消息去重（Bridge） | ✅ feishu.js shim | `createDedupeCache` + Rust 层 72h dedup |

### 9.4 更多 IM 平台

`ImAdapter` trait 已定义（Telegram、飞书、钉钉已实现），可扩展 Slack、Discord 等平台，复用 Session Router 和消息处理循环。

社区平台可通过 OpenClaw Plugin Bridge 机制接入，无需编写 Rust 适配器。

---

## 附录：相关文档

| 文档 | 说明 |
|------|------|
| [架构总览](../ARCHITECTURE.md) | MyAgents 整体架构 |
| [Session 架构](./session_architecture.md) | Session 管理机制 |
| [Sidecar 管理](./bundled_node.md) | Node.js Sidecar 生命周期 |

## Agent Channel 架构

IM Bot 升级为 Agent 实体，Channel 为可插拔连接。新旧 Tauri Commands 并存：

### 新 Tauri Commands

| 命令 | 用途 |
|------|------|
| `cmd_start_agent_channel` | 启动 Agent Channel |
| `cmd_stop_agent_channel` | 停止 Agent Channel |
| `cmd_agent_channel_status` | 查询 Channel 状态 |
| `cmd_all_agents_status` | 查询所有 Agent 状态 |
| `cmd_update_agent_config` | 更新 Agent 配置 |
| `cmd_install_openclaw_plugin` | 安装 OpenClaw 社区插件 |
| `cmd_uninstall_openclaw_plugin` | 卸载插件 |
| `cmd_list_openclaw_plugins` | 列出已安装插件 |

> 旧命令 `cmd_start_im_bot` 等已标 `@deprecated`，内部转发到新 Agent API。

Channel desired state 由 `channel.enabled` 持久化，运行准入统一检查 `channel.enabled && setup/credentials ready && workspace 未归档`。`agent.enabled` 只门控 Heartbeat、Memory Update、Memory Evo，不参与手动启动、开机 `schedule_agent_auto_start()`、`monitor_agent_channels()` 重启或投递候选选择；因此关闭主动 Agent 不会停止或重启 Channel。用户显式停止/启动 Channel 时仍由对称 helper 先持久化 `channel.enabled`，再收敛 runtime。

归档 Agent 工作区时，`Project.archivedAt` 是权威状态。Rust IM runtime 在 `cmd_start_agent_channel`、auto-start 和 monitor 的缺失/异常频道重启路径都会读取 `projects.json`，跳过 archived workspace。CLI/Admin API 与 Renderer 的 archive lifecycle 会在 durable intent 落盘后复用 `/api/agent/reload-config` 收敛主动能力与 managed Task，并通过 `/api/agent/stop-channels` 立即停止已运行的 Channel，即使主动 Agent 原本已经关闭；unarchive 不改写 Channel desired state，enabled Channel 按自身状态恢复。Memory Evo managed Task 以持久化的 Project/workspace ID 精确回查 `Project.agentId`，workspace path 仅是执行目录，不参与 Agent 选择。`agent disable` / `agent set <id> enabled false` 只批量关闭 master 与三个主动能力子开关，不停止 Channel。`agent channel remove` 则通过 `/api/agent/stop-channel` 收敛精确 runtime。Rust stop lifecycle 位于 `im/agent_channel.rs`，负责释放 Channel Sidecar owner、Plugin Bridge 与 plugin-use registry；整组停止同时锁住 durable 与 live Channel identity，因此会等待尚未发布进运行表的启动流程。`config:changed` 只负责配置刷新，不能替代资源释放。重复删除或归档必须仍然执行 stop，以修复历史上可能存在的 disk/live drift。

一次性 `agentChannelIndependenceMigrationV1` 由 Rust config owner 在 Channel admission 前执行：marker 缺失时以迁移前的 `agent.enabled` 为源，把 Heartbeat、Memory Update、Memory Evo 三个子开关全部归一到同一值；master=false 时还会把历史 enabled Channel 设为 false，master=true 时保留各 Channel 状态。迁移在 config lock 内 re-read，复用 `.bak` 与原子写；畸形配置或写入失败不会写 marker，并让本次自动启动 fail closed，后续读取重试。marker 存在后不再覆盖用户后来对单项能力的调整。

### InteractionScenario 扩展

系统提示词支持四种场景：
- `desktop` — 桌面客户端对话
- `im` — 内置 IM Bot（Telegram/飞书/钉钉）
- `agent-channel` — Agent Channel（OpenClaw 插件，platform 为任意字符串）
- `cron` — Scheduled Task 执行（场景枚举名保留 wire compatibility）

Agent Channel 与 IM Bot 的区别：`platform` 字段为 `string` 而非固定枚举，支持任意社区插件平台。

### 数据模型

```typescript
// src/shared/types/agent.ts
interface AgentConfig {
 id: string;
 name: string;
 providerId?: string;
 model?: string;
 lastActivePrivateTarget?: LastActivePrivateTarget;
 channels: ChannelConfig[];
}

interface LastActivePrivateTarget {
 channelId: string;
 sessionKey: string;
 lastActiveAt: string;
}

interface ChannelConfig {
 id: string;
 type: ChannelType; // 'telegram' | 'dingtalk' | `openclaw:<install-or-route-id>`
 // ... credentials per type
}
```

Agent 持久化记录不再包含工作区字段。Project-backed Channel / heartbeat / memory / Sidecar
运行目录由 `Project.path` 解析，AgentConfig 由 `Project.agentId` exact lookup；旧
`Agent.workspacePath` 只在 raw compatibility adapter 中用于缺失链接修复、历史 extra
关联或真 orphan fallback，且不会因更新其他 Agent 字段被清除。Rust
`AgentConfigRust.resolved_workspace_path` 是不序列化的运行时投影，不是第二份 authority。

### Agent Channel 权限默认值

Agent Channel 是无人值守入口。没有 `ChannelOverrides.permissionMode` 时，Channel 的有效权限默认取当前 runtime 的最大自主权限，而不是继承桌面 Agent 的 `permissionMode`：

- builtin → `fullAgency`
- Claude Code → `bypassPermissions`
- Codex → `no-restrictions`
- Gemini → `yolo`

`AgentConfig.permissionMode` 仍然是桌面/Agent 默认对话权限；它不能静默降低 IM Channel。用户显式配置 Channel permission override 时才按 override 执行。群聊的 `groupToolsDeny` 是独立安全层，默认仍可额外禁止 `Bash` / `Edit` / `Write`。

### Mino 模板与 Agent 默认能力

Mino 默认工作区的"文件内容模板"和 MyAgents 的"产品级 Agent 默认策略"是两层：

| 层 | 权威来源 | 职责 |
|----|----------|------|
| 文件内容模板 | 仓库 `bundled-workspaces/mino/` → 安装包 `resources/bundled-workspaces/mino/` | 初始化工作区里的 Markdown、配置文件、示例内容；复制后用户实例独立演化 |
| 产品默认能力 | `src/shared/config-types.ts::PRESET_TEMPLATES[].agentDefaults` | 声明新建 builtin Mino project 时 Agent 是否默认开启，以及 heartbeat / memory 默认参数 |

`Project` 会记录 `templateId` / `templateSource`。只有 `templateSource === 'builtin'` 且模板本身带 `agentDefaults` 时，`buildAgentForProject()` 才会把这些默认策略复制进 `AgentConfig`。用户模板即使复用了 `mino` 这个 id，也不会自动继承 builtin 默认能力。

内置模板是当前 App 版本的只读发布资源。首次默认工作区、Bot 工作区、模板库创建及模板预览/应用必须共享同一个 bundled-template resolver；`~/.myagents/projects/mino` 是用户拥有的实例，不参与模板解析，也不会被 App 升级覆盖。

关键不变式：
- 新建 project / 启动补齐历史 project 的 Agent 配置必须走共享 reconciliation + `buildAgentForProject()`；在 `agent-config-intent.lock` 内先持久化 `Project.agentId`，再以同一 ID 创建 pathless Agent，避免 Launcher、ConfigProvider、migration 路径分叉与中断重复 birth。
- `ensureAllProjectsHaveAgent()` 只负责保证每个 project 有一个基础 Agent；对 builtin Mino project 会应用 `agentDefaults`。只有所选或新建 Agent 已 enabled 时才把历史 projection `project.isAgent` 升为 `true`；disabled 不会强制设为 `true`，也不会清除旧值。
- `agentDefaults.enabled = true` 只表示这个 workspace 的主动能力默认打开；它不自动创建 Channel，也不绕过运行时门槛。
- `memoryAutoUpdate.enabled = true` 不要求 Mino 文件模板预置 `UPDATE_MEMORY.md`。自动更新真正执行时由 Rust `memory_update.rs` 在工作区根目录 ensure 该文件：已存在则读取用户内容；缺失则从 `src/shared/default-update-memory.md` 初始化默认指令。
- Heartbeat、Memory Update、Memory Evo 分别以 `agent.enabled && child.enabled` 为 effective gate；master false 时即使外部写者留下 child=true 也不能执行。
- Rust 启动 Channel 只以 `channel.enabled && setup/credentials ready && workspace 未归档` 为准。没有 Channel 或 credential 时不会产生外部 IM 连接；主动 Agent 关闭不影响已配置 Channel。
- 后续如果要让用户模板也配置默认能力，需要新增用户可见的模板编辑能力和持久化 schema；不能把产品 builtin 默认值隐式套到 user template。
