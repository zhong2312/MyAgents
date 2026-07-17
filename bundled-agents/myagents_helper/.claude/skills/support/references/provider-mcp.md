# Provider、订阅登录与 MCP 诊断

使用场景：Provider/API Key/订阅登录/模型不可用、回复报错，或 MCP 工具不显示、启动/登录/握手失败。

正确概念与生效时机先读 `/myagents-docs/references/models-providers-runtimes.md` 和 `tools-skills-plugins.md`。

## Provider Ground truth

- Provider 的 authType、baseUrl、模型列表和上下文能力可能变化，现场 discovery 优先于静态印象。
- API Key Provider、Anthropic 订阅、Codex 订阅和 Grok 订阅不是同一种认证路径。
- `anthropic-sub` 是 builtin Runtime 的 Anthropic 订阅 Provider。
- `codex-sub` 创建 `runtime=codex` + `runtimeSource=managed-provider` 的会话，不是用户系统 Codex CLI。
- `xai-sub` 是 Grok 订阅 Provider：使用 builtin Runtime，经 OpenAI Responses bridge 调用；OAuth 凭据由 Rust `GrokAuthManager` 持有。它既不是 API Key Provider，也不是外部 Runtime。
- Provider verify 会真实请求服务，属于 active probe。UI timeout 后日志仍可能出现更具体的服务端结果。

## Provider 取证

```bash
myagents model list --json
rg -n "provider/verify|subscription/verify|auth error|401|403|429|verification|model_error|terminal_reason|anthropic-sub|codex-sub|xai-sub|managed-codex|grok-auth|entitlement|quota|usage credits" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -200
```

API Key Provider 需要现场复测时：

```bash
myagents model verify <provider-id> --json
myagents model verify <provider-id> --model <model-id> --json
```

订阅 Provider 先用设置页、`model list` 与日志看登录/readiness。只有精确 help 明确支持时才运行对应 verify；不要把“不接受 API Key verify”当成订阅失败。

## Provider 判断

- `401` / auth required：API Key 路径检查 Key；订阅路径检查对应登录态，不要混修。
- `403` / entitlement required：检查账号权益、模型访问、地区或订阅资格，不等同于凭据格式错误。
- `429`：限流或当前额度不可用；保留 retry 信息，不反复 verify 放大问题。
- `5xx` / network：供应商或链路暂不可用，结合代理与时间线判断。
- Anthropic 1M context 报错：优先查 entitlement / extra usage，不先改模型 ID 猜测。
- `codex-sub`：同时看 Provider readiness 与 `[managed-codex]`，保留 `runtimeSource`。
- `xai-sub`：查 `[grok-auth]` 的 login/refresh/entitlement/rate-limit 分类。不要读取 Grok credential store，也不要让用户提供 OAuth token。
- “以前能用”：对比最近登录刷新、Provider/代理变化、供应商状态与实际失败时间。

## MCP Ground truth

- MCP 配置变化不会进入已经开始的回合。builtin Session 通常在下一条消息触发必要的配置应用；不要承诺所有变化都只能靠新建 Session。
- `mcp test` 会启动或连接 server；OAuth start 会打开外部授权，二者都是 active probe。
- `enabled` 不代表 OAuth token 仍有效。
- `codex/system-cli` 使用 Codex 自有 MCP；`codex/managed-provider` 可能注入安全兼容的 MyAgents Workspace MCP。先确认 runtimeSource 再选证据。

## MCP 取证

```bash
myagents mcp list --json
myagents mcp show <mcp-id> --json
myagents mcp oauth status <mcp-id> --json
rg -n "\\[mcp\\]|MCP|mcp.*failed|command not found|oauth|tool_use|tool_result|managed-codex|runtimeSource" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -160
```

需要复现握手时，在说明影响后运行：

```bash
myagents mcp test <mcp-id> --json
```

判断要点：

- `command not found`：核对 command 与实际子进程 PATH；MyAgents 自带 Node/npx 不代表所有用户 CLI 都存在。
- 远程 timeout：查 URL、传输类型、代理、证书和服务端可达性。
- OAuth 过期：先用 status 证实，再经产品入口重新授权。
- 配置刚改、当前正在执行的回合看不到：属于回合边界；下一条消息后仍缺失再查 fingerprint/restart/Runtime 路径。
- tool result 已有但媒体不显示：转 `attachments.md`。

## 修复与验证

- 不读取或回显任何 Provider/MCP secret。
- 修改后既要核对配置状态，也要从原 Workspace/Runtime 发起真实一轮并观察目标模型或工具是否可用。
- 若只有某个 Runtime 失败，避免重置全局 Provider/MCP；沿该 Runtime 的 owner 修复。
