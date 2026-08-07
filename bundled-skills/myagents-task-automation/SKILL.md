---
name: myagents-task-automation
description: >-
  让 Agent 建立 MyAgents Task 自动化的完整产品心智模型，并创建、验证和治理所有“以后再做”的工作：理解 Task 解决什么问题、与立即执行/Thought/Goal 的边界，以及何时到点直接唤醒 AI（always）、何时先用本地 command Detector 判断是否值得唤醒。用户提到定时、稍后、某个时间点、每天/每周、每隔一段时间、Cron、循环检查、持续关注/监控/盯着、等某件事发生后继续、满足条件才提醒或处理时，都应主动使用本 Skill，即使用户没有说 Task、Cron、Sensor 或感知器。普通立即执行任务、仅记录 Thought、明确要求 Goal Mode 的持续多轮工作不使用本 Skill。
metadata:
  author: MyAgents
---

# MyAgents 定时与自动化 Task

## 先建立 Task 产品心智模型

Task 是 MyAgents 对“需要在当前对话之后继续存在、在未来被执行和追踪的工作”的统一承载。它不是一条临时提醒，也不是一段 Cron 表达式；它把用户的行动目标保存成有身份、有状态、有执行记录、可暂停和可恢复的工作项，并在合适的时机把工作交给 AI。

一个自动化 Task 由五个彼此独立的决策组成：

```text
Task = action（AI 被激活后做什么，权威内容在 task.md）
     + schedule（何时产生一次执行机会）
     + activation（机会出现时是否真的唤醒 AI）
     + Session routing（在哪段上下文中工作）
     + end conditions（何时不再继续）
```

schedule 只负责产生执行机会，不等于 AI 已经运行；activation 再决定这个机会是直接进入 AI Turn，还是先由程序筛选。这样，普通定时任务与“持续检查、命中才处理”共享同一个 Task 生命周期，而不需要两套产品实体。

Task 解决四类问题：

- **意图持久化**：工作不依赖当前聊天回合继续存在，之后仍可查到目标、配置和状态。
- **未来触发**：支持指定时间一次、固定间隔和 Cron 墙钟计划。
- **按需唤醒**：既能每次到点都运行 AI，也能先做低成本确定性检查，避免无意义的模型调用。
- **治理与追踪**：统一管理 Session 去向、运行历史、暂停/恢复、结束条件和失败健康状态。

### 与相邻能力的边界

| 用户真正需要的是什么 | 正确承载 |
|----------------------|----------|
| 现在就在当前回合完成一件事 | 直接执行，不创建 Task |
| 先记下一条尚未成熟的想法，暂时不执行 | Thought |
| 一项已经明确、需要未来触发或持续追踪的工作 | Task |
| 当前 Session 围绕同一目标连续多轮自主推进 | Goal Mode，不用循环 Task 模拟 |
| App 完全退出后仍必须由 OS 常驻执行 | 不属于 MyAgents Task；不要伪装成已部署成功 |

Cron 只是已发布的兼容命令面，不是另一种资源；Sensor 也不是独立产品实体。`TaskStore` 是唯一权威，新 Agent 工作流统一使用 `myagents task ...`。

### 生命周期应怎样理解

创建 Task 只是把它持久化为 `Todo`；首次 `run` 后，时间型 Task 进入 `Running`，表示 scheduler 已启用，不表示 AI 此刻正在执行。每个 tick 经 activation 后才可能产生 AI Turn。首次 tick 由 schedule 决定：固定 interval 默认在 `run` 后约 2 秒产生第一次机会（要延后就显式设置 `--startAt`），Cron 等到下一个墙钟点，scheduled 等到 `dispatchAt`。`stop` 暂停未来调度并停止活跃执行；`start` 按保留的 schedule anchor 恢复，anchor 已过期时下一次机会可能接近当前时间，应以回执里的 `nextExecutionAt` 为准。`rerun` 重新派发终态 Task；`run-now` 是一次绕过 Detector 的人工执行，不改变 schedule 或 checkpoint。

