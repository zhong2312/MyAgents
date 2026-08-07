# Thought、Task、定时自动化与 Goal Mode

## 四种承载方式

| 概念 | 最适合的工作 | 是否有独立持久状态 | 是否自动继续/触发 |
|---|---|---|---|
| Thought | 先记下还不成熟的想法 | 是 | 否 |
| Task | 已明确、需要追踪、执行和验收的工作 | 是 | 可手动或按 schedule 触发 |
| Cron | 用户熟悉的定时任务管理名称；底层仍是 Task | 复用 Task | 按 At/Every/Cron schedule |
| Goal Mode | 当前 Session 围绕一个目标连续多轮推进 | Session Goal 状态 | 每轮完成后自动继续，直到暂停或终态 |

## Thought

Thought 适合低成本收集灵感、待办和问题，不要求立刻定义完整验收标准。用户可以给它加标签、搜索，之后再进入 AI 对齐流程，把成熟内容物化为 Task。

Thought 不是会自动执行的 Task。仅仅记录 Thought 不会启动 Agent 回合。

## Task Center

Task 是任务身份、状态、调度和执行审计的统一权威。一个 Task 可以包含：

- 名称、目标文档和工作区
- 当前状态与状态历史
- Runtime/Model/Permission/MCP 的可选任务级覆盖
- 一次性、At、Every 或 Cron schedule
- 可选的触发前检测：始终执行，或先运行本地命令、命中后才唤醒 AI
- 运行次数、Session 关联、执行与验收文档
- 通知与结果投递

常见流程：

```text
Thought → 与 AI 对齐 → 创建 Task → todo
      → 手动 run 或到点触发 → running → verifying → done → archived
                                      ↘ blocked / stopped
blocked / stopped / done / archived → rerun → todo
```

Task 的具体状态转换由产品约束；不要用直接改文件跳过状态机。Task 级 Runtime 覆盖只影响该 Task，不会改掉 Agent 默认配置。

## 定时任务与 Cron

0.3.0 起，新的定时自动化统一作为带 schedule 的 Task 管理。`myagents cron ...` 和相关 UI 仍保留用户熟悉的定时任务入口，但它们看到的是同一批 Task 与执行历史，不是另一套任务。

支持的时间形态包括：

- 指定时间执行一次（At）
- 每隔固定时间（Every）
- 标准 Cron 表达式

关键行为：

- Running 表示 scheduler 已启用，不等于此刻正在执行。
- `run-now` 可以执行停止状态的 Task，但不会启用其 schedule，也不会移动下一次周期触发时间。
- Stop 应停止未来调度，并在有活跃执行时精确停止当前回合。
- 执行历史属于 Task/Cron 投影，可用于查看上次是否成功。
- 旧 At/Every/Cron 会在升级时迁移；旧 Loop 不自动转 Goal。

### 条件激活：命中后才唤醒 AI

当任务需要频繁检查、但绝大多数时候没有变化时，可以在同一个 Task 上选择“本地命令检测”。到点后 MyAgents 先用当前桌面用户权限运行结构化本地命令；命令只回答 `quiet`（不唤醒）或 `activate`（携带事件证据唤醒）。进程、超时或协议错误是可见的 Detector 故障，不会再叫醒 AI 做二次判断。

适合：等待构建结束、轮询本地/远端 API 状态、监测一个可由代码稳定判断的条件。不适合：条件本身必须靠模型理解，或需要退出 App 后仍常驻运行。条件激活仍属于同一个时间型 Task，只在 MyAgents App 在线时检查；最小化/后台驻留不影响，完全退出或系统休眠期间不执行，也不会注册系统 daemon。

Task Center 可以创建、编辑和查看同一个条件激活 Task：

- Test Detector：真实运行脚本，但不提交平台 checkpoint/健康/事件，也不唤醒 AI；脚本自己的外部副作用不会回滚。
- Check now：立即做一次真实判断，提交 checkpoint，命中时唤醒 AI；即使 Task 当前 Stopped/Blocked，这次一次性投送也能在 App 重启后恢复，但不会顺带启用定时器或改变暂停状态。
- Run now：绕过 Detector，直接强制执行一次 AI；已有待投送 Activation Event 时不可抢占，需等待结算或先停止 Task。
- Reset checkpoint：只清 MyAgents 托管的少量检测进度，不删除脚本自己的文件或数据库。
- Pause/Stop/Delete：停止后续检查；删除 Task 不删除它引用的用户脚本。

