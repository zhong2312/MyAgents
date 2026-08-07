# Task Provider Routing

> 状态：0.3.0。Task 是唯一持久化权威；Cron 名称只保留兼容 API/CLI。本文定义 Task、Session 与 Provider 配置各自拥有哪一段生命周期。

## 1. 三个配置 Scope

```text
Agent/workspace config
  live template for future Sessions

Session config
  one runtime conversation's durable identity/config

Task config
  initialization policy for a new execution Session
  + permission policy for each Task turn
```

核心规则：

1. **已有 Session 只有一份配置权威。** Task 投递到已有/preselected Session 时，runtime、provider、model、reasoning 与 MCP 全部继承 Session 当前状态。
2. **Task override 只初始化新 Session。** `new-session` 每次创建时使用；`single-session` 只在其专属 Session 首次 materialize 时使用。
3. **不做 task-turn snapshot/restore。** 临时覆盖再恢复会与用户/Goal/其他 owner 并发写同一 Session，属于错误 scope。
4. **permission 是每轮执行 policy。** 它不改写 Session runtime identity；空值按对应 runtime 最大权限解析。
5. **Goal 不读取 Task routing。** Goal 属于当前 Session，始终跟随该 Session。

## 2. 持久化边界

TaskStore 可以保存：

- `runtime` / `runtimeConfig`
- builtin 的 `providerId + model`
- `permissionMode`
- `mcpEnabledServers` 三态 override

TaskStore 不保存：

- apiKey、baseUrl、auth token 或 materialized `ProviderEnv`
- Session 当前 provider/runtime/MCP 的副本
- Goal 配置

`providerId` 是 durable intent。真正 credential 在创建新 builtin Session 时由 Sidecar 从最新 `config.json` live resolve，因此 key rotation 不要求重存 Task。

### Provider/runtime 不变式

`validate_task_provider_routing()` 在所有 create/update/migration 入口统一守门：

| 条件 | 结果 |
|---|---|
| `providerId` 存在但 `model` 缺失 | 拒绝 |
| external runtime 与 builtin `providerId` 同时存在 | 拒绝 |
| `providerId` 存在、runtime 缺失 | pin 为 `builtin` |
| legacy credential env | 不复制；迁移 Task 标为 Blocked 并要求重选 |

External runtime 自己拥有 provider，Task 只可保存该 runtime 支持的 model/config。

### MCP 三态

| 值 | 新 Session 初始化语义 |
|---|---|
| 字段缺失 / `None` | 跟随 Agent/workspace effective MCP |
| `[]` | 显式无 MCP |
| `[id...]` | 只启用指定 MCP |

删除 custom MCP identity 时，只删除列表里的该 id；列表变空仍保存 `[]`。只有显式 `clearMcpOverride` 才回到 follow Agent。

## 3. 执行流程

```text
TaskScheduler reads current Task
-> task_execution resolves target Session
-> existing Session: keep Session config
   new Session: initialize from Task/Agent policy
-> ensure SidecarOwner::Task
-> Rust POST /cron/execute-sync (compatibility transport name)
-> routes/scheduled-turns.ts validates the request and maps the response
-> task-turn-orchestrator.ts owns Task preparation and execution lifecycle
-> SessionEngine selector chooses builtin/external adapter
-> adapter.prepareScheduledTurn binds the Session and applies runtime-native initial config
-> runInjectedTurn enqueues one Task turn with per-turn permission
-> wait for real terminal result
-> persist Task outcome/history
-> release Task owner on terminal/stop/delete
```

`/cron/execute-sync` 是为兼容历史保留的接口名，不代表业务仍归 CronTask。Payload 不再传 `providerEnv`、`providerIntent` 或 Task-Cron 反向引用。

`routes/scheduled-turns.ts` 只处理 JSON 解析、字段校验、HTTP 状态和响应结构。Task 的 Session 准备、dispatch guard、reminder/exit 处理与终态判定属于 `task-turn-orchestrator.ts`；Builtin/External 的 Session binding、配置和 MCP 准备属于各自 adapter 的 `prepareScheduledTurn()`。Route 不直接实现 Runtime 分支。