MyAgents App 必须在线才会产生 tick 或执行检查。Task 可以在 App 后台驻留时运行，但完全退出或 OS 休眠期间不会运行，也不会逐个补跑错过的 tick。

正常创建和列表会自动继承当前 MyAgents workspace，不需要先查 ID。只有明确跨 workspace 操作时才同时传 `--workspaceId` / `--workspacePath`；若要诊断当前身份，使用 `myagents agent current --json`。命令语法有疑问时运行 `myagents task readme` 获取当前紧凑契约；精确参数以对应命令的 leaf help 为准。

## 选择激活方式

| 方式 | 每个 schedule tick 的效果 | 适用情况 | Task 配置 |
|------|---------------------------|----------|-----------|
| `always` | 直接派发普通 Task AI Turn；没有前置程序判断 | 每次到点都值得让 AI 行动，例如提醒、日报、定期总结；或是否行动只能由模型理解 | 省略 `--trigger-file` |
| `command Detector` | MyAgents harness 先运行本地命令；`quiet` 不创建 Session、不唤醒 AI，`activate` 才把事件证据交给普通 Task AI Turn | 外部条件能由廉价、确定的程序判断，而且大多数检查应该保持静默 | 验证后传 `--trigger-file` |

默认选择 `always`。只有“程序可以可靠判断是否命中”“运行程序明显比唤醒 AI 更便宜”“未命中时不需要 AI 参与”同时成立，才使用 `command Detector`。不要创建一个脚本，再让脚本无条件输出 `activate`；那与 `always` 等价，只增加故障点。

一旦选择 `command Detector`，在编写脚本或 Trigger 前完整读取 `references/command-detector.md`。该 reference 是命令结构、stdin/stdout 协议、checkpoint、fixture 测试、安全边界和 failure 行为的详细契约；普通 `always` Task 不需要加载它。

## 决策顺序

1. **行动**：命中时 AI 具体做什么。把它写进 `task.md`；Detector 的输出只能提供事件证据，不能代替行动目标。
2. **时间**：选择未来某时执行一次、固定间隔或 Cron 表达式。墙钟时间默认使用本机 IANA 时区；用户指定其他时区时显式保存。
3. **激活策略**：按上表选择 `always` 或 `command Detector`。只向用户澄清实际效果，不要求用户理解这两个内部名称。
4. **Session**：延续当前/已有上下文用 `single-session`；每次需要隔离上下文用 `new-session`。
5. **结束**：一次性任务自然结束；循环任务根据用户意图选择最大 AI 执行次数、截止时间、允许 AI 主动退出，或持续到用户暂停。Detector 的 quiet 检查不计入 AI 执行次数。

只澄清会改变这些选择的缺失信息。信息齐全后连续完成准备、验证、创建、回读和启动，不逐步索要批准；删除仍遵守 `/myagents-cli` 的确认规则。

## `always`：到点直接激活

先用标准文件工具写 `task-action.md`，再创建 Task。长文本不要拼进 shell command。

未来某时执行一次：

```bash
myagents task create-direct --name "send release reminder" \
  --taskMdFile task-action.md --executionMode scheduled \
  --dispatchAt 2026-08-04T09:00:00+08:00 \
  --runMode single-session --preselectedSessionId current --json
```

周期执行：

```bash
myagents task create-direct --name "daily report" \
  --taskMdFile task-action.md --executionMode recurring \
  --cronExpression "0 9 * * *" --cronTimezone Asia/Shanghai \
  --runMode new-session --json
```

固定间隔使用 `--intervalMinutes <n>`（最小 5 分钟）。默认首次 tick 在 `run` 后约 2 秒；如果用户希望“从一个 interval 之后才第一次检查”，同时传带时区的 `--startAt <ISO-8601>`。普通 Task 省略 `--trigger-file`，其有效激活策略就是 `always`。

## `command Detector`：命中才激活

只有在上面的三个条件都成立后才进入本节。完整读取 `references/command-detector.md`，再编写脚本、隔离测试输入并部署；不要凭本文件的摘要猜协议。