每个 Task 只有一个时间 Source 和一个 Detector；复杂条件应在一个 command Detector 内组合。连续对话可以绑定当前或任意已有 Session；Session 正忙时事件进入原有队列，不打断当前回合。检查次数与 AI 执行次数分开显示，所以大量 quiet 检查不会虚增模型执行统计。

持续、开放式、多轮推进不应创建 Loop Cron；使用 Goal Mode。

## Goal Mode

Goal 是当前 Session 的长程工作状态。用户在 Chat/Launcher 使用 `/goal` 或明确要求 Agent 创建 Goal 后，同一 Session 会围绕 objective 连续执行：一轮结束后宿主安排下一轮，直到完成、阻塞、用户暂停/取消，或系统终止。

它的关键特征：

- 复用当前 Session 的历史、Workspace、Runtime、Provider、Model、MCP 和输出路由。
- 不创建 Task，也不创建 Cron。
- 用户可以暂停、恢复和取消；模型只能在证据充分时提交 complete，或在同一 blocker 连续多轮无法推进后提交 blocked。
- Goal 运行中用户仍可发送消息，这些消息会进入同一 Session 的执行队列。
- 同一 Session 从桌面、私聊 IM 或 Agent Channel 打开时看到的是同一个 Goal 状态。
- Goal 状态栏汇总轮次、执行耗时和 Token，用于结果回顾，不是预算限制。

适合：需要 Agent持续研究、实现、验证、迭代，且过程中可以自行推进的明确目标。

不适合：只需到某个时间提醒一次、缺少关键产品决策、或需要在多个独立 Task 之间编排责任的场景。

## Task 与 Goal 怎样组合

两者独立但可使用同一 Session：

- Task 负责“什么时候触发一次工作、状态怎样追踪”。
- Goal 负责“当前 Session 是否要持续多轮推进一个 objective”。
- 一个 Task prompt 可以明确让 Agent 在目标 Session 创建 Goal，但当前没有自动的 Task→Goal 编排对象。
- 同一 Session 同时收到用户消息、Task 回合和 Goal 续跑时，产品会在同一执行队列中依次处理。

不要为了“定时触发一次 Goal”而假设产品会自动把二者绑定；需要时应明确设计触发和会话归属。

## Session Goal 与 Space Goal

- Session Goal：本地执行模式，有 active/paused/complete/blocked/canceled 等状态。
- Space Goal：团队空间里的层级分类，用来组织 Issue，可以归档；不驱动本地 Session 自动续跑。

命令和 ID 也不同：`myagents goal` 与 `myagents space goal` 不能混用。

## 正确预期与常见误解

- “Cron list 空就是系统没有任务”：列表通常有 Workspace scope，应确认作用域。
- “Stopped Task 不能 run-now”：可以手动执行，但 schedule 仍保持停止。
- “Test Detector 完全无副作用”：只是不提交 MyAgents 状态；脚本自己的文件、网络和数据库副作用仍会发生。
- “退出 App 后条件检测仍会运行”：不会；它属于 App 内 Task harness，不是系统服务。
- “Goal complete 等于用户取消”：不是。模型完成、模型阻塞、用户取消是不同终态。
- “关闭 Goal 所在 Tab 就一定停止 Goal”：Goal 属于 Session；如果 Goal 仍在运行，或后台 Task/Channel 仍使用该 Session，它不一定随 Tab 一起停止。
- “Task done 后可以随便 rerun”：普通 Task可按状态机 rerun；已关联 Space Issue 的 Task 还受云端 claim/reopen 流程约束。

## 什么时候应转入 support

- 到点未触发、重复触发或执行时间漂移
- Stop 后旧执行结果覆盖了新一轮状态
- Task 状态与实际执行明显不一致
- Goal 暂停后仍持续续跑、取消后复活、结果投错 Session/Channel
- 同一 Goal 在不同入口显示冲突
- 旧任务迁移后丢失或 Loop 被错误自动转换
