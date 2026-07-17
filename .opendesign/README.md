# Open Design 交换区

这里保存 MyAgents 与 Open Design 之间可审计的设计上下文。产品约束、数据模型和实现以 MyAgents 仓库为准，设计工作稿以 Open Design 项目为准，`export/` 只保存按 run 隔离的设计快照。

- `brief.md`：当前设计任务书。
- `context.json`：仓库、任务与 Open Design 项目映射。
- `feedback.md`：评审意见与下一轮修改要求。
- `sync-state.json`：同步游标、哈希和冲突。
- `export/`：`<project-id>/<run-id>/` 形式的不可变设计快照。

使用全局 `$open-design` 技能维护该目录。禁止写入密钥、Cookie、访问令牌和个人数据。
