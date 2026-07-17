---
name: support
description: >-
  MyAgents 本地问题诊断、恢复与反馈升级流程。用户描述报错、崩溃、无响应、配置后仍不可用、状态或结果不符合预期、
  Task/Goal/Channel/Provider/Runtime/MCP/Plugin/附件/Space 等功能异常，或者前端“小助理诊断/问题反馈”注入诊断上下文时使用。
  先用 `/myagents-docs` 确认正确产品预期，再以本地状态、CLI、日志和必要 probe 分类、修复、验证；确认产品缺陷或功能建议后，
  在用户确认下形成并提交脱敏 Issue。普通“是什么/怎么用/入口在哪”不使用本 skill，直接使用 `/myagents-docs`。
---

# MyAgents Support

Support 的职责是解释“为什么实际行为没有符合正确预期”，并把问题推进到恢复或可执行的产品反馈。它不拥有产品百科；产品行为基线来自 `/myagents-docs`，当前实例状态来自 CLI/UI，发生过程来自本地证据。

## 总原则

1. 先理解用户目标，再比较预期与实际；不要把不会用直接升级成事故。
2. 先被动证据，后 active probe；先局部恢复，后破坏性重置。
3. 配置修复优先走 `/myagents-cli`，不直接改 `config.json` 或内部 store。
4. 不读取 credential store。状态通过脱敏 CLI/API 获取，日志和报告中的 Key、Token、Secret、Webhook query、home 用户名都要脱敏。
5. 修复后必须重走触发原问题的路径验证，不能只跑一个总状态命令。
6. 区分已确认、根因假设和已排除；证据不足时不装作确定。

## Step 0 - 建立正确预期

先写清四件事：

- 用户想完成什么
- 用户实际做了什么
- 正确情况下应该看到什么
- 现在实际看到什么

涉及产品语义时，加载 `/myagents-docs` 的相关 reference，确认前置条件、作用域、生效时机、成功标志和限制。若发现只是功能理解或正常门控，回到产品使用指导，不继续扫日志。

白屏、明确 crash、数据错位等无需争议的异常可以直接进入取证，但报告仍要补齐 expected/actual。

## Step 1 - 建立诊断信封

只收集与问题有关的最小现场：

- MyAgents 版本、OS、问题发生时间窗口
- 触发入口：Chat、Launcher、悬浮窗、Task、Goal、IM、Space 等
- Workspace、Session ID、Task/Goal/Issue ID（如适用）
- Provider、Model、Runtime、`runtimeSource`（如适用）
- 是否稳定复现、影响一个对象还是所有对象

常用只读基线：

```bash
myagents status --json
myagents version
rg '\[boot\]' ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -5
```

不必每次机械运行全部命令。前端已经注入 Terminal Reason / Runtime Diagnostics 时先利用它，再补缺失字段。某条命令或日志不存在，记录原因并继续，不要卡死。

## Step 2 - 选择诊断域

一次先读最相关的 reference；只有证据跨域时才追加。

| 主诉 | 读取 |
|---|---|
| Codex/Gemini/Claude Code 不工作、终端能用但 MyAgents 不行、runtime/model/permission 异常 | `references/runtime.md` |
| Provider 登录/验证/模型失败，MCP 启动、OAuth、握手或工具列表异常 | `references/provider-mcp.md` |
| Telegram/钉钉/飞书/微信/QQ Agent 不在线、不收发消息，OpenClaw Plugin 异常 | `references/agent-channel-plugin.md` |
| Task/定时/Cron 未执行或状态异常，Goal 不续跑/无法暂停/错误终态，Thought/Session Inbox 异常 | `references/automation.md` |
| Team Space 登录、Goal/Issue、Registered Agent、Delivery、claim、附件或 quota 异常 | `references/cloud-space.md` |
| 图片/音频/PDF 等工具产物生成但不显示，IM 媒体未发出 | `references/attachments.md` |
| 工作区文件树、搜索、预览、@ 文件、拖拽、CRUD、watcher 异常 | `references/workspace-files.md` |
| AI 不回复、Sidecar 重启、pre-warm、历史恢复、回溯/分叉、Session 状态异常 | `references/session-sidecar.md` |
| 网络/代理、Provider 可达性、npm 拉包、终端与 Runtime env 差异 | `references/proxy-env.md` |
| 白屏、整页渲染错误、悬浮窗/桌宠打不开或卡在连接 | `references/frontend-render.md` |
| 功能入口不存在、实验室开关、CLI 工具或 Runtime/Space 入口看不到 | `references/feature-gates.md` |

## Step 3 - 被动证据与 active probe

优先被动读取：

- `status`、`version`
- 对应对象的 `list/show/get/view --json`
- 当前登录/验证/运行状态的脱敏接口
- 最近时间窗口内的统一日志

active probe 会连接外部服务、启动进程、消耗请求、弹浏览器或实际执行任务。先区分两类授权：

- Provider verify、MCP test、Runtime diagnose：在用户已经要求诊断对应问题时，可以在说明目的和影响后执行。
- OAuth start、Task/Cron run-now、Channel 登录、Plugin/Skill 安装，以及任何写操作或 Cloud/IM/GitHub mutation：会改变状态、启动真实工作或影响外部系统，必须先展示具体对象与影响，并取得用户明确确认。

