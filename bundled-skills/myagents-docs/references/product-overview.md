# 产品定位与能力地图

## MyAgents 是什么

MyAgents 是开源、桌面端、本地优先的个人 Agent 工作台。它把对话、真实工作区、文件、终端、浏览器、模型、工具、任务、长期记忆和多种交互入口放在同一套产品里。Chat 是入口之一，不是产品的全部。

它主要解决三类问题：

1. **让 AI 围绕真实工作持续工作**：每个 Agent 有工作区、文件、历史、工具和配置，不是一次性的空聊天。
2. **把零散对话沉淀成可追踪工作**：Thought、Task、定时调度和 Goal Mode 分别承载不同成熟度与时间尺度的工作。
3. **让用户决定模型与能力组合**：Provider、Runtime、MCP、Skills、Plugin、Channel 都可以按工作区和场景组合。

## 产品心智模型

```text
Workspace（真实文件与项目背景）
  └─ Agent（围绕工作区的模型、工具、权限与长期行为）
      ├─ Session（一次可持续恢复的对话/执行身份）
      │   └─ Tab / 悬浮窗 / IM 等交互入口
      ├─ Provider + Model + Runtime（用谁、跑哪个模型、由什么引擎执行）
      ├─ MCP + Skills + Plugins + CLI Tools（能调用什么、知道怎样做）
      └─ Thought / Task / Schedule / Goal（如何承载长期与自动化工作）

Cloud Space（可选的团队协作层）
  └─ Member / Goal / Issue / Registered Agent / Shared Skill
```

这张图描述产品抽象，不代表所有能力都在同一个进程或同一个页面里。

## 主要用户入口

### Launcher

用来选择或创建工作区、查看历史 Session、进入任务中心，并在还没打开 Chat 前准备工作。Launcher 不只是欢迎页，它是工作区与历史的入口。

### Chat

适合围绕当前工作区进行长对话、文件操作、工具调用和持续执行。支持多 Tab、历史恢复、模型与权限选择、`@` 文件、`/` Skills、内嵌终端和浏览器。

### 任务中心

把 Thought 对齐成 Task，安排一次性或周期执行，追踪状态、运行记录、文档和验收结果。适合不应只留在聊天历史里的工作。

### 设置

管理 Provider、MCP、Agent、Channel、Skills、插件、代理、实验功能、语言和应用行为。动态可用项以当前版本设置页和 CLI discovery 为准。

### AI 小助理

负责 MyAgents 功能答疑、代为配置、诊断本地问题和整理反馈。普通使用问题先查产品知识；实际异常再进入 support 诊断。

### 桌面宠物 / 悬浮窗

提供轻量桌面入口，可以绑定工作区并复用 MyAgents 的会话能力。它不是另一套独立产品状态；复杂工作仍可以回到主窗口继续。

### IM Agent / Channel

让 Agent 通过 Telegram、钉钉或社区插件 Channel 在桌面之外接收和回复消息，并延续对应工作区与 Session 的能力边界。

### Team Space（实验室）

提供团队成员、分层 Goal、Issue、共享 Skill 与 Registered Agent 协作。它是云端协作层，不是本地 Session 或 Runtime 的替代品。

## 怎样选择承载方式

| 用户目标 | 优先能力 |
|---|---|
| 临时讨论、立即处理 | Chat Session |
| 记下尚未成熟的念头 | Thought |
| 有明确目标、需要状态和验收 | Task |
| 到时间自动执行 | 带 schedule 的 Task；用户仍可使用 Cron 入口管理 |
| 当前会话持续推进直到完成 | Goal Mode |
| 从 IM 与 Agent 互动 | Agent Channel |
| 团队分配和跟踪工作 | Team Space Issue + Registered Agent |
| 接入外部能力 | MCP、Skill、Plugin 或 CLI Tool，按能力形态选择 |

## 本地优先意味着什么

- 工作区文件、会话、任务、配置和多数生成产物默认保存在本机。
- Cloud Space、远程 Provider、远程 MCP、IM 平台等能力会按功能需要访问外部服务。
- 本地优先不等于所有功能离线可用；模型请求、OAuth、插件安装和云端协作仍需要网络。
- 用户数据目录是应用内部状态，不应通过手工改 JSON 来替代产品 API 或 CLI。

## 常见误解

- “关掉 Tab 就一定终止所有后台工作”：不一定。Task、Goal 或 Channel 可能仍拥有该 Session 的执行需求。
- “Agent 就是一段 system prompt”：不完整。Agent 还关联工作区、模型、Runtime、权限、工具、Channel 和长期行为。
- “所有自动化都是 Cron”：0.3.0 起 Task 是持久任务与调度权威；Cron 是兼容的用户操作名称。
- “换了模型就是换 Runtime”：不是。Provider/Model 与 Runtime 是两个维度，订阅型 Provider 还可能选择受管 Runtime。
- “Cloud Space 会把本地工作区自动上传”：不是。Space 只通过明确的 Issue、附件、Skill 和 Registered Agent 流程交换被选择的数据。
