# 工作区文件 IO 诊断

使用场景：工作区文件树/搜索/预览异常；`@` 文件或图片失败；拖拽/粘贴附件失败；新建、重命名、删除、移动、在 Finder/默认应用打开文件不正常。

正常 Workspace、Session 与文件能力先读 `/myagents-docs/references/workspaces-sessions-files.md`。

## Ground truth

- 工作区文件 IO 是 OS 文件操作，不是 AI runtime 容器能力。前端走 Tauri invoke 的 `cmd_workspace_*` 系列命令，不走 Session Sidecar HTTP。
- 前端统一入口是 `useWorkspaceFileService(workspacePath)`。Chat 和 Launcher 都应复用这条路径；Launcher 没有 Session Sidecar 也必须能用文件能力。
- 读侧会 canonicalize 已存在路径，阻止 symlink 逃逸；写侧用 lexical 解析，因为目标文件可能还不存在。
- watcher 使用 token handle：`watch_start` 返回 `{ token, eventKey }`，`watch_stop({ token })` 停止。前端监听 `workspace:files-changed:<eventKey>`。
- 绝对路径揭示和外部打开有安全限制；home/tmp 下的凭据路径不能直接暴露。
- Workspace 文件能力与 AI 工具读写是两条路径：前者可在 Launcher 无 Sidecar 工作，后者仍受当前 Runtime/工具权限影响。

## 取证

```bash
myagents status --json
rg -n "cmd_workspace|workspace_files|DirectoryPanel|SimpleChatInput|FilePreviewModal|RichDocViewer|WorkspaceTree|workspace:files-changed|watch_start|watch_stop|Unsupported file type|File type not supported|symlink|resolve_existing_inside_workspace" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
rg -n "\\[AppErrorBoundary\\]|\\[REACT\\] \\[ERROR\\]" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -80
```

如果用户的问题是“文件生成了但媒体不显示”，转 `attachments.md`；如果是 AI 工具读写工作区内文件失败，再同时查该 runtime/tool 的日志。

## 判断

- 文件树/搜索失败：优先看 `cmd_workspace_*`、workspace root、权限、路径安全错误，不要先查 Sidecar 端口。
- 预览失败：看文件类型、大小限制、编码、symlink/path-safety、`FilePreviewModal` / `RichDocViewer` 前端错误。
- `@` 文件或图片失败：看 `SimpleChatInput`、附件 staging、图片 MIME/大小和用户消息发送前的准备流程。
- 拖拽/粘贴失败：区分 UI 没收到文件、Tauri 读文件失败、还是后续消息 attachment 管线失败。
- 文件树不刷新：重点查 watcher token/eventKey、`workspace:files-changed:<eventKey>`、是否 stop 了旧 watcher。
- Launcher 文件能力失败但 Chat 正常：很可能是误走了需要 Sidecar 的老路径，这是产品 bug 线索。

## 修复边界

- 不要直接引导用户改 `~/.myagents` 内部索引来修文件树。
- 不要把工作区文件 IO 失败归因到 Provider/MCP，除非证据显示失败发生在 AI runtime turn 内。
- 涉及删除/覆盖/移动前必须让用户确认具体路径；报告里路径要脱敏 home 用户名和凭据片段。
- 修复后从用户原入口验证同一种操作，并同时确认文件系统真实结果与 UI watcher 刷新；只看到命令成功不代表界面已同步。
