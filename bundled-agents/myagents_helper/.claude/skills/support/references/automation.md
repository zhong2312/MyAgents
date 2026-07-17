# Task、定时自动化、Goal 与 Thought 诊断

使用场景：Task/Cron 到点没执行、任务状态卡住、Goal 不续跑或终态错误、Thought 异常、需要向另一个 Session 反馈。

正确产品语义先读 `/myagents-docs/references/automation.md`。这里仅处理实际行为偏离预期的现场。

## Ground truth

- Rust `TaskStore` 是 Task 与 schedule 的持久化权威，`TaskSchedulerController` 从 Running Task 重建 timer。Cron 是兼容操作面，不是另一套 `CronTaskManager` 数据源。
- Cron 命令默认按当前 Workspace 过滤；空结果不代表其它 Workspace 没有定时 Task。
- Goal Mode 属于当前 Session，会复用该 Session 持续推进；它不是 Task Center Task，也不是 Cloud Space Goal。
- Goal、Task、Agent Channel、Tab 和 Background Completion 都可能持有同一个 Session Sidecar owner。没有可见 Tab 不等于执行一定应停止。
- 长期记忆维护可由隐藏的系统 Task 触发，普通 Task 列表不一定展示这些内部维护行。
- `cron run-now`、`task run` / `rerun` 会真实执行，属于 active probe。

## Task / Cron 取证

```bash
myagents cron status --json
myagents cron list --json
myagents cron list --workspace <absolute-workspace-path> --json
myagents cron runs <task-id> --limit 20 --json
myagents task list --json
myagents task get <task-id> --json
rg -n "task-scheduler|\\[task\\]|CronTask|cron_runs|nextRun|workspacePath|execution failed|runtimeSource|terminal_reason" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
```

判断顺序：

1. 先核对 Task ID、Workspace、status、enabled/schedule、时区与 next run。
2. 有无 scheduler dispatch；没有则收窄到调度/状态恢复。
3. 已 dispatch 但没结果，沿关联 Session 的 Runtime、Provider、terminal reason 查。
4. 有执行结果但 Task 状态或通知不对，区分状态归并与结果投递。

常见分流：

- 只在别的 Workspace 查得到：作用域误解，不是任务丢失。
- schedule 合法但应用重启后不再触发：重点查 Task scheduler 重建与 Task 当前状态。
- 外部 Runtime 执行失败：带上 `runtimeSource` 转 `runtime.md`。
- Task 做完但 IM/桌面没收到结果：转 `agent-channel-plugin.md` 或 Session owner/投递链路。

需要复现调度时，先向用户说明会实际启动一次执行及其可能的工具调用、费用和外部副作用；只有取得明确确认后才运行：

```bash
myagents cron run-now <task-id>
# 或按 Task 当前状态和精确 help 选择：
myagents task run <task-id>
myagents task rerun <task-id>
```

## Goal Mode 取证

```bash
myagents goal get
rg -n "\\[Goal\\]|goal|token_budget|continuation|complete|blocked|pause|cancel|owner|terminal_reason" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
```

判断要点：

- `goal get` 查的是当前 Session；不要拿另一个 Tab、Task 或 Space Goal 的状态来比较。
- 一轮正常结束但没有续跑：查 Goal 是否仍 active、Session 是否成功完成、宿主 continuation 是否发起。
- `complete` 应只表示目标真正完成；`blocked` 应表示达到产品定义的受阻条件。模型自行停止、报错或 token 接近上限不能冒充正确终态。
- 用户取消由 UI/宿主负责，不要用 `goal update --status blocked` 代替取消。
- Goal 执行中切换 Tab 或关闭可见入口后异常停止：保留 Session ID 和 owner 证据，转 `session-sidecar.md`。

## Thought 与 Session Inbox

```bash
myagents thought list --json
```

Thought 只负责收集，不会自行执行。若内容存在但后续 Task 未创建，先确认用户是否真的走了对齐/物化流程。

当用户明确要求给另一个 Session 反馈、追问或下指令时：

```bash
myagents session send <session-id> -p "..."
```

多行内容用 `--prompt-file`。仅回答当前用户时不要使用 `session send`；发送会改变另一个 Session，执行前确认目标 Session 和消息内容。

## 修复边界

- 不直接编辑 Task、Goal 或 Session store。
- 修改 runtime/model/permission/MCP override 前，先用 `task get`、`runtime describe` 与 `agent show` 确认合法值和继承来源。
- 修复后必须验证原 Task 的下一次 dispatch 或同路径手动执行，以及最终状态/投递；只看到 scheduler online 不算恢复。
