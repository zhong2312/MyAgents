# MyAgents — Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源（AGPL-3.0-only）并提供单独商业授权；使用 Conventional Commits；不得提交密钥、令牌或用户隐私数据。

## 这份自动加载文档的职责

本文件只保留每类任务都值得占用注意力的项目心智模型、决策顺序和文档路由，不收录可由代码、lint、测试、`package.json` 或局部文档直接发现的完整规则表。

权威性按用途区分：

1. **当前事实**（API、版本、脚本、文件名、可执行约束）以代码、类型、测试、lint 配置和 `package.json` 为准。
2. **Owner、边界与数据流**以 `specs/ARCHITECTURE.md` 为准。
3. **模块的不变量、事故根因和 helper 用法**以对应 `specs/tech_docs/` 为准。
4. PRD、版本历史和 issue 只解释历史动机，不能覆盖现行实现与规范。

若文档与代码冲突，不要任选一个继续：先用实现、测试和 git 历史确认现状，再修正文档。不要因为一次局部事故就把新规则追加到本文件；只有“跨任务高频、无法就近推断、违反后代价高”的知识才应常驻。

## 工作方法

1. 先判断任务影响的 owner、进程边界和权威数据源，再按下表读取**匹配的**文档；不要默认加载整个文档树。
2. 用 `rg` 搜索同类实现、调用方、测试和已有 helper，沿既有路径扩展，不为单点需求建立第二套抽象。
3. 对接外部 SDK / 插件时先核对安装版本的源码与类型定义；涉及 Claude Agent SDK 时至少检查 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`、`sdk-tools.d.ts` 和官方文档，禁止凭记忆猜接口。
4. 先修 owner / scope 的错位，再考虑 cache、guard、flag、retry、wrapper 等机制。目标是极致 UX、正确架构和更少的系统概念，而不是最小 diff。
5. 若确实需要新通信模式、新状态 owner 或新进程类型，先与用户讨论架构方案。

## 项目地图

| 区域 | 技术与职责 |
|------|------------|
| `src/renderer/` | React 19 + TypeScript + Vite + TailwindCSS；桌面 WebView UI |
| `src/server/` | Node.js v24 Sidecar；Claude Agent SDK；每 Session 独立实例 |
| `src/server/plugin-bridge/` | 独立 Node 进程；OpenClaw Plugin Bridge |
| `src/cli/` | `myagents` CLI，同步到 `~/.myagents/bin/` |
| `src/shared/` | renderer / server 共用的纯类型与逻辑 |
| `src-tauri/` | Tauri v2 Rust 壳、进程与持久化 owner、HTTP/SSE 代理 |
| `bundled-agents/myagents_helper/` | 内置 MA 小助理 |
| `specs/` | 当前架构、设计规范、模块技术文档与构建指南 |

Sidecar、Plugin Bridge、MCP Server 与 CLI 共用应用内置的单一 Node.js v24，不依赖用户系统安装的 Node。

## 必须常驻的架构心智模型

### Owner 与 authority 优先

任何状态或资源只能有一个明确 owner 和一个权威来源。修复前先回答“谁创建、谁持久化、谁释放、并发时谁裁决”；不要用同步副本、额外 effect 或新 flag 掩盖 owner 错位。

### Session、Sidecar 与 Tab

- `Session : Sidecar = 1 : 1`。Tab / Companion / Task / Goal / BackgroundCompletion / Agent 只是共享该 Sidecar 的 owner token；全部释放后才停止进程。
- 每个 Chat Tab 独立隔离。Tab 内请求使用 `useTabState()` 提供的 `apiGet` / `apiPost`，不能误发到 Global Sidecar。
- `messageGenerator()` 是常驻 generator。中止必须走 `abortPersistentSession()`；配置变更先保存 resume session，再 abort。Pre-warm 创建的是后续直接复用的真实 session，不能假设“非 pre-warm”分支总会执行。
- 已有 Session 保持自己的运行时与 MCP authority。Chat mount 的 push / adopt 只能服从 `ensureSessionSidecar` 锁内返回的 `result.isNew`，不能用事前端口探测猜测。

### 通信分为控制面和大载荷数据面

- Renderer 与 Sidecar 的控制面 HTTP / SSE 必须经 Rust：`invoke → reqwest → Sidecar`；连接 localhost 的 Rust client 使用 `crate::local_http`。
- 仅明确登记的大载荷数据面端点（当前为 `/refs/:id`、`/attachment/*`）允许 Renderer 原生 fetch；它们必须同时满足 CORS、CSP、大小限制和路径安全约束。不要把这个例外扩展到普通 API。
- 新增 SSE JSON 事件必须同时进入 renderer 事件白名单，否则前端会静默丢弃。

### Runtime 分流只有一个入口

Builtin SDK 与 Claude Code / Codex / Gemini 等外部 Runtime 的 session 操作统一经过 `src/server/session-engine/` facade，由 selector 选择 adapter。Route handler 不得自行写 builtin / external 分支；“等待 idle”也不等于 turn 成功，terminal 必须读取对应 adapter 的真实成功状态。

### 持久化 authority

- 新定时自动化以 Rust `TaskStore` 为唯一权威；Cron surface 只是兼容入口，不写旧 `cron_tasks.json`。
- `config.json` 是配置写入权威。写盘前重新读取磁盘并在锁内合并，不能拿可能过期的 React state 覆盖；写盘后再刷新前端状态。
- 工作区文件 IO 属于 OS / Tauri 层，统一走 `cmd_workspace_*` 与 `useWorkspaceFileService(workspacePath)`；不要为了读写工作区启动或依赖 Sidecar。

### 可执行护栏优先于重复提示

`eslint.config.js`、`.dependency-cruiser.cjs`、`src-tauri/clippy.toml` 负责能静态判定的边界，其诊断信息应同时说明故障模式和正确路径。遇到违规应理解并修复原因，不能 suppress；完整的人类可读规范集中在 `specs/tech_docs/pit_of_success.md`，不在本文件镜像一份易漂移的表格。

## 按任务加载文档

满足以下任一条件时先读 `specs/ARCHITECTURE.md`：设计 / 评估 / 规划 / 重构；跨模块或跨进程；修改 Sidecar / Session / owner / pre-warm；新增通信模式、Runtime、MCP server 或 Channel；无法判断功能应落在哪条现有路径。先读“项目定位 / 全景架构图 / 核心抽象”，再读命中的模块章节；只有真正的全系统问题才展开全文。

其余任务只读命中的模块文档和相邻代码。大文档先用目录或 `rg` 定位相关章节。

| 任务范围 | 必读文档 |
|----------|----------|
| Pit-of-Success helper、跨语言边界、测试分层 | `specs/tech_docs/pit_of_success.md` |
| Sidecar 冷启动 / pre-warm 性能 | `specs/tech_docs/sidecar_cold_start.md` |
| Session ID、状态同步、恢复、配置归置 | `specs/tech_docs/session_architecture.md` |
| Claude Code / Codex / Gemini Runtime | `specs/tech_docs/multi_agent_runtime.md` |
| Task / Thought / Goal / Cron provider routing | `specs/tech_docs/task_center.md`、`specs/tech_docs/task_provider_routing.md` |
| Cloud Space / Space Issue / registered agent | `specs/tech_docs/space_cloud.md`；改云 API、鉴权、数据或 quota 时再读 `../MyAgents_space/specs/ARCHITECTURE.md` |
| Space IssueDelivery / registered-agent prompt 协议 | `specs/tech_docs/space_issue_delivery_protocol.md`、`specs/tech_docs/space_cloud.md`、`specs/tech_docs/system_reminder_protocol.md` |
| IM Bot / Telegram / Dingtalk / 飞书 | `specs/tech_docs/im_integration_architecture.md` |
| Plugin Bridge / OpenClaw / SDK shim | `specs/tech_docs/plugin_bridge_architecture.md` |
| Claude Plugin 加载与安装 | `specs/tech_docs/plugin_loading.md` |
| SDK 权限 hook / 自定义 Tool | `specs/tech_docs/sdk_canUseTool_guide.md`、`specs/tech_docs/sdk_custom_tools_guide.md` |
| `myagents` CLI、Admin API、内置小助理、system skill | `specs/tech_docs/cli_architecture.md` |
| 前端 UI、布局、交互、字号 | `specs/DESIGN.md` 的相关章节；只在主题工作时追加 `specs/tech_docs/theme_system.md` |
| React state / effect 稳定性 | `specs/tech_docs/react_stability_rules.md` |
| Tool Attachment / 富媒体 / 外部 URL | `specs/tech_docs/tool_attachment_pipeline.md` |
| 工作区路径、Windows 进程 / CSP / WebView | `specs/tech_docs/windows_platform.md`；按问题追加 `specs/tech_docs/windows_ai_review_traps.md` 或 `specs/tech_docs/windows_cross_platform_review.md` |
| 内置 Node / 三方 Provider / 代理 | `specs/tech_docs/bundled_node.md`、`specs/tech_docs/third_party_providers.md`、`specs/tech_docs/proxy_config.md` 中命中的文档 |
| 搜索 / i18n / 埋点 / 日志 | 对应 `specs/tech_docs/search_architecture.md`、`specs/tech_docs/i18n_architecture.md`、`specs/tech_docs/analytics_design.md`、`specs/tech_docs/unified_logging.md` |
| 自动更新、构建、发布 | `specs/tech_docs/auto_update.md` 与 `specs/guides/` 下对应平台文档 |

## 验证与维护

- 修改后运行与影响面匹配的最小确定性验证；命令与测试池以 `package.json`、`vitest.config.ts` 和 Rust workspace 为准。Bug 修复应新增能复现故障的回归测试；纯文档不要求代码测试。
- 默认测试不得依赖真实网络、真实密钥或真实用户目录；真实 Provider / SDK smoke 只能进入 credentialed 测试池并显式运行。
- 修改 lint / helper 时，优先把不变量固化为测试或静态检查，并在局部规范解释 WHY；只有当跨任务心智模型改变时才更新本文件。
- 用户报告运行问题时主动读取 `~/.myagents/logs/unified-{本地日期}.log`；日志字段与排查路径见 `specs/tech_docs/unified_logging.md`。

## Git 与共享工作区

- 工作区可能有用户或其它 session 的未提交改动。开始与交付前检查 `git status`；只修改任务需要的文件，逐文件确认 diff，不覆盖、回滚或清理别人的改动。
- 禁止用 `git add -A`、`git add .` 或 `git add -f` 扩大提交范围；提交时显式列文件。除非用户明确要求，不把 ignored 的 `specs/prd/`、`specs/research/` 草稿纳入 Git。
- 不在 `main` 直接提交。合并、发布、打 tag 或其它外部动作需要用户明确授权。
- Commit 必须同时有 Conventional Commits subject 和解释“为什么 / 关键取舍”的非空 body，例如 `git commit -m "<subject>" -m "<reason>"`。
- Rust 工具链版本以根目录 `rust-toolchain.toml` 为唯一权威；不要用浮动工具链制造无关格式化 diff。
