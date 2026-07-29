# 任务中心架构

> 0.3.0 起，Task 是所有新定时自动化和任务中心执行的唯一持久化实体。Cron 只保留兼容命令名与旧数据读取，不再是 Task 的调度投影。

## 1. 所有权

两个 Store 位于 `~/.myagents/`：

| Store | 文件 | Owner |
|---|---|---|
| `ThoughtStore` | `thoughts/<YYYY-MM>/<id>.md` | 想法与 Task 关联 |
| `TaskStore` | `tasks.jsonl` + `tasks/<id>/{task.md,verify.md,progress.md,alignment/...}` | Task 身份、状态、调度配置、运行统计与审计 |

`TaskStore` 是 Task 的唯一真相。不存在 `Task.cronTaskId`、关联 `CronTask` 副本、schedule 双写或启动时反向修补。

Task 的核心职责：

- 用户可见身份、文档、状态机与审计链。
- `once / scheduled / recurring` 执行模式及 `dispatchAt / interval / cron expression / timezone / recurring window`。
- `new-session / single-session` 会话策略。
- 新执行 Session 的 runtime/provider/model/MCP 初始配置，以及每轮 permission policy。
- notification、关联 Session、执行次数与最近执行时间。

`Loop` 已退出 Task 模型：新建/编辑拒绝，旧 Loop 启动时转 `Stopped`，不转换为 Goal。

## 2. 状态与调度

```text
Todo -> Running -> Verifying -> Done
          |             |
          +-> Blocked / Stopped
Done -> Archived
any allowed state -> Deleted (soft delete)
```

对时间型 Task，`Running` 表示 scheduler enabled，不表示某个 AI Turn 正在执行。具体 Turn 的 `running | stopping | stop_failed` 只存在于 `TaskSchedulerController.executions`，Task list/get 在 wire projection 上附加 `executionState/executionError`，不写入 `tasks.jsonl`。

`TaskSchedulerController` 只拥有可重建的内存资源：

- 一个 `taskId -> timer JoinHandle` map。
- 一个 `taskId -> { queueId, canceled, sessionId, pendingSessionBirth?, state, error }` 的瞬时 execution map：复用 SessionEngine 普通 turn identity，原子拒绝重叠、撤销未 dispatch turn，并把 stop 与结果提交线性化；`pendingSessionBirth` 只在 metadata 尚未出生时持有该 exact generation 的 lifecycle capability，它不是持久 TaskRun。
- 启动时从 `TaskStore` 的 Running Task 重建 timer。

启动 Task 只有一个事务入口：`run_task_by_id()` 先校验 schedule、提交 `Running`，再 arm timer；arm 失败则提交 `Blocked`。同一 `taskId` 的 run/rerun、terminal transition、timer 替换、soft delete、stop、outcome/history/UI event/delivery side effect 共用 keyed Task-control lifecycle；完整锁序是 `Task control → Session lifecycle → TaskStore`，锁持有期间使用显式 held-guard 入口，禁止二次 acquire。这样旧 stop 或旧 queue 的迟到结果不可能越过新一轮 birth。

timer handle 只负责“何时触发”。真正的 AI Turn 是独立执行作业；Stop 先撤销该次 queue authority，再携带精确 `queueId` 请求 SessionEngine stop。只有精确 stop 得到业务确认才清除 execution、释放 Task owner 并发出 stopped confirmation；失败保留 `stop_failed` 投影与 Session 保护，用户只能重试 stop，不能 rerun/edit/delete。对 `blocked | stopped | done | archived` 再发 stop 只重试 transient turn，保留原终态原因，不追加伪状态迁移。`queueId` 已是执行 generation，禁止再维护冗余 generation counter。worker 异常退出由 RAII claim guard 收敛成可见的 `stop_failed`，不留下不可见的永久 owner。

隐藏的 memory auto-update batch 也复用同一 queue authority：每处理一个 Session 前把当前 Session 发布到 transient execution，`/api/memory/update` 携带 MyAgents Session id 与 `{ kind: 'task', id: taskId } + queueId` 注入 SessionEngine，并在 runtime promotion 前用 MyAgents Session id 回查 Rust authority（external runtime 自己的 thread id 只传给 `runInjectedTurn`，不可混作 Sidecar identity）。禁用/停止若先赢，后续 Session 不再启动；已启动的更新由同一个 `/task/stop` 精确终止。Sidecar owner 同样是 `Task(taskId)`；终止不确定时保留 owner。当前 execution 的成功证据仍只接受 marker 之后、内容精确等于 `MEMORY_UPDATE_OK` 的 assistant message，不做 substring 匹配，也不复用旧历史；但下一批的 cooldown 与 query reset 以已持久化的 user `<MEMORY_UPDATE>` dispatch marker 为准，即使该轮失败也不立即重发。候选范围固定为最近 7 天内存在真人输入的 Session，最终时间依据是 JSONL，而不是可能被自动 turn 污染的 `lastActiveAt`。

