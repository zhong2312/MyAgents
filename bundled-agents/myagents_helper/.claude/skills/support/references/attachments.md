# Tool Attachment 与富媒体诊断

使用场景：图片、音频、PDF、截图等工具产物生成但不显示；Codex `image_generation` 有结果没图；IM 没发出媒体；工具卡有路径但 gallery 空白。

正常产物与安全边界先读 `/myagents-docs/references/tools-skills-plugins.md`。

## Ground truth

- MyAgents 用统一 `ToolAttachment[]` 管线跨 Runtime 渲染媒体，不应依赖某个工具的专用 React 卡片。
- Sidecar 归档路径形如 `~/.myagents/generated/tool-attachments/<sessionId>/<turnId>/`；中间 namespace 在部分来源中会使用 toolUseId。报告时以实际路径和事件字段为准，不臆造二者相等。
- 部分工具把稳定产物写到 `<workspace>/myagents_files/<tool>/`；外部 Runtime 也可能先返回原始 `savedPath`，再由当前 Session 安全归档/引用。
- 流程可能先发 placeholder，再通过 `chat:tool-attachment-update` 以 `(toolUseId, pendingId)` 替换成真实 attachment。
- attachment endpoint/registry 归当前 Session owner Sidecar。不要拿另一个 Session 的文件 URL 验证当前 Session。
- 不把大 base64、文件内容或敏感绝对路径放进日志摘要和 Issue。

## 取证

先从诊断信封拿到实际 Workspace 与 Session ID，再在对应位置检查；不要把小助理自己的 cwd 当成用户 Workspace。

```bash
find <HOME>/.myagents/generated/tool-attachments/<session-id> -maxdepth 3 -type f 2>/dev/null | tail -40
find <absolute-workspace-path>/myagents_files -maxdepth 4 -type f 2>/dev/null | tail -40
rg -n "tool-attachment|ToolAttachment|chat:tool-attachment-update|pendingId|imageGeneration|image_generation|savedPath|sourcePath|ToolAttachmentGallery|myagents://|error://|rejected_path|too_large|unsupported_url" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -200
rg -n "\\[AppErrorBoundary\\]|\\[REACT\\] \\[ERROR\\]" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -80
```

只记录：相对路径/脱敏路径、文件名、大小、MIME、Session/turn/tool/pending ID 和错误类别。

## 分界判断

- tool result 只有文本路径、没有 attachment 事件：Runtime adapter 的提取/归一化问题。
- 有 placeholder、没有 update：异步保存、pendingId 匹配或 update SSE 问题。
- 有 update、磁盘无文件：下载/复制/路径安全/大小限制失败。
- 文件存在、registry/endpoint 读不到：Session owner、ref 注册、CORS/CSP 或 Sidecar 生命周期问题。
- endpoint 可读、前端不显示：gallery、MIME、组件 render 或历史恢复问题。
- Codex 生成图：保留 `runtimeSource`、`savedPath` 与 fallback 日志；不要只查某个 MCP 产图分支。
- 对话里已显示但 IM 没发出：转 Channel media forward，确认文件是否在允许目录且 MIME/平台支持。

## 验证与报告

修复后必须用原工具、原 Runtime、同一类文件重新生成一次，并确认 placeholder → update → gallery/IM 的完整链路。

Bug report 带：

- Session ID、turn/toolUseId、pendingId（日志存在时）
- Runtime 与 runtimeSource、工具名
- attachment 相对路径、大小、MIME
- placeholder/update/registry/endpoint/UI 哪一段首次偏离
- AppErrorBoundary、路径安全或大小限制的具体错误类别
