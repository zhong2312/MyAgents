# Provider、Model 与 Agent Runtime

## 先分清三个维度

| 概念 | 回答的问题 |
|---|---|
| Provider | 模型从哪家服务获得、怎样认证和计费 |
| Model | 当前具体使用哪个模型及其能力/上下文窗口 |
| Runtime | 谁实际驱动 Agent 回合、工具协议和会话恢复 |

切换 Provider/Model 不一定切换 Runtime；选择某些 runtime-backed Provider 时，Provider 才会同时决定 Runtime 身份。

## Provider 类型

### API Key Provider

用户提供 API Key 和服务地址，MyAgents 通过 Anthropic 协议或 OpenAI 兼容桥接调用。内置列表和模型会随版本变化，应在「模型供应商」或 `myagents model list` 查询，不依赖静态名称表。

适合：用户已有第三方 API 额度，或需要特定厂商模型。

### Anthropic 订阅

复用 Claude Code/Claude 官方订阅凭据体系，不是普通 API Key Provider。用户通过官方登录完成授权；验证要以真实模型请求为准。出现问题时不要要求用户粘贴 API Key。

### Grok 订阅（`xai-sub`）

用户通过 xAI OAuth 登录，MyAgents 负责安全刷新凭据，并通过 builtin Runtime 的 OpenAI Responses 兼容路径使用订阅额度。它仍是 builtin Provider，不是外部 Grok CLI Runtime。

登录成功和模型验证是两个状态：OAuth 完成后仍要验证账户权益和真实推理是否可用。401 通常要求重新登录；403 可能是权益问题；429 可能是额度或限流。

### Codex 订阅（`codex-sub`）

这是 runtime-backed Provider。MyAgents 管理 Codex Runtime 资源和订阅登录；新 Session 的执行身份是 `runtime=codex`、`runtimeSource=managed-provider`。它不受“更多 Agent Runtime”实验开关控制，而由自己的安装、版本、登录和 Provider readiness 决定。

## Runtime 类型

### builtin

MyAgents 自带的默认执行引擎，无需用户另装外部 CLI，并能使用 MyAgents 管理的 Provider、MCP、子智能体与 Claude Plugin 等能力。

### Claude Code CLI / Codex CLI / Gemini CLI

这些属于 `runtimeSource=system-cli`：使用用户本机安装和登录的外部 CLI。需要在「设置 → 关于&反馈 → 实验室 → 更多 Agent Runtime」开启。它们的模型、权限模式、MCP、登录和恢复能力各不相同，不能套用 builtin 的固定值。

## `runtimeSource` 为什么重要

`codex/system-cli` 与 `codex/managed-provider` 都写作 `runtime=codex`，但前者使用用户安装的 Codex 与用户 Codex Home，后者使用 MyAgents 管理的 Runtime 和订阅身份。它们不能互相恢复同一个 Runtime 会话，也不能用同一套登录/MCP 诊断结论。

遇到 Codex 问题时至少确认：

- 当前 Provider 是不是 `codex-sub`
- Session 的 `runtimeSource` 是 `system-cli` 还是 `managed-provider`
- 使用的是哪个模型和 permission mode

## Model 与权限模式

- Provider 可用模型会变化，外部 Runtime 还会动态报告自己的模型列表。
- 不同 Runtime 的 permission mode 名称和含义不同。例如 builtin 的选择不能直接套给 Codex/Gemini。
- Task 可以覆盖该次执行的 Runtime、Model、Permission 和 MCP，不必修改 Agent 默认值。
- Session 出生后会保留必要的 Runtime identity；切换 Agent 默认值不会把历史 Session 静默变成另一种 Runtime。

需要现场值时使用 `myagents runtime list`、`runtime describe`、`agent show` 或设置页，不猜模型 ID。

## MCP 在不同 Runtime 中的关系

- builtin Session 使用 MyAgents MCP 配置，并在会话边界应用变化。
- `codex/system-cli` 的 MCP 由用户 Codex 自己的配置管理，可通过 Runtime diagnostics 查看，MyAgents 不把自己的 MCP 列表注入它。
- `codex/managed-provider` 可以使用当前 Workspace 中安全且兼容的 MyAgents MCP，但并非每种 MCP 都适用；以当前 Session 实际显示的工具为准。
- Claude Code/Gemini 的工具支持以各 Runtime 当前版本在 MyAgents 中实际显示的能力为准。

## 代理与环境

MyAgents 自身的 Provider 请求、插件安装、远程 MCP 与外部 Runtime 是不同网络链路。外部 system-cli Runtime 可以选择跟随 MyAgents 代理或终端环境；订阅管理的 Runtime 跟随对应 Provider 设置。

“终端能用、MyAgents 里不行”不一定是 Runtime 没安装，可能是 PATH、代理、认证 home 或实验门控不同。Codex system-cli 可使用 Runtime diagnostics 对比实际 auth、MCP、apps 和 effective env。

## 正确预期与生效时机

- 新建 Session 会采用当时选择的 Runtime identity；切换到不兼容 Runtime 通常应新开 Session，而不是原地恢复。
- Model/Permission 是否能在当前 Session 即时切换取决于 Runtime 能力；产品会选择 live RPC、下轮生效或重启 Session。
- 由 MyAgents 管理的 Runtime 更新不会为了升级而中断已验证的活跃 Session；下载完成后主要影响后续新 Session。
- Provider 验证会实际消耗一次请求并可能受到网络、额度、权限和模型可用性的影响。

## 常见误解

- “`codex --version` 能跑，所以 MyAgents Codex 一定健康”：只能证明终端路径，不能证明 MyAgents 看到的 auth/env/MCP。
- “Grok 订阅是外部 Runtime”：不是，它走 builtin + 兼容桥。
- “Codex 订阅等于用户自己的 Codex CLI”：不是，两者的 runtimeSource、运行资源和登录状态由不同路径管理。
- “Provider 验证超时就是 API Key 错”：超时也可能是网络；应结合真实状态与日志判断。
- “所有 Runtime 都能使用同一套 MCP/Plugin”：不同 Runtime 各自支持和管理不同的工具能力。
