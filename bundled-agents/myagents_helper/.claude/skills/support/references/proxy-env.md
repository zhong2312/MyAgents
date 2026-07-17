# 网络、代理与环境变量

使用场景：Provider 不通、npm/plugin 拉包失败、MCP 远程服务不可达、外部 Runtime 在终端能用但 MyAgents 里不能用、localhost 被代理导致 502。

不同网络链路的产品 owner 先读 `/myagents-docs/references/settings-safety.md` 与 `models-providers-runtimes.md`。

## Ground truth

- MyAgents 有自己的代理设置，Rust 启动子进程时会注入 proxy env，并保护 localhost/127.0.0.1 不走代理。
- `runtimeSource=system-cli` 的外部 Runtime 有 `envPolicy.proxy`：`myagents` 使用 MyAgents 设置的代理，`terminal` 尝试复现用户交互式 shell 的 proxy env。
- builtin Provider 路径和 external Runtime envPolicy 不是同一套机制。
- `runtimeSource=managed-provider` 的 `codex-sub` 走 Provider 管理的 runtime 链路，要同时看 Provider 状态和 `[managed-codex]` 日志，不要只按用户系统 Codex CLI 的环境判断。
- 插件 npm 安装、远程 MCP、Provider verify、Codex app-server 诊断是不同链路，要按现象分开查。
- Cloud Space 也有独立 Rust HTTP 链路；只有 Space 异常时转 `cloud-space.md`，不要用外部 Runtime 的 envPolicy 解释。

## 取证

```bash
myagents status --json
rg -n "proxy|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|502|npm install|registry|provider/verify|runtime_diagnostics|effectiveEnv|runtimeSource|managed-codex|codex-sub" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
```

system-cli Codex env 差异：

```bash
myagents runtime diagnose codex --workspacePath <absolute-workspace-path> --json
```

## 判断

- 用户终端能访问，MyAgents 不能：优先查 external runtime `effectiveEnv` 或 MyAgents proxy 设置，而不是直接让用户重装。
- `terminal` policy 下 proxy 为空：用户 shell 没导出 proxy，不是 MyAgents 漏读。
- localhost 502：关注本地代理是否劫持 localhost，日志里通常有 Rust proxy/reqwest 连接错误。
- npm registry 拉不到：查 `[bridge] npm install` stderr、registry、代理、证书。
- Provider timeout 无 401：更可能是网络/代理/供应商不可达。
- 只有一条远程链路失败、其它正常：优先查该 owner 的 URL、provider scope 与 proxy policy，不做全局网络重置。

## 修复边界

- 可以建议用户在 MyAgents 设置里配置代理，或把外部 Runtime 的 proxy policy 切到“跟随终端”。
- 不要要求用户安装系统 Node 来修 MyAgents 自身进程；最终用户应是 bundled Node 零依赖。
- 不要把代理 secret 原样写进报告。
- 修改后必须重走原来的 Provider verify、MCP test、Plugin 安装或 Runtime probe；只验证普通网页可访问不能证明目标链路恢复。