### Scheduled tick 与 run-now

二者复用 `task_execution::execute_task()`，但 lifecycle 不同：

- Scheduled tick 推进一次性任务终态、失败状态与 end condition。
- `cron run-now` 是兼容的 manual trigger：Running/Stopped Task 可执行，不启用 scheduler，不改变原 schedule/status；其他终态必须先走 rerun。
- `lastExecutedAt` 记录任何执行；`lastScheduledAt` 只记录 timer tick。Recurring 的下一次触发只使用后者，因此 manual run 不会移动调度锚点。

每次执行前都重新读取 `task.md`，用户修改会在下一次执行生效。运行历史继续写 `cron_runs/<taskId>.jsonl`，这是查询/审计投影，不是 Task 状态权威。

## 3. Session 与配置边界

Task 执行统一经过 `task_execution.rs` -> Rust Sidecar bridge -> Node `SessionEngine` facade，builtin/external runtime 均走 adapter selector。

- 已存在的 Session：runtime/model/provider/reasoning/MCP 全部继承该 Session；Task 不做 turn-scoped 覆盖或回滚。
- 新建执行 Session，或首次 materialize 专属 single-session Session：Task 配置只用于初始化一次。
- Session metadata creator 由 scheduler reservation 在 per-Session lifecycle 内按权威 `SessionStore` 是否存在决定，**与 Sidecar `EnsureSidecarResult.isNew` 无关**。已有 Tab/owner 保活进程不等于 metadata 已出生。
- scheduler reservation 从发布 Session identity 到 metadata birth 只获取一次 per-Session lifecycle authority。Sidecar ensure 必须共享这次 held lease；禁止在 dispatch 下层改走会再次 acquire 同 key 的通用 wrapper，否则新 Session 的 metadata birth 与 ensure 会闭环等待。未 materialize 时，lease 的 fail-closed owner 是 exact `ActiveTaskExecution(taskId + queueId)`，不是可能被 abort/panic 的 worker future；observer 只负责在 metadata 出生后清空该 generation 的 lease，不能成为唯一 owner。
- single-session 的持久 binding 若已没有 Session metadata，执行前换成新 UUID 并原子重绑，绝不复活被用户删除的 Session id；`task:session-rebound` 提示 UI。`AttachedSession` 终态不能 generic rerun，后续工作必须重新 claim/reopen 并创建新的 Attached Task。
- permission 是本轮执行策略，可由 Task 指定；空值解析为对应 runtime 最大权限。
- durable Task 只保存 provider identity (`providerId + model`)，不保存 credential/env。
- 执行期间使用 `SidecarOwner::Task(taskId)`；terminal/stop/delete 对称释放。
- Task turn 的 completion descriptor 保留 `{ kind: 'task', id: taskId }` owner；Rust 通用 Session completion policy 据此抑制 generic toast，Task outcome/notification 仍由 Task domain lifecycle 唯一负责，attached/headless 都不因 Tab 是否存在而改变归属。
- Rust 每次 ensure attempt 只解析一次 owner-aware `RuntimeIdentity(runtime + runtimeSource)`，复用校验与 spawn 必须消费同一快照；Node 创建 Task metadata 时再从 live `SessionEngine.getRuntimeIdentity()` 取一次实际进程身份，并与同一 live config snapshot 绑定，禁止用 payload 中可能漂移的 runtime 反写。

完整 provider/runtime/MCP 规则见 `task_provider_routing.md`。

## 4. Managed Task

memory update、memory evolution、Agent heartbeat 等内部定时工作也写入带 `managedKind` 的隐藏 Task，由同一个 Task scheduler 执行。普通 Task Center 列表默认过滤 managed Task，但 Session/history/audit 保留。

managed job 不再创建 managed CronTask 旁路。memory auto-update 的 configure 以规范化 workspace identity 串行；进入锁后重新读取 `config.json`，磁盘上的最新 Agent 配置是 enable/disable、schedule 与参数的唯一权威，renderer 到达顺序不能覆盖它。

## 5. Legacy Cron 迁移

`cron_tasks.json` 是只读兼容输入。应用启动顺序为：

```text
校验 legacy store
-> migrate_legacy_crons_on_startup()
-> TaskSchedulerController.initialize()
-> Session Goal recovery
```

标准 Cron get/list/start/stop/update/delete/run-now facade 只投影 TaskStore。未迁移历史行仅通过显式只读命令 `cmd_get_unmigrated_legacy_cron_tasks` 进入 Legacy 面板；deleted Task 仍作为 legacy id tombstone，旧行不会重新出现或再次迁移。

迁移规则：

