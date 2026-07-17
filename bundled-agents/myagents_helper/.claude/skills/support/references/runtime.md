# Runtime 诊断

使用场景：Codex / Gemini / Claude Code 不工作；终端能用但 MyAgents 里不行；外部 Runtime 的模型、权限、MCP、登录或代理异常。

先读 `/myagents-docs/references/models-providers-runtimes.md` 确认 Provider / Model / Runtime 与 `runtimeSource` 的产品边界。

## Ground truth

- `system-cli`：用户系统安装和登录的 Claude Code / Codex / Gemini CLI，受实验室开关 `multiAgentRuntime` 控制。
- `managed-provider`：由 Provider 管理的 Runtime，典型是 `codex-sub`。它不受上述实验开关控制，而由 Provider readiness 与 Managed Codex 状态控制。
- `codex/system-cli` 与 `codex/managed-provider` 都显示 `runtime=codex`，但登录、Runtime Home、MCP、版本和恢复身份不同；必须保留 `runtimeSource`。
- system-cli Codex 的 MCP 由 Codex 自己管理，MyAgents 不把 Workspace MCP 注入其中。
- managed-provider Codex 启动 app-server 时，会尝试注入当前 Workspace 中安全且兼容的 MyAgents MCP；builtin/in-process、不支持的传输或不安全配置会被跳过。因此“Codex MCP 都与 MyAgents 无关”只适用于 system-cli。
- 不同 Runtime 动态声明自己的 model 与 permission mode，不能套用 builtin 值域。
- 外部 Runtime 的 env/proxy/PATH 可能与交互式终端不同，`codex --version` 只能证明终端路径的一小段。

## 被动取证

```bash
myagents runtime list --json
myagents runtime describe codex --json
myagents runtime describe gemini --json
myagents agent list --json
myagents agent show <agent-id> --json
rg -n "MYAGENTS_RUNTIME|external-session|external-runtime|runtime_diagnostics|RuntimeDiagnostics|runtimeSource|managed-provider|managed-codex|codex-sub|Codex|Gemini|ACP|app-server|envPolicy|mcp" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -200
```

先确认：当前 Session ID、Provider、runtime、runtimeSource、model、permission mode、Workspace。不要把 Agent 默认配置直接当作已有 Session 的实际身份。

## system-cli Codex active probe

```bash
myagents runtime diagnose codex --workspacePath <absolute-workspace-path> --json
```

它会启动短命 Codex app-server，并读取 Codex 自己看到的 auth、experimental features、MCP server status、apps 与 effective env。执行前说明会启动进程并触发 Codex 侧检查。

该结果只证明 `codex/system-cli` 路径。对 `codex-sub` / `runtimeSource=managed-provider`，应看 Provider readiness、Managed Codex 版本/安装/订阅登录和对应 Session 日志，不能拿 system-cli probe 代替。

## 判断要点

- system-cli 未安装或探测不到：按 `runtime list/describe` 的 recovery hint 处理，检查 PATH 与 CLI 自身启动。
- `multiAgentRuntime` 关闭：system-cli 路径不生效；不要用 config 写入绕过 UI 门控。`codex-sub` 不按此判断。
- system-cli auth 不健康：让用户用 Runtime 自己的登录入口恢复；MyAgents 不伪造其登录态。
- managed-provider 不健康：查 `[managed-codex]`、订阅状态、Provider readiness 与 `runtimeSource=managed-provider`，不要要求用户修系统 Codex Home。
- system-cli MCP/apps 异常：看 `runtime diagnose` 的 Codex 自有状态。
- managed-provider MCP 缺失：先确认它是否属于允许注入的 Workspace MCP，再查 app-server 启动参数与 skip 原因；不能笼统归因给 Codex 自有配置。
- `effectiveEnv.proxyPolicy=terminal` 但 proxy 为空：说明探测到的终端环境没有这些变量，不足以证明 MyAgents 漏注入。
- `No conversation found` / 空成功：保留 Session runtime identity，转 `session-sidecar.md` 查错误恢复或分流。

## 修复边界

- 调整 Agent runtime/model/permission 前先 `agent show` 与 `runtime describe`，并说明是改变默认值还是当前/后续 Session。
- 不猜模型名，不直接改 Runtime Home 或凭据文件。
- 修复后从用户原入口新发一轮，核对实际 Session 的 runtimeSource、真·turn 成功和工具状态；仅 `runtime list` 变绿不算完成。