写命令只有在精确 leaf help 明确支持时才使用 `--dry-run`。不支持 preview 的命令不能通过添加无效 flag 假装已经预览。

统一日志不是凭据安全接口。禁止用裸 `rg` / `grep` 把完整日志行直接送入模型上下文；所有日志命令都必须先通过 `.claude/skills/support/scripts/redact-log-output.mjs`，让 URL、认证字段、常见 Token、长编码串和 home 用户名在工具输出前被替换。第三方 Plugin/npm 输出默认只保留时间、组件、错误类别和已脱敏消息；确需扩大上下文时仍使用同一过滤器并缩小时间窗口。

## Step 4 - 建立时间线和故障边界

按问题入口还原实际链路，而不是套用一张“所有功能都经过 Sidecar”的总图：

```text
用户动作 / Scheduler / Channel / Cloud Delivery
  → 对应产品 owner 接收
  → Session Runtime 或本地 Rust 能力执行
  → 持久状态 / UI / Channel / Cloud 返回结果
```

先按时间、Workspace、Session/Task/Goal/Issue ID、Runtime/Provider 收窄，再看上下游。常见主线关键词：

```bash
rg -n "ERROR|WARN|auth error|401|403|429|terminal_reason|AppErrorBoundary|external-session|runtime_diagnostics|runtimeSource|managed-codex|codex-sub|anthropic-sub|grok-auth|xai-sub|task-scheduler|\[task\]|\[Goal\]|\[space\]|bridge|tool-attachment|cmd_workspace" ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -200
```

`[CronTask]`、`cron_runs` 等旧名字仍可能出现在兼容路径，但不能再把它们当作 Task Scheduler 的唯一主线。

## Step 5 - 分类

| 类型 | 判断依据 | 行动 |
|---|---|---|
| 使用理解 | 行为符合 docs，用户误解入口、作用域、生效时机或限制 | 解释产品行为，必要时用 CLI 代为完成 |
| 配置错误 | 当前配置与用户目标或合法值域明确不符 | 用 `/myagents-cli` 修复并同路径验证 |
| 环境问题 | 网络、代理、PATH、Runtime 安装、registry、OAuth 外部状态异常 | 给出具体恢复，必要时执行已说明的 probe |
| 实验门控 | 功能默认关闭或需要人工开启 | 解释设置入口，不绕过可见门控 |
| 临时运行异常 | 重启窗口、瞬时网络/限流或可恢复进程状态，重试后恢复 | 说明证据和恢复结果，不夸大为产品 Bug |
| 产品 Bug | 前置条件满足且稳定偏离产品契约，配置/环境无法解释 | 明确影响、证据和 workaround，进入 Issue 升级 |
| 证据不足 | 问题真实但无法在当前证据下归类 | 收集最小复现；仍不足则以 unknown defect 报告，不伪造根因 |

## Step 6 - 修复与验证

修复前确认对象、预期变化和副作用。删除、覆盖、重置登录、撤销 OAuth、移除 Channel/Plugin/Skill、云端 mutation 必须得到用户确认。

修复后：

1. 读取权威状态，确认写入真的落地。
2. 重走用户原来的入口和步骤。
3. 对比原始 expected/actual，确认症状消失且没有产生相邻回归。
4. 告诉用户实际改了什么、现在状态、是否需要新消息/新 Session 生效。

产品二进制 Bug 无法在安装实例中根治时，不通过反复清缓存、删历史或重置账号掩盖；给出最小风险 workaround 并升级。

## Step 7 - Issue 或建议升级

确认产品 Bug 或用户希望提交功能建议后：

1. 用 `/myagents-docs` 检查它是否已有能力、正常限制或已知使用路径。
2. 生成下面的脱敏标题与报告，路径优先写相对路径或 `<HOME>`，先展示给用户。
3. 取得用户允许向 GitHub 发送脱敏关键词的明确确认后，再搜索 `hAcKlyc/MyAgents` 的相似 open Issue；没有能力或用户不授权就明确未搜索。
4. 根据搜索结果更新报告并再次展示。只有用户明确确认提交后，才使用可用的 GitHub connector、`gh issue create` 或 Issue 页面提交。
5. 成功后返回链接；不能或不应提交时交付可直接粘贴的 Markdown。

```markdown
## 功能与用户目标
...

## 环境与影响范围
- MyAgents version / OS：...
- 入口 / Workspace / Runtime：...
- 影响一个对象还是全部对象：...

## 正确预期
...

## 实际结果
...

## 最小复现
1. ...
2. ...

## 关键证据（已脱敏）
...

## 分析
- 已确认：...
- 根因假设：...
- 已排除：...

## 临时绕过与严重程度
...
```

功能建议应强调用户目标、当前阻力和期望结果，不把未经评估的具体实现方案写成唯一答案。

## 安全边界

- 不读取 `~/.myagents/credentials/`、Space token、Claude/Codex/Gemini credential home 或系统 Keychain。
- 不要求用户把 API Key/Token 发进持久对话；引导使用产品受保护输入入口。
- 不直接编辑 Session、Project、Task、Goal、Space 内部 store。
- 不把完整日志、用户文件内容、大 base64 或可识别个人路径放进 Issue。
- 未经确认不提交 GitHub Issue、不发 Cloud/IM 消息、不改变外部账号状态。
