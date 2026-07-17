# 设置、功能可用性与安全边界

## 动态事实要现场查询

MyAgents 的模型列表、Runtime 版本、Provider 验证状态、MCP/Skill 安装、Agent 在线状态和实验功能开关都会变化。本文说明规则，不替代当前实例状态。

用户问“我现在有哪些/有没有开启/为什么看不到”时，优先查看设置页或使用对应的只读 CLI discovery；不要从版本印象猜。

## 关键实验室能力

### 更多 Agent Runtime

允许使用用户系统安装的 Claude Code、Codex、Gemini CLI，默认关闭。只门控 `runtimeSource=system-cli`；Codex 订阅这类 `managed-provider` 由自己的 Provider readiness 控制。

### CLI 工具注册表

允许注册用户自己的 Agent-CLI 工具，默认关闭。关闭时不会显示/管理用户工具，也不会把它们注入新 Session；官方 `myagents` CLI 与官方工具不受影响。该开关不能由通用 config 命令绕过，需要用户在可见 UI 中主动开启。

### Team Space

开启云端团队协作入口。关闭时本地 Chat、Task、Agent、MCP 等能力仍正常；不要把 Space 不可见误判成整个 MyAgents 配置损坏。

实验室开关强调用户知情。Agent 不应通过直接改 config 绕过人类可见门控。

## 常见生效时机

| 变更 | 正确预期 |
|---|---|
| MCP 增删、启停、env、OAuth | 配置先写入；已开始的回合不会获得新工具，通常在下一条消息触发必要重启后应用 |
| Claude Plugin 启停/安装 | 触发柔性 Session 重启，下一条消息/新 Session 最可靠 |
| 用户 Skill 安装或启停 | 新 Session 最可靠；产品会同步到 Workspace，但不会 retroactive 改写正在执行的回合 |
| 用户 CLI Tool 启停 | 工具 shim 与新 Session 的发现状态分开；description 主要进入新 Session |
| Agent 默认 Model/Runtime/Permission | 影响后续出生或 live-follow 路径；已有持久 Session 保留自己的身份边界 |
| Provider/代理配置 | 写入后可即时影响后续请求，但已有进程是否重启取决于配置类型 |
| UI 语言 | 主窗口、原生托盘和浮窗应通过统一语言状态同步 |

用户描述“刚改完但当前正在生成的回复没变化”时，先判断是否属于正常回合边界，而不是立即报 Bug。

## 本地数据边界

MyAgents 的用户数据主要位于 `~/.myagents/`，包括配置、Session、Task、日志、附件、Skill、插件和云端本地状态。这个目录是应用数据库，不是普通 Workspace。

安全原则：

- 查询和修改优先使用产品 UI、脱敏 Admin API 或 `/myagents-cli`。
- 不直接编辑 `sessions.json`、`sessions/`、`projects.json`、Task store 或版本 gate 文件。
- 不读取凭据存储来“帮用户看看 token”：包括 Provider secrets、Space session/registered-agent token、Grok OAuth、Claude/Codex credential home、系统 Keychain。
- 用户未主动提供 API Key 时，不追问明文；引导在设置页填写。
- 日志与 Issue 中的 Key、Token、Secret、Webhook query、绝对 home 用户名都要脱敏。
- 删除、覆盖、重置登录、移除 Channel/Plugin 前确认具体对象和影响。

## 权限与自主性

Permission mode 决定 Agent 在工具调用和文件修改时的自主程度，不同 Runtime 的枚举不同。桌面交互、无人值守 Task/Goal、IM Channel 可能有不同默认策略。

更高权限不等于可以越过产品安全边界：路径保护、实验门控、凭据归属、Space identity 和用户确认仍由 MyAgents 执行。

## 网络代理

MyAgents 支持系统/自定义代理和按 Provider 范围应用。Provider 请求、远程 MCP、Plugin 安装、外部 Runtime、Cloud Space 可能使用不同的代理路径，不应只凭一个“proxy=true”结论混为一谈。

本地 Sidecar 通信会绕过代理。出现 localhost 502、终端能访问但 Runtime 不行、某个 Provider 不跟随代理时，应进入 support 按链路诊断。

## 语言、平台与版本

- UI 可以跟随系统语言或选择支持的 locale；主窗口、托盘和浮窗应保持一致。
- macOS、Windows、Linux 的可用功能和系统集成可能不同；当前 UI 和版本说明是可用性的最终用户入口。
- MyAgents 自带 Node.js 和必要 Runtime 资源，普通用户不应为了修 Sidecar 被要求安装系统 Node。
- 桌面 App 更新与 Managed Codex Runtime 更新是两个生命周期；后者下载时不会主动中断当前已验证 Session。

## 何时只是使用问题，何时进入 support

属于使用指导：

- 不知道功能入口或概念区别
- 功能默认关闭，需要说明实验室开关
- 配置刚改变，需要等待正常生效边界
- 当前场景本来就不支持某项能力

应进入 support：

- 已满足前置条件且按正确步骤操作，仍稳定失败
- UI 显示状态与 CLI/实际行为冲突
- 同一身份在不同入口出现不可解释的状态分叉
- 应用崩溃、白屏、Sidecar 循环重启或数据明显错位
- 需要从日志和现场状态判断配置、环境还是产品缺陷
