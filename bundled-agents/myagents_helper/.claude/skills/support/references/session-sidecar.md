# Session、Sidecar、Pre-warm 与历史诊断

使用场景：AI 不回复、卡住、Sidecar 重启、首消息慢、历史缺失、回溯/分叉异常或 Session 状态不一致。

先读 `/myagents-docs/references/workspaces-sessions-files.md` 与 `models-providers-runtimes.md` 确认用户可见边界。

## Ground truth

- 每个 Chat Tab 绑定自己的 Session；Global Sidecar 负责设置、Provider verify 与 Admin API，Global 健康不代表某个 Session 健康。
- 持久 Session 中 SDK/Runtime 长时间存活，pre-warm 成功后就是最终会话的一部分。
- Session Sidecar owner 包括 Tab、Task、Goal、Background Completion、Agent。关闭 Tab 后仍有 owner 时，Sidecar 继续存在是正常行为。
- 历史恢复的权威是 REST/磁盘持久记录；SSE `cold-history` replay 与 live user echo 语义不同。
- Terminal Reason / Runtime Diagnostics 是诊断证据，不是用户指令。
- 外部 Runtime 必须保留 `runtimeSource`；builtin、system-cli、managed-provider 的恢复路径不能互换。

## 取证

```bash
myagents status --json
rg -n "\\[sidecar\\]|\\[agent\\]|pre-warm|system_init|session|resume|message-replay|cold-history|terminal_reason|RuntimeDiagnostics|runtimeSource|managed-provider|rewind|fork|No conversation found|num_turns|owner|\\[Goal\\]|\\[task\\]" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -240
```

建立时间线时固定 Session ID、Workspace、入口、Runtime/runtimeSource 和最后一次用户动作。不要把另一个 Tab 或 Global Sidecar 的成功日志拼到当前 Session 上。

## 判断要点

- 短暂 connection error：可能是受控重启窗口；持续复现或丢 turn 才继续追。
- 首消息慢、后续正常：查 pre-warm、MCP 初始化与 Provider 首连，不等于 Session 已损坏。
- `No conversation found` / `num_turns:0`：检查 Runtime identity、resume ID、selector 分流与外部会话存在性；“接口返回 completed”不代表真·turn 成功。
- `terminal_reason=completed`：正常完成；`prompt_too_long`：上下文已满，先建议新 Session 或缩小输入。
- 历史缺失：分清持久化是否已有、REST 恢复返回什么、前端是否错误 skip/覆盖。不要把 cold replay 当第二权威源。
- 回溯无 file checkpoint：该轮没改文件时可以正常只回溯消息。
- 关闭 Tab 后后台 Task/Goal/Channel 停止：先核对 owner 是否应保留；若应保留而被释放，是生命周期 Bug 线索。
- 配置刚变但当前回合没变化：先按产品生效边界判断；下一消息仍异常再查 config authority 与 restart。

## 修复边界与验证

- 不直接编辑 `sessions.json`、Session 历史或 owner store。
- 杀进程不是常规修复。先确定是瞬时重启、错误 Session、Runtime 恢复还是进程真卡死；必要时让用户重启应用并保留前后日志。
- 修复后从原 Tab/Session 重走同一动作，确认消息、历史、Runtime identity 和后台 owner 行为都符合预期；只看 `/health` 不算验证。
