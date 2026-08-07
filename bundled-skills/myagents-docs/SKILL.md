---
name: myagents-docs
description: >-
  MyAgents 产品使用知识库与用户可见行为说明。用户或 Agent 只要需要了解 MyAgents 是什么、能做什么、某项功能怎么用、
  功能入口或前置条件、功能之间的区别与关系、正确情况下应该出现什么结果、有哪些限制或常见误解，就使用这个 skill；
  也适用于在任意工作区规划怎样借助 MyAgents 的 Workspace、Session、Task、Goal、Provider、Runtime、MCP、Skill、Agent Channel、
  Cloud Space 等能力完成工作。它面向软件使用而非源码开发。需要查询或修改当前实例状态时再加载 `/myagents-cli`；
  已经出现报错、崩溃或实际行为偏离预期时，在内置小助理中转入 `/support`。
metadata:
  author: MyAgents
---

# MyAgents 产品使用知识库

这个 Skill 是 MyAgents 产品行为的知识入口。它帮助用户理解和使用软件，也帮助 Agent 建立正确的产品心智模型；它不是源码架构文档、命令参数大全或故障日志手册。

## 先判断用户需要什么

| 用户意图 | 处理方式 |
|---|---|
| 了解功能、比较概念、寻找入口、询问限制 | 读取本 Skill 对应 reference，直接解释并给出使用路径 |
| 设计一套 MyAgents 使用流程 | 读取涉及的 references，先说明各能力的职责，再组合工作流 |
| 希望你查询现场状态或代为操作 | 用本 Skill 确认语义；随后加载 `/myagents-cli`，以 CLI 的实时 help 和返回值为准 |
| 已按正确方式操作，但报错、崩溃、无响应或结果不符合预期 | 在内置小助理里加载 `/support`；先用本 Skill 确认预期，再用本地证据诊断 |
| 要修改 MyAgents 源码或评审实现架构 | 如果当前工作区是 MyAgents 仓库，改读仓库 `CLAUDE.md`、`specs/ARCHITECTURE.md` 与相关 `tech_docs/`；本 Skill 不是开发者文档 |

普通的“怎么用”不等于故障，不要一上来查日志。反过来，用户已经完成正确步骤却失败时，也不要只重复使用说明；应升级到诊断流程。

## 按问题域读取

一次只读最相关的 reference；跨域问题再追加。

| 用户在问什么 | 读取 |
|---|---|
| MyAgents 的定位、能力地图、主要入口、应该选哪类功能 | `references/product-overview.md` |
| Workspace、Agent、Session、Tab、历史、文件、搜索、终端、浏览器 | `references/workspaces-sessions-files.md` |
| Provider、Model、订阅、Runtime、权限模式、代理、Codex/Claude Code/Gemini | `references/models-providers-runtimes.md` |
| MCP、Skills、官方/自定义 CLI 工具、Claude Plugin、OpenClaw Plugin、读图与 Widget | `references/tools-skills-plugins.md` |
| 自定义 Agent、IM Channel、Telegram/钉钉/飞书/微信、heartbeat、长期记忆、小助理与悬浮窗 | `references/agents-channels.md` |
| Thought、Task、定时/Cron、Goal Mode、状态与执行关系 | `references/automation.md` |
| Team Space、Space Goal、Issue、Registered Agent、Delivery、共享 Skill | `references/cloud-space.md` |
| 实验室门控、生效时机、本地数据、安全、语言、更新与功能可用性 | `references/settings-safety.md` |

## 五组最容易混淆的概念

| 概念 | 一句话边界 |
|---|---|
| Workspace / Agent / Session / Tab | Workspace 是工作内容所在目录；Agent 是围绕工作区配置的 AI；Session 是持续的对话与执行身份；Tab 是桌面上承载 Session 的视图 |
| Provider / Model / Runtime | Provider 提供模型与认证；Model 是具体模型；Runtime 是实际驱动 Agent 回合的执行引擎 |
| Thought / Task / Cron / Goal | Thought 收集未成熟想法；Task 承载可追踪工作；Cron 是定时 Task 的兼容操作面；Goal 让当前 Session 围绕一个目标持续推进 |
| MCP / Skill / Plugin / CLI Tool | MCP 接入可调用工具；Skill 教 Agent 怎样完成流程；Plugin 扩展成组能力；CLI Tool 是可执行命令能力 |
| Session Goal / Space Goal | Session Goal 是本地当前会话的持续执行模式；Space Goal 是团队空间内组织 Issue 的层级，两者不是同一资源 |

## 回答产品问题的方法

1. 先回答用户眼前的问题，不从内部实现讲起。
2. 给出足够的产品心智模型：为什么用这个功能、与相邻功能有什么区别。
3. 说明前置条件、入口、典型步骤、成功标志和生效时机。
4. 只在能帮助用户判断时提及 Session、Runtime、Owner 等抽象，并翻译成用户能理解的语言。
5. 把稳定的产品契约和当前实例状态分开。功能是否存在、当前有哪些模型、某开关是否开启等现场值，使用 `/myagents-cli` 或 UI 查询，不凭静态文档猜。
6. 如果观察到的行为与这里的预期不一致，明确写出“预期 / 实际”的差异，再转诊断；不要未经证据直接宣布是产品 Bug。

## 每项功能应解释到什么程度

完整回答通常覆盖：

- 它解决什么用户问题
- 什么时候适合用，什么时候不适合
- 与相邻概念的关系
- 入口和典型使用流程
- 前置条件与功能门控
- 用户可观察到的成功状态
- 生效时机、限制和常见误解
- 需要现场操作时下一步该查询什么
- 哪些现象应转入 `/support`

不要在回答里倾倒完整百科。只展开与当前目标有关的部分。