| Legacy row | 处理 |
|---|---|
| 普通 At / Every / Cron | 同 ID 迁移为 Task，保留 schedule、状态、执行统计、Session 策略与通知 |
| 旧 Task-linked projection | 已有 Task 为权威，只补不倒退的 execution/session 数据 |
| managed row | 迁移/关联为隐藏 managed Task |
| Loop / 开发期 Goal row | 不迁移、不恢复 |
| credential 或 workspace 无法安全恢复 | 创建可诊断的 Blocked Task，不猜测路由 |
| store 损坏 | 整库只读，禁止用空/部分数据覆盖原文件 |

迁移幂等依赖原 ID 与 migration provenance，不另建 migration ledger。历史 run 文件尽力沿用/迁移同一 ID。所有新 `cron add/create/update/start/stop` 兼容入口均直接读写 TaskStore，永不写回 legacy 文件。

## 6. 数据完整性

Task mutation 的固定事务边界：

```text
TaskStore write lock
-> clone 当前权威 map
-> mutate + validate
-> 原子持久化 candidate
-> 替换内存 map
-> 解锁
-> event / notification / scheduler 副作用
```

`tasks.jsonl` 解析是 all-or-nothing；任一 malformed/duplicate row 使 Store 保持只读。写盘使用 tmp + `sync_all` + rename + parent fsync。Task id/path 入口统一经过 `validate_safe_id` 与 `task_docs_dir()` containment 校验。

Task 对 Session identity 的保护同时覆盖 durable 与 transient 两层：Running direct single-session Task 保护其固定 Session；`AttachedSession` Task 在 Todo/Running/Verifying/Blocked/Stopped 生命周期保护 Cloud claim 绑定的 Session；一次实际执行从 claim 发布 Session id 到 Sidecar `Task` owner 附着前，由 scheduler active-execution map 保护。任何 durable mutation 只要让 Task 进入上述受保护集合，或给已受保护 Task 新增 `preselectedSessionId/sessionIds` binding，都必须与 Session 删除取得同一个 per-Session lifecycle guard，统一使用 `lifecycle → TaskStore` 锁序；scheduler reservation 已持 guard 时使用显式的 held-guard commit 入口，禁止非重入二次 acquire。

startup legacy migration 也是 durable writer：`create_migrated_with_id` 与 `import_legacy_execution_state` 必须走同一 lifecycle policy，不能以“仅启动期”为由裸拿 TaskStore lock。`create_attached` 在取得 lifecycle 后还要复核 Session metadata；若删除先赢，拒绝创建本地 Attached Task。

首次 materialize 的 Task Session 还把该 guard 保留到权威 `SessionStore` row 出现：creator 与 Sidecar ensure 用 shared lease 表达同一次 acquisition，不能让 ensure 再拿同 key；metadata birth 后 observer 立即从 exact execution generation 清空 lease，另一个共享同一 id 的 Task 才能 adopt。禁止持满整轮，否则 turn 内同 Session 的 Task/Space 工具会等待自己造成死锁。creator 的 turn 若**确认**在 metadata birth 前失败，必须释放 guard 与 Task owner，让下一次 reservation 重新取得 metadata creator 权；若 POST 可能已到 Node、仅响应丢失，则 lease 留在 exact `ActiveTaskExecution`，worker/observer 异常都不能释放。`/task/stop` 的 `not_found` 只有在 Node pre-metadata admission 已取消或 materialize 已结算后才算确认停止，Rust 随后删除 exact generation 并释放 lease；禁止把“runtime queue 暂未注册”误当成 creator 已退出，或在不确定状态下 rebound 出第二个 identity。Sidecar 可被其它 owner 继续保活，这不影响下一次 creator 初始化 metadata。

## 7. Goal 边界

Goal 是 Session 状态，不是 Task execution mode：

- 不创建 Task、不占用 Task status/schedule 字段。
- Task 与 Goal 可在同一 Session 共存；Task scheduler 不感知 Goal。
- Goal turn 的 completion descriptor 保留 `{ kind: 'goal', id: goalId }` owner；generic Session completion 被抑制，Goal terminal/outbox/notification 继续由 Goal domain lifecycle 负责。
- 未来 Task 如需持续执行，可让其 prompt 中的 AI 在当前 Session 调 `myagents goal create`，无需 Task->Goal 编排字段。

详见 `session_architecture.md` 的 Goal Mode 章节。

## 8. 主要入口

- Rust：`src-tauri/src/task.rs`、`task_scheduler.rs`、`task_execution.rs`
- Legacy compatibility：`src-tauri/src/cron_task/*`、`legacy_upgrade.rs`
- Management API：`/api/task/*` 与兼容 `/api/cron/*`
- CLI：`myagents task ...`、兼容 `myagents cron ...`
- Renderer：`src/renderer/components/task-center/`、`useCronTask`（兼容展示 hook）

新建/从想法派发共用 `DispatchTaskDialog`。创建面板不提供手工标签输入；空白新建写入空标签，从想法派发则原样继承来源想法的标签作为 provenance。既有 Task 的标签字段、列表过滤、详情展示与编辑兼容能力保持不变，`TaskStore` schema 不因这项表单收敛而改变。
