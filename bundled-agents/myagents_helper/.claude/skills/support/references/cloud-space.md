# Team Space 诊断

使用场景：Space 入口、登录、成员/Goal/Issue/Skill/Registered Agent、Delivery、claim、附件、quota 或本地执行衔接异常。

正常产品概念先读 `/myagents-docs/references/cloud-space.md`。Team Space 是云端协作层；本地 Session Goal 与 Space Goal、本地 Agent 与 Registered Agent、本地 Task 与 Cloud Issue 都不是同一资源。

## Ground truth

- Space 有构建 capability 与 `teamSpaceEnabled` 实验开关两层入口门控；入口问题先转 `feature-gates.md`。
- 登录、Cloud API、Registered Agent token、Delivery connector、附件上传下载由 Rust Tauri 层拥有，不经过 Session Sidecar。
- CLI 业务命令必须显式 `--space <slug>`。当前 Workspace 有 active registration 时可用 Registered Agent 身份，否则用当前 User；delivery-bound Session 身份/Workspace 不匹配时应拒绝，不能静默降级。
- Space delivery 是通知/投送事实，不等于 assignee 或 operational claim。claim 建立云端责任与本地 Task/Session 连接。
- `claim --create-attached`、comment、complete、attachment add/download 都会改变云端或本地状态；Space mutation 不支持假 `--dry-run`。
- Rust 持有 User/Registered Agent token。不得读取 Space session/registered agent store 或让用户提供 token。

## 被动取证

```bash
myagents space list --json
myagents space whoami --space <slug> --json
myagents space goal list --space <slug> --json
myagents space issue view <issue-id> --space <slug> --comments --json
rg -n "\\[space\\]|space_cloud|registered-agent|delivery|claim|assignee|notificationVersion|operationKey|quota|entitlement|attachment|conflict|401|403|409|429" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -220
```

只查询与主诉有关的 Space/Issue。更早评论通过精确 leaf help 使用 comments cursor；delivery 指定的截断评论用 `space issue comment get`，不要扫描猜触发内容。

## 分界判断

- `space list` / whoami 失败：先分登录失效、build/开关、网络、membership/permission。
- 看得到 Space、看不到某 Goal/Issue：核对显式 slug、筛选、分页、active Goal 与权限，不把 title 当 ID。
- `401`：当前 User 或 Registered Agent 身份失效；`403`：membership/role/entitlement；`409`：云端状态或 notification version 冲突；`429`：quota/限流。保留服务端 code/recovery，不用通用“网络错误”覆盖。
- Agent 没收到 Issue：分清是否真的产生该 Agent 的 assignment/subscription/follow-up delivery，再查 connector poll → Session inbox → ACK。
- 收到 delivery 但执行到别的 Workspace/Session：检查 registration、delivery-bound context 和 claim 返回的 localTaskId/localSessionId。
- claim 成功、本地 Task 创建失败：这是跨云端/本地补偿边界；保留 claim origin、deliveryId、Task/Session ID，不盲目重复 claim。
- `complete` 云端成功但本地 Task 未 done：先读两侧权威状态；不要重复 Cloud complete 或再无条件 `task update-status done`。
- 附件失败：区分 Cloud upload/download、Workspace 路径安全、大小/数量/quota 与本地预览；UI 富媒体显示再转 `attachments.md`。

## Active 操作与验证

任何 claim、ignore、comment、complete、附件或注册变更前，展示明确对象与影响并取得用户确认。以精确 leaf `--help` 为准；不要添加不支持的 `--dry-run` 冒充预览。

修复后沿原链路验证：

1. Cloud `issue view` / whoami 读取权威状态。
2. 若涉及 Agent，确认 delivery/claim 与本地 Task/Session 绑定。
3. 从原 Workspace 完成一次最小回写或附件路径。
4. 确认 UI/CLI 与云端状态一致，且没有重复评论、重复 Task 或错误 assignee。

## Issue 报告要点

包含 Space slug、Issue number/ID、Goal ID、actor 类型（User/Registered Agent）、delivery/claim/Task/Session ID、Cloud error code、时间线与脱敏日志。不要包含 token、完整用户内容或 credential/store 路径内容。
