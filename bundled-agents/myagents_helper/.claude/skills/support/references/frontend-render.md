# 前端 Render、桌宠与悬浮窗诊断

使用场景：白屏、整页渲染错误、某面板打开就崩，或桌面宠物/悬浮窗打不开、卡在“正在连接 Mino”、无法对话。

小助理与悬浮入口的正常定位先读 `/myagents-docs/references/agents-channels.md`。

## 主窗口 Render

- `AppErrorBoundary` 位于 React 根附近，任意组件 render 抛错都可能切成整页错误。
- 发布包组件栈通常压缩；`at t` / `at Dn` 只能作关联证据，不能当根因定位。
- 白屏/稳定 render crash 通常是产品 Bug，不要用重置 Provider/MCP 掩盖。

```bash
myagents status --json
myagents version
rg -n "\\[AppErrorBoundary\\]|\\[REACT\\] \\[ERROR\\]|Cannot read properties|Minified React error|render" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -100
rg '\[boot\]' ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -5
```

补齐：崩溃前最后动作、是否稳定复现、一个 Workspace/Session/消息还是全局、最近是否切换 Runtime/安装插件/打开媒体或历史。

## 桌宠 / 悬浮窗 Ground truth

- `fb-ball` 与 `fb-companion` 是独立 Tauri WebView，不挂主窗口 `App.tsx`；主窗口正常不证明它们的 renderer 正常。
- 关键日志前缀：`[fb-ball]`、`[fb-companion]`、`[fb-session]`、`[tauriClient] Global sidecar`。
- 悬浮会话链路依次涉及窗口 boot、Global Sidecar、mint/reuse Session、ensure Session Sidecar、sync config、SSE、history 与 send。

```bash
rg -n "fb-ball|fb-companion|fb-session|Global sidecar|正在连接 Mino|startup timeout|cmd_get_global_server_url" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -200
```

判断顺序：

1. 没有 `[fb-companion]` boot：窗口未创建、入口资源或 renderer 早期崩溃。
2. 有 boot、没有 unified log sink ready：查 Global Sidecar URL 获取与 Rust 启动错误。
3. `[fb-session] boot/connect failed`：按日志 stage 收窄到 mint、ensure sidecar、sync config、SSE 或 history。
4. 已 ready，send failed：保留 Session、Workspace、Runtime 和错误，转 `session-sidecar.md` / `provider-mcp.md`。
5. ball 素材失败但回退为 orb：若入口仍可用，这是素材降级；若窗口崩溃才是 render Bug。

看到 `Global sidecar startup timeout` 时不要只写“启动慢”。核对 Rust boot/Global Sidecar 是否启动或崩溃、悬浮 WebView 是否拿到 URL，以及失败 stage。

## 报告要点

- version、OS、boot 与窗口 label
- 原始 error、最后动作、最小复现
- 主窗口是否正常；ball/companion 哪一层可见
- `[fb-session]` 首个失败 stage 或 AppErrorBoundary 首个异常
- 是否关联特定 Workspace/Session/message/attachment

不要把压缩组件名、一次 timeout 或后续连锁错误写成已确认根因。