条件 Task 与普通 Task 只有一个创建差异：验证通过后在 `create-direct` 加入生产用 `--trigger-file`。例如：

```bash
myagents task create-direct --name "watch CI failure" \
  --taskMdFile task-action.md --executionMode recurring --intervalMinutes 5 \
  --runMode single-session --preselectedSessionId current \
  --maxExecutions 1 --trigger-file trigger.production.json --json
```

这里的 `--maxExecutions 1` 表示首次 activate 并完成 AI Turn 后结束；之前任意数量的 quiet 检查不消耗次数。需要持续观察后续事件时省略它。

## 结束条件

创建 ordinary scheduled/recurring Task 时可组合：

```text
--deadline <ISO-8601-with-offset>  到达该时刻后不再开始新 AI Turn
--maxExecutions <positive-int>     限制已结算的 AI 执行次数
--aiCanExit true|false             是否允许任务内 AI 主动结束
```

当 `--aiCanExit true` 且行动已经完成、继续运行无意义时，Task 内的 AI 可以调用：

```bash
myagents task exit --reason "goal achieved: ..."
```

它不是临时失败的逃生按钮。瞬时错误应按 `task.md` 的处理策略重试或报告；不要擅自结束用户仍需要的周期任务。

## 创建后的确定性流程

创建命令始终加 `--json`，从结果解析权威 `taskId`，然后回读并启用：

```bash
myagents task get <taskId> --json
myagents task run <taskId> --json
```

创建、`run`、`start`、`stop`、`rerun` 的 JSON 回执都应包含权威最新状态和 `nextExecutionAt`，因此正常流程不需要为了确认 schedule 再额外 `get`；需要完整配置、文档路径、Session 历史或 Detector health 时再用 `task get`。首次从 Todo 启用用 `task run`；暂停后恢复用 `task start`；终态重新派发用 `task rerun`。不要通过目录时间或猜测名称寻找刚创建的 Task。

## 治理

```bash
myagents task get <taskId> --json       # 权威配置、状态、Detector health/checkpoint
myagents task runs <taskId> --limit 5   # 最近 AI 执行历史
myagents task check-now <taskId>        # 真实 Detector 检查；提交状态，命中会激活 AI
myagents task run-now <taskId>          # 绕过 Detector，直接执行 AI
myagents task stop <taskId>             # 暂停 schedule，保留 checkpoint
myagents task start <taskId>            # 按原 anchor 恢复；查看回执 nextExecutionAt
myagents task reset-checkpoint <taskId> # 只清平台 checkpoint
myagents task update <taskId> --clear-trigger # 改回 always
myagents task archive <taskId>           # 用户专属的长期可恢复归档
myagents task delete <taskId>            # 确认后不可恢复地删除；不删除工作区脚本
```

`check-now` 会提交真实 MyAgents 状态；部署前不提交 MyAgents 状态的验证使用 `trigger test`（脚本自身副作用仍真实发生）。`run-now` 不改变 schedule anchor 或 Detector checkpoint。

归档和删除不是同一种“软删除”：`archive` 是长期可恢复的产品状态；`delete` 会立即停止调度、移除平台 Trigger state/pending activation，并从正常产品使用中不可恢复地移除 Task。TaskStore 只保留防止旧 Cron 重新迁移所需的内部 tombstone 与审计；没有 30 天恢复承诺，也没有 undelete 命令。两者都不会越权清理工作区脚本、脚本数据库或外部状态。

## 给用户的部署回执

部署成功后一次说明：

- Task 名称与 ID
- 何时执行或检查，包括时区
- 到点直接激活，还是满足什么程序条件才激活
- 激活后的 AI 动作
- 目标 Session 策略
- 结束条件或“持续到手动停止”
- App 在线限制和 Task Center 治理入口

quiet 检查保持静默。activate 后由目标 Session 中的 AI 正常交付工作结果；Detector failure 只进入 Task health/backoff，不伪装成业务判断，也不再创建一个 AI Task 去监控 Detector。