对已有 Session，Node 如果无法切换到 payload 指定的 Session，必须 fail closed；禁止退回“当前碰巧打开的 Session”继续执行。

## 4. 新 Session 初始化

创建 execution Session 时按以下来源解析：

1. Task 显式 runtime/provider/model/MCP override。
2. 缺失项跟随 Agent/workspace 当前配置。
3. builtin `providerId` 在 Sidecar 从当前 config materialize credential。
4. 生成 Session metadata/config snapshot，之后由 Session 自己拥有。

Provider materialization 失败时，SessionEngine admission 使用调用点已经掌握的来源给出恢复入口：
Task 显式 override 指向 canonical `task update`，新 Session 继承值指向 Project-linked Agent，
已有 Session 指向其冻结快照。该来源只用于当前错误渲染，不新增持久化字段；Provider disabled
也不自动迁移 durable intent 或 fallback 到其它 Provider。恢复文案会随既有 prepare 结果保留到
最终 dispatch materialization，覆盖 admission 后 Provider 状态变化的并发窗口。

从这一刻开始，Agent 或 Task 配置的后续修改不会隐式改写该 Session。若用户编辑专属 single-session Task 配置，调用方应通过既有 Session 配置路径显式更新其基线；不能在每个 tick 重放 Task snapshot。

## 5. 已有 Session 与 Goal

Task 和 Goal 可同时关联同一 Session，因为它们职责不同：

- Task 只负责在时间点投递一个 Turn。
- Goal 只负责 Session 的长期目标状态与 continuation。
- Runtime queue 负责实际 Turn 排序；双方不得各自维护并行消息队列。

若未来要“Task 启动后自动进入 Goal”，本期架构已经支持最简单的组合：Task prompt 让 AI 在目标 Session 调 `myagents goal create`。Task Store、Task Scheduler 与 Goal Store 无需新增彼此引用。

## 6. Legacy 迁移

普通 legacy Cron 在 backend startup 迁移到 TaskStore：

- `providerId + model` 可验证时保留。
- subscription 只有 model 完整时映射为 builtin subscription identity。
- external runtime 丢弃无意义的 builtin provider 字段。
- frozen `provider_env` 不复制，Task 进入 Blocked。
- MCP 三态、runtime config、permission、Session 策略尽量保留。

迁移后旧 `cron_tasks.json` 只读，执行路径不再解析 legacy `ProviderIntent`。

## 7. 禁止项

| 禁止 | 原因 | 正确路径 |
|---|---|---|
| Task/Cron store 持久化 credential env | 泄密且 key rotation 失效 | 只存 identity，创建 Session 时 live resolve |
| 每个 tick 覆盖已有 Session config | 多 owner 竞态、用户设置被回滚 | 已有 Session 继承自身配置 |
| Task 同时持有 external runtime 与 builtin provider | 路由语义冲突 | Rust validator 拒绝 |
| 因 `/cron/execute-sync` 的历史名称而把业务归到 CronTask | 重新产生两个权威来源 | 业务始终归 Task |
| Goal 复制 Task provider/runtime/MCP | Goal 不是 TaskRun | 读取当前 Session |

## 8. 关键文件

- `src-tauri/src/task.rs`：持久 schema、validation、mutation
- `src-tauri/src/task_application.rs`：Task create/status/delete/run/rerun 应用操作
- `src-tauri/src/task_scheduler.rs`：timer 与 run trigger
- `src-tauri/src/task_execution.rs`：Session/Sidecar execution use case
- `src-tauri/src/sidecar/cron_execute.rs`：Rust -> Node sync transport
- `src/server/routes/scheduled-turns.ts`：`/cron/execute-sync` 的请求校验与响应映射
- `src/server/session-engine/task-turn-orchestrator.ts`：Task scheduled turn 生命周期
- `src/server/session-engine/builtin-adapter.ts`、`external-adapter.ts`：Runtime 原生 `prepareScheduledTurn()`
- `src/server/session-engine/selector.ts`：builtin/external adapter 选择
- `src/server/utils/admin-config.ts`：provider config resolver
- `src/renderer/components/task-center/editors/TaskAdvancedConfigEditor.tsx`：UI 配对编辑
