# 小说工作台关键设计

> 本文记录 MyAgents 小说工作台已经确认的产品与架构决策。后续实现、评审和 Agent 开发必须以本文及 `specs/tech_docs/workbench_platform.md` 为准。

## 1. 目标与定位

MyAgents 是平台底座，小说工作台是建立在 Workbench Platform 上的官方可插拔工作台。

核心目标：

- 只重建小说创作需要的领域能力，不复制 StoryForge 的业务实现；允许把经确认的提示词内容作为版本化默认技能包快照导入。
- 不按旧数据库表逐表复刻，而是用适合 Git、人工编辑和 Agent 检索的文件模型覆盖相同领域信息。
- 一部小说的目录就是完整项目根目录，可以独立移动、备份、提交 Git 或由其它编辑器修改。
- Markdown 与 JSON 是唯一可移植事实源；向量索引和派生检索图谱可以删除并重建。
- 存储层只提供通用文件能力，不包含小说业务逻辑。

## 2. 与 MyAgents 平台的关系

小说工作台的标识为 `io.myagents.novel`，当前使用 Workbench API `1.11`。

依赖关系必须保持为：

```text
MyAgents Core -> workbench-sdk <- Novel Workbench
                       ^
                       |
              workbench-registry
```

边界约束：

- 小说工作台只能通过 `src/renderer/workbench-sdk` 或 `src/shared/workbench-sdk` 使用宿主能力。
- 不得直接导入 App、Chat、Config Store、Sidecar、Tauri API 或宿主内部组件。
- 工作区文件操作统一通过绑定项目根目录的 `WorkbenchStorage` 完成。
- Launcher 通过工作台声明的 `launcher` contribution 加载新建项目界面。
- 工作台内容由 `WorkbenchShell` 承载，不复制宿主标题栏、导航、加载态和错误边界。
- 大型 AI 功能通过 `context.agentSessions.open()` 请求宿主创建完整 MyAgents 对话，工作台不得直接操作 Chat、Tab 或 Sidecar。
- 小说工作台通过 Shell contribution 声明左侧导航默认收起，不能在通用 Shell 中硬编码小说工作台 ID。
- 工作台 Tab 使用统一的 `view: "workbench"`，不能为小说增加新的 Tab view 类型。

## 3. 用户进入路径

### 3.1 创建新小说

```text
MyAgents Launcher
  -> 添加 / 新建项目
  -> 选择“新建小说”
  -> 填写固定项目名、可变书名、保存位置、题材、创作语言、写作视角、总字数区间和每章字数
  -> 提交声明式初始化蓝图
  -> Tauri 在同级临时目录创建完整项目
  -> 原子重命名为目标目录
  -> MyAgents 注册带 workbenchId 的 Workspace
  -> 打开小说工作台总览 Tab
```

只有文件系统初始化全部成功后，才允许写入 MyAgents Workspace 配置并打开 Tab。目标目录已存在时不得覆盖。

### 3.2 打开已有小说

- Launcher 中带 `workbenchId: "io.myagents.novel"` 的 Workspace 卡片直接打开小说工作台。
- 一个小说工作台 Tab 由 `(workbenchId, canonical workspacePath)` 唯一标识。
- 已打开同一项目时切换到现有 Tab，不创建重复 Tab。
- 当前工作台 Tab 不隐式创建 AI Sidecar。

### 3.3 与 Agent 的交互路径

小说工作台的所有 AI 能力必须复用 MyAgents 已有的 Agent Session、运行时选择、完整对话窗口与执行状态协议，不能在工作台内部创建第二套聊天系统或直接依赖 Sidecar 实现。

按交互规模分为两条路径：

```text
大型 AI 功能（世界构建、全书规划、长流程审查）
  -> 工作台通过 Workbench Host 能力发起任务
  -> MyAgents 打开完整 Agent 对话 Tab
  -> 用户在原生对话窗口中完成追问、工具调用、审批与结果审阅

小型 AI 功能（单页补全、字段生成、提取词条、局部检查）
  -> 工作台通过 Workbench Host AI 接口提交结构化请求
  -> MyAgents Agent Session 执行
  -> 工作台复用统一的 Agent 运行信息小窗显示状态
  -> 返回候选内容和差异，用户确认后再由领域 Repository 写入
```

Agent 运行信息小窗只是宿主运行状态的简化投影，统一显示上下文装配、执行、校验、停止和结果状态；它不保存独立会话状态，也不实现聊天。用户可以随时从小窗展开到 MyAgents 完整对话窗口。

任何 Agent 写入都必须落回可审阅的 Markdown 或 JSON，不能只修改向量库或派生图谱。

## 4. 存储原则

### 4.1 三层数据模型

| 层级       | 内容                                                   | 是否进入小说目录         | 是否提交 Git | 是否可重建       |
| ---------- | ------------------------------------------------------ | ------------------------ | ------------ | ---------------- |
| 事实源     | Markdown 正文、设定、资料；JSON 索引、实体、关系、事实 | 是                       | 是           | 否，属于用户资产 |
| 派生知识层 | 分块、标准化实体、反向引用、图遍历加速数据             | 否，存放在 MyAgents 缓存 | 否           | 是               |
| 向量索引   | Embedding、向量库内部文件、检索缓存                    | 否，存放在 MyAgents 缓存 | 否           | 是               |

项目根目录中 `knowledge/*.json` 是人工可读、可编辑的知识图谱事实源，不是向量数据库文件。

### 4.2 格式职责

- Markdown：承载需要连续阅读和人工编辑的内容，如正文、世界观和研究笔记。
- JSON：承载稳定标识、排序、状态、实体、关系、时间线和索引。
- 二进制文件：只放入 `assets/`，不把二进制内容编码进 JSON。
- 所有文本使用 UTF-8，JSON 使用 2 空格缩进并以换行结尾。
- 所有项目内路径使用 `/` 分隔的相对路径。

### 4.3 通用存储接口

`WorkbenchStorage` 绑定当前小说根目录，仅提供通用原语：

- 路径状态与目录枚举；
- UTF-8 文本读取、创建与原子写入；
- 基于 `expectedContent` 的外部修改冲突检测；
- 二进制读取；
- 创建目录、复制、移动、重命名与删除；
- 粗粒度工作区变更订阅。

绝对路径、`..` 路径穿越和 NUL 字节必须在进入宿主文件系统前拒绝。JSON/Markdown codec、Schema、章节编号、人物关系等规则属于小说工作台，不得下沉到通用存储层。

## 5. 每部小说的目录结构

新建任何题材、篇幅或创作方式的小说，都初始化同一套目录结构，不提供“空白 / 长篇 / 短篇”等结构模板选择。

```text
<novel-root>/
|-- novel.json
|-- README.md
|-- .gitignore
|-- manuscript/
|   |-- index.json
|   |-- state-ledger/
|   |   |-- index.json
|   |   |-- baselines.json
|   |   `-- batches/
|   |-- continuity-state/
|       |-- index.json
|       |-- facts/<fact-id>.json
|   |-- chapters/
|   |   `-- .gitkeep
|   `-- trash/
|-- narrative/
|   |-- index.json
|   |-- lines/
|   |   `-- records/
|   |-- arcs/
|   |   `-- records/
|   |-- directories/
|   |   `-- records/
|   |-- chapters/
|   |   `-- records/
|   |-- simulation-proposals/
|   |   `-- records/
|   |-- legacy/
|   `-- proposals/
|-- inspiration/
|   |-- index.json
|   `-- records/
|-- settings/
|   `-- ai-model-scenes.json
|-- characters/
|   |-- library.json
|   |-- index.json
|   |-- records/
|   |-- souls/
|   |   |-- index.json
|   |   `-- records/
|   `-- proposals/
|-- world/
|   |-- cultivation/
|   |   |-- index.json
|   |   |-- origins/
|   |   |   `-- records/
|   |   |-- relations/
|   |   |   |-- index.json
|   |   |   `-- records/
|   |   `-- systems/
|   |       `-- <system-id>/
|   |           |-- system.json
|   |           |-- projection.json
|   |           |-- theory/
|   |           |   |-- index.json
|   |           |   `-- nodes/
|   |           |-- progression/
|   |           |   |-- index.json
|   |           |   `-- records/
|   |           |-- track-interactions/
|   |           |-- resources/
|   |           |-- methods/
|   |           |-- abilities/
|   |           |-- formations/
|   |           |-- foundations/
|   |           |-- transitions/
|   |           |-- constraints/
|   |           `-- audit.json
|   |-- locations/
|   |   |-- index.json
|   |   `-- records/
|   |-- factions/
|   |   |-- index.json
|   |   |-- records/
|   |   `-- proposals/
|   |-- items/
|   |   |-- meta.json
|   |   |-- index.json
|   |   |-- records/
|   |   |-- pages/
|   |   `-- proposals/
|   |-- maps/
|   |   |-- index.json
|   |   |-- records/
|   |   |-- proposals/
|   |   `-- trash/
|   |-- setting-library/
|   |   |-- meta.json
|   |   |-- spatial-tree.json
|   |   |-- settings.json
|   |   |-- pages/
|   |   |-- entries/
|   |   `-- proposals/
|   |       `-- <proposal-id>/
|   |           |-- proposal.json
|   |           |-- before/
|   |           `-- after/
|   `-- cultivation-proposals/
|-- timeline/
|   |-- index.json
|   |-- calendars/records/
|   |-- periods/records/
|   |-- views/records/
|   |-- branches/records/
|   `-- events/records/
|-- research/
|   |-- index.json
|   `-- notes/
|       `-- .gitkeep
|-- knowledge/
|   |-- entities/
|   |   |-- index.json
|   |   `-- records/<entity-id>.json
|   |-- relations/
|   |   |-- index.json
|   |   `-- records/<relation-id>.json
|   `-- facts/
|       |-- index.json
|       `-- records/<fact-id>.json
|-- prompts/
|   |-- registry.json
|   `-- installations/
|       |-- storyforge.prompt-library/
|       |   `-- content/
|       |       `-- prompts/
|       |           |-- general/
|       |           `-- genre-packs/
|       `-- <installation-id>/
|           `-- content/
`-- assets/
    |-- README.md
    |-- images/
    |   `-- .gitkeep
    `-- references/
        `-- .gitkeep
```

说明：

- 新项目不再初始化旧版 `world/worldview.md`、`world/rules.json` 与 `world/codex/`；旧项目打开时保留这些文件供兼容读取，世界观与规则事实统一由 `world/setting-library/` 承载（见第 13 节）。
- `world/locations/index.json` 是故事地点库的逻辑入口，与空间树并存，职责边界见第 13.1 节；物理存储使用 `schemaVersion: 1`、`storageVersion: 1` 的目录协议，根索引只保存有序 `{id,path}`，完整地点记录位于 `world/locations/records/<location-id>.json`。Repository 在内存中聚合完整地点库，保存时比较整个目录快照、差量写入记录并最后提交根索引；旧的内嵌数组单文件格式不兼容、不迁移。
- `world/cultivation/index.json` 是修行生态入口，只保存世界本源、修行体系和跨体系关系的有序目录。每个体系位于 `world/cultivation/systems/<system-id>/`；理论、成长轨道、资源、法门、能力、阵法、根基、跃迁和约束按模块拆分，大型集合继续采用 `index.json + records/<entity-id>.json`。Repository 在内存中聚合完整领域模型，保存时校验跨模块引用并只写变化文件；AI 提案也按受影响文件保存 before/after。旧的 `world/cultivation-ecology.json` 不兼容、不迁移。
- `world/factions/index.json` 是势力库入口，使用 `schemaVersion: 2`、`storageVersion: 1` 的目录协议，只保存有序 `{id,path}` 引用；完整势力记录位于 `world/factions/records/<faction-id>.json`。Repository 在内存中聚合完整势力库，保存时比较整个目录快照、差量写入记录并最后提交根索引；删除势力时同步清理孤立记录。旧的内嵌数组单文件格式不兼容、不迁移。
- 冻结基线中的正式时间线“计划”只作为故事提案来源展示，作者明确纳入下一轮后才生成 `narrative.event` 候选；它保留计划事件 ID 的 `based-on-timeline-plan` 审计边，但不会自动发生、不会被当作既成事实，也不会回写时间线。
- 冻结基线中已通过正文哈希、逐字证据、实体引用和正式时间锚点校验的 `chapterFacts`，只在其世界时间落入当前下一轮窗口时作为“章节事实提案”展示；作者明确纳入后才生成 `narrative.event` 候选，并通过 `based-on-chapter-fact` 审计边保留章节事实来源。章节事实不会自动再次发生、不会直接改变正式正文或时间线。
- 顶层 `settings/` 保存 `ai-model-scenes.json`（模型场景配置）等 MyAgents 平台级项目配置，该文件由“设置 / 模型场景”首次保存时创建，不属于初始化文件。

`.gitignore` 仍然初始化，用于排除操作系统和编辑器临时文件；但创建项目时不自动执行 `git init`，Git 仓库是否建立由用户决定。

## 6. 核心文件协议

### 6.1 `novel.json`

项目元数据至少包含：

```json
{
  "schemaVersion": 1,
  "projectId": "uuid",
  "workbenchId": "io.myagents.novel",
  "title": "小说名称",
  "genres": ["玄幻", "东方玄幻"],
  "targetWordCount": 1000000,
  "writingPerspective": "third-person-limited",
  "status": "planning",
  "language": "zh-CN",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

约束：

- `genres` 至少一项、允许多选、不得重复。
- `targetWordCount` 保存实际字数，不保存“万”单位值。
- `writingPerspective` 为 `first-person | third-person-limited | third-person-omniscient | multiple-perspective`；新建与旧项目缺失时默认 `third-person-limited`。
- `status` 为 `planning | writing | completed | paused`。
- 旧项目的单值 `genre` 和 `form` 字段只用于兼容读取；新项目不再写入。

### 6.2 章节协议

- 章节正文位于 `manuscript/chapters/`。
- 文件名使用六位数字，例如 `000001.md`。
- 章节 ID 使用同一编号，例如 `chapter-000001`。
- `manuscript/index.json` 是章节顺序、状态和路径的结构化索引。
- `nextChapterNumber` 必须大于已有的最大章节编号。
- 章节 ID、编号和路径必须一一对应且不得重复。

#### 6.2.1 正文工程 v2

- `manuscript/index.json` 当前正文协议为 `schemaVersion: 2`。旧 v1 索引只在内存中迁移，作者明确保存正文结构或排版设置时才写回 v2，禁止打开项目时静默改写。
- v2 额外保存 `structureMode: free | merged | locked`、`directories`、`typography` 和 `trash`。目录是可递归的卷 / 篇 / 目录树；章节通过 `directoryId + order` 归属和排序，章节可选 `narrativeChapterId` 关联剧情工程章节计划，目录可选 `narrativeDirectoryId` 关联剧情工程目录。
- `free` 允许正文独立组织；`merged` 允许正文编辑并提供剧情工程同步；`locked` 由剧情工程目录、章节计划和稳定关联驱动，正文页不得创建、删除、重命名、移动或重排结构。
- 严格同步只创建缺失的正文 Markdown，不覆盖已有正文内容；剧情工程章节计划的 `manuscriptChapterId` 与正文索引在一次受 `expectedContent` 保护的事务中闭合。事务失败时回滚已创建正文和已写入的索引。
- `typography` 保存项目级 `fontFamily`、`fontSize`、`lineHeight`、`paragraphSpacing`、`firstLineIndent` 和 `contentWidth`，写作纸面与预览共享该配置。
- 删除章节必须将 Markdown 移入 `manuscript/trash/<deletion-id>/`，在索引中保留原路径、目录、正文关联、删除时间和状态批次；恢复先恢复文件，再恢复索引与仍然有效的剧情关联。删除不是永久删除。
- 正文连续性账本位于 `manuscript/state-ledger/`。`index.json` 使用领域 `schemaVersion: 3`、目录 `storageVersion: 1`，只保存更新时间、全局基线路径和批次的有序 `{id,path}` 引用；首次变更前的目标快照保存在 `baselines.json`，每个批次的正文哈希、证据、变更和回滚 mutation 独立保存在 `batches/<batch-id>.json`。Repository 在内存中聚合完整账本，保存时比较整个目录快照、差量写入基线与批次并最后提交根索引；旧 `manuscript/state-ledger.json` 单文件格式不兼容、不迁移。
- 正文连续性事实位于 `manuscript/continuity-state/`。`index.json` 使用领域 `schemaVersion: 1`、目录 `storageVersion: 1`，只保存更新时间和事实的有序 `{id,path}` 引用；每条 `ManuscriptContinuityFact` 独立保存在 `facts/<fact-id>.json`。投影在内存中聚合完整连续性状态，保存时比较整个目录快照、差量写入事实并最后提交根索引，删除已移除事实文件；旧 `manuscript/continuity-state.json` 单文件格式不兼容、不迁移。
- AI 只能创建带正文证据的 `proposed` 批次，证据必须是分析时正文中可逐字定位的连续原文片段，禁止概括、改写或拼接多处文本。分析结果必须在创建批次前使用与应用阶段相同的证据规则过滤；全部变化均无有效证据时分析失败，不得生成一个必然无法应用的批次。作者审阅后才可标记 `applied`；应用前仍须校验正文哈希与逐项证据，旧批次中的无效证据项默认取消选择且不得阻断同批有效项。删除章节按批次逆序标记 `reverted`，恢复章节可重新应用原批次。批次领域覆盖时间线、人物出场 / 状态 / 关系、物品、地点、势力、伏笔、世界规则和承接事项。`novel_continuity_get_context` 默认只返回批次摘要和当前连续性事实，传 `chapterId` 可筛选章节，只有传 `batchId` 才展开单个完整批次，避免把全部证据和回滚快照一次塞入模型上下文。
- 正文脑暴以“完整方案”为一级生成单位，采用总控 Agent + 最多 6 个专业设计师 Agent 的结构化编排。作者设置完整方案数量和本轮意图；“完整方案数”下拉框紧邻“作者本轮意图”输入框展示，开始或重新会诊动作保留在配置栏底部。事实快照按字符预算压缩，总控接收全局短摘要，每个设计师只接收与职责相关的少量模块摘要。第一阶段各设计师并行提交机会、约束、建议和问题，总控再汇总共同事实、共识与分歧，并为每套候选生成带稳定 `planId` 的方案契约。
- 方案契约锁定核心选择、因果链、必备节拍、人物问题、情绪弧线、反转、钩子、不可违背边界和待定问题。第二阶段仍由设计师并行工作，但每位设计师一次性覆盖全部 `planId` 并按 ID 返回贡献，避免产生“方案数 × 角色数”的无必要请求；第三阶段由总控一次性按方案整合并审计，显式保留事实依据、作者要求、创作假设、角色贡献和未解决风险，不得静默抹平冲突。会诊、定契约、并行设计、总控整合分别展示状态；总控和每个设计师都必须展示排队、请求、已返回、解析、完成、部分完成、超时或失败状态、当前任务与真实耗时，不使用虚构百分比。设计师返回形态或 `planId` 不符合协议时必须保留解析诊断，禁止统一折叠为“未返回可用贡献”；会诊全部失败时不得继续伪装成总控失败。
- 脑暴结果界面按完整方案组织，Agent 贡献是方案内的可展开依据，不再按 Agent 分栏让作者手工拼接互不相关的素材。作者选择一套完整方案后可直接转为正文创作指令。整个编排复用 Workbench API 的一次性 AI Run，不创建聊天 Session，也不写入项目事实；复杂阶段可声明由宿主限制上限的运行时限，Rust 控制面代理必须允许业务时限先结束，超时必须明确区分于模型成功返回空文本。

### 6.3 时间线事实源

- `timeline/index.json` 是时间线事实源入口，当前使用 `schemaVersion: 1`、`storageVersion: 1` 的目录协议；根索引只保存故事起点、事实截止点以及历法、纪元、视图、分支和事件的有序 `{id,path}` 引用。五类完整记录分别保存到 `timeline/<collection>/records/<id>.json`，历史时间线与故事时间线仍共享同一份世界事实，不拆成两套数据。Repository 在内存中聚合完整 `TimelineLibrary`，保存时比较整个目录快照、差量写入变化记录并最后提交根索引；旧 `timeline/index.json` 内嵌数组结构不兼容、不迁移。
- `sortKey` 是从宇宙起源开始的统一世界时间坐标，用于稳定排序；它不要求与任一本地历法存在可计算换算关系。
- 纪元是不限层级的区间树，不是事件。每个纪元保存上级、范围、起止坐标、时间精度和说明；全库必须且只能有一个根纪元，子级区间不得越出上级区间。
- 左侧纪元树同时承担事件导航：选择非根纪元后，中间时间轴只显示该纪元及全部后代纪元的事件，并以所选纪元的起止坐标约束时间轴范围；空纪元必须显示明确空状态。切换到分支模式或选择根纪元时解除纪元筛选。纪元模式下新建事件默认归入当前纪元，不按排序键自动迁移既有事件。
- 右侧事件资料检查器只滚动字段内容；包含事件名称、保存和删除操作的头部固定在检查器顶部，编辑态与继承事件只读态保持一致。
- 默认提供宇宙史、地方史、故事进程和叙事揭示四个视图：宇宙史与地方史按世界时间查看，故事进程以 `storyStartEventId` 为相对零点，叙事揭示按 `narrativeOrder` 展示信息在正文中的揭露次序。
- 每个事件保存稳定 ID、所属分支、自由故事时间 `timeLabel`、统一排序键 `sortKey`、可选结束坐标、时间精度、所属纪元、世界范围、认知层级、可选叙事顺序、标题、类型、概要、详细说明、人物 / 地点 / 势力 / 物品 / 章节关联和标签。
- 事件可保存多份 `timeExpressions`，分别对应宇宙纪年、本地历法或其它历法的作者确认说法；系统只并列展示，不擅自推导或强制换算。
- 因果关系只保存事件的直接前因 `causeEventIds`，直接后果由其它事件反向引用推导，避免同一关系的双向重复事实。
- 状态变化保存人物、势力、物品或地点的稳定 ID、变化前后值与说明；它是事件视角的历史记录，不反向覆盖各资料库中的当前资料。
- 伏笔附属于埋设事件，保存埋设章节、状态、回收事件和说明；“已回收”状态必须关联明确的回收事件。
- 时间线必须且只能有一个主分支。子分支使用 `parentBranchId + forkEventId` 表示从直接父分支的哪个事件开始分歧；分支查看时，父分支在分歧点后的事件只保留在父分支中。
- 人物、地点和事件名称允许重复，稳定 ID 才是引用身份。
- 时间线 AI 使用模型场景 `timeline.assist`，通过完整 MyAgents 会话提供时间序列校验、历史事件补全、分支后果推演和伏笔 / 揭示闭环建议。启动消息只携带当前视图、分支、纪元、事件等稳定目标标识和任务引导，不携带时间线事实或页面草稿；Agent 按需读取 `novel_timeline_get_context`，也可结合剧情、人物、世界、物品或修行体系上下文。事件建议必须先进入可恢复草稿，校验通过后提交待审提案；纪元、分支和视图仍由作者在时间线页面直接确认并保存。
- 时间线事件提案必须通过文件变更适配器接入 `WorldProposalReview`，每个候选投影为 `timeline/events/records/<event-id>.json`。新建候选保存 `baseValue: null`，更新候选保存生成时读取的完整正式事件；旧更新提案缺少基准时按冲突处理。应用、拒绝、单项删除、整份删除和冲突合并均由时间线 Repository 执行完整时间线 Schema、跨库引用、目录级 CAS 与失败回滚。多个提案之间存在事件因果或伏笔回收引用时，审阅器必须按依赖拓扑把前置提案排在前面；依赖未采纳前，后置提案不得应用并必须显示具体前置提案和事件 ID。删除新建事件候选不得留下其它候选的因果或伏笔回收悬空引用。

### 6.4 知识图谱事实源

- `knowledge/entities/`、`knowledge/relations/`、`knowledge/facts/` 分别保存人工确认的知识实体、关系和事实。每个集合的 `index.json` 使用 `schemaVersion: 1`、`storageVersion: 1`，只保存有序 `{id,path}` 引用；完整记录独立保存在各自的 `records/<id>.json`。
- 三类记录都必须有稳定小写 ID，索引路径必须严格对应记录 ID，记录内 ID 必须与索引一致。知识图谱只读取三个索引实际引用的记录，不把目录中的孤立文件当作正式事实。
- 旧 `knowledge/entities.json`、`knowledge/relations.json`、`knowledge/facts.json` 单文件格式不兼容、不迁移。
- 时间线事件可被投影为带时间有效性的故事事实，但投影数据不是新的人工事实源。

知识文件必须保留来源路径，保证 Agent 检索结果能够回溯到人工可编辑的事实源。

## 7. 向量与知识图谱检索层

向量检索和图谱检索位于小说目录之外，由 MyAgents 维护派生缓存：

```text
Markdown / JSON 事实源
  -> 工作区变更订阅
  -> 解析、分块和 Schema 校验
  -> 实体对齐与关系构建
  -> Embedding 与向量索引
  -> 图索引和反向引用
  -> 混合 Retriever
  -> Agent 上下文（内容 + 来源 + 实体关系）
```

检索规则：

- 语义召回使用向量索引。
- 人物关系、因果、时间线和设定约束使用图查询。
- 最终结果按来源、更新时间和事实状态重排。
- 项目被移动、从 Git 拉取或索引损坏时，可以从 Markdown 与 JSON 全量重建。
- 派生缓存不得成为项目打开、人工编辑或 Git 合并的前置条件。

## 8. 新建小说界面约束

新建弹窗当前字段：

- 项目名，作为创建后不可修改的固定代号，同时派生项目目录名；
- 书名，与项目名分离，创建后仍可在总览自由修改；
- 保存位置；
- 项目目录，由保存位置与清理后的项目名实时生成；
- 题材多选；
- 创作语言与写作视角；写作视角可选第一人称、第三人称限知、第三人称全知和多视角，默认第三人称限知；
- 总字数下限与上限，界面单位为“万字”；
- 每章字数，界面单位为“字”；
- 预计章节范围，由总字数上下限分别除以每章字数并向上取整得到。

已确认的交互：

- 题材使用分组标签布局，当前包含 14 组、73 个选项，并支持跨组多选。
- 默认选中“玄幻”，多选摘要显示选中数量。
- 题材弹层通过 Portal 挂载，可以超出弹窗边界；弹层内部独立滚动，不得让弹窗因为下拉展开出现纵向滚动条。
- 总字数默认 80 至 120 万字，允许小数万字，提交时转换为实际字数并取整；每章字数默认 3000 字。
- 项目名写入 `novel.json.projectName` 并作为 Launcher 中的固定项目显示名；书名写入 `novel.json.title`，工作台业务界面均读取书名。
- 总览必须直接展示项目名、书名、题材、创作语言、写作视角、总字数区间、每章字数和预计章节范围，并提供编辑入口；编辑时项目名只读，其余创作资料可修改。
- 总览保存项目资料时使用 `expectedContent` 防止覆盖外部修改，并更新 `updatedAt`。
- 小说工作台左侧导航默认显示为 64px 图标栏，用户可以通过顶部图标按钮展开或再次收起。
- 不显示“初始结构”选择。
- 不显示“初始化 Git”开关，初始化蓝图固定 `initializeGit: false`。

## 9. 版本与兼容性

- Workbench manifest 使用 `manifestVersion: 1`。
- 小说工作台当前版本为 `0.3.0`。
- 宿主 API 兼容范围当前固定为 `1.11`（`src/shared/workbench-sdk/protocol.ts` 的 `WORKBENCH_HOST_API_VERSION` 为唯一权威）。
- 项目文件使用各自的 `schemaVersion`，当前为 `1`。
- 读取旧格式时可以做内存归一化，但未经明确迁移操作不得静默重写用户文件。
- 旧版 `targetWordCount` 在内存中归一化为上下限相同的字数区间；旧项目缺少 `projectName` 时以内存中的原书名作为固定项目名。只有作者在总览明确保存项目资料时，才写入新字段并移除旧单值字段。
- 新 Schema 必须提供版本迁移策略，不能让旧项目因升级而无法打开。

## 10. 明确不做的事项

- 不使用 IndexedDB 作为小说项目事实源。
- 不把向量数据库文件提交到小说目录或 Git。
- 不复制 StoryForge 的业务源码，也不以旧表名限制新文件模型；提示词只以可审计的版本化内容快照导入。
- 不在通用存储接口中加入章节、人物、世界观等小说业务方法。
- 不按题材或长短篇创建不同目录结构。
- 不自动初始化 Git。
- 不让工作台 Tab 隐式持有 Agent Sidecar。
- 当前阶段不引入动态下载、第三方工作台代码沙箱或工作台独立后台进程。

## 11. 当前落地与后续顺序

已经落地：

1. Workbench SDK、manifest、注册表、工作台 Tab、Workbench Shell、依赖边界和版本协议。
2. Workbench API 1.1 通用存储接口。
3. Workbench API 1.2 声明式项目初始化协议与 Tauri 原子创建流程。
4. Workbench API 1.3 完整 Agent Session 宿主端口。
5. 小说工作台注册、基础 Shell、项目创建器和统一目录初始化。
6. Markdown / JSON 元数据与章节索引 Schema。
7. 基础章节读取、创建、保存与外部修改冲突处理。
8. 项目级提示词持久化、启用集解析、冲突阻断和世界架构向导启动入口。

推荐后续顺序：

1. 完善人物、世界观、灵感、时间线和资料的领域 Repository，仍只依赖 `WorkbenchStorage`。
2. 定义知识实体、关系、事实的稳定 Schema 和来源引用协议。
3. 实现工作区增量索引与可重建的向量 / 图谱派生缓存。
4. 定义 Retriever 接口和检索结果引用格式。
5. 扩展 Workbench Host AI 能力：小型任务调用受控接口并投影到统一运行小窗，再把 Retriever 提供给 Agent。

## 12. 相关实现与文档

- 平台协议：`specs/tech_docs/workbench_platform.md`
- 共享协议：`src/shared/workbench-sdk/`
- Renderer SDK：`src/renderer/workbench-sdk/`
- 宿主适配：`src/renderer/workbench-host/`
- 小说工作台：`src/renderer/workbenches/novel/`
- 小说初始化蓝图：`src/renderer/workbenches/novel/projectInitialization.ts`
- 小说文件 Schema：`src/renderer/workbenches/novel/projectSchema.ts`
- 灵感模块协议：`specs/tech_docs/novel_inspiration.md`

## 12.1 小说工作台 MVC 模块架构

小说工作台 Renderer 代码按“公共层 + 应用层 + 领域模块”组织。目录拆分只改变源码职责边界，不引入旧数据兼容层，也不要求数据迁移；小说项目的事实源仍由各领域 Repository 按既有文件协议读写。

```text
src/renderer/workbenches/novel/
|-- app/
|   `-- NovelWorkbenchApp.tsx       # 应用组合入口：导航、路由和跨模块编排
|-- shared/
|   |-- views/                       # 公共界面组件（按需建立）
|   |-- models/                      # 公共类型与视图模型（按需建立）
|   |-- tools/                       # 公共非领域工具（按需建立）
|   |-- constants/                   # 公共常量（按需建立）
|   |-- business/                    # 跨领域校验、索引和引用分析
|   |-- controllers/                 # 跨领域 React 控制器与组合 Hook
|   `-- infrastructure/             # 存储事务、测试替身等基础设施
|-- modules/
|   `-- <domain>/
|       |-- entities/                # Schema、实体类型和领域值对象
|       |-- data-access/             # Repository、文件读写和 CAS
|       |-- business/                # 领域规则、解析、AI 请求和用例
|       |-- controllers/             # 模块级状态编排与 React Hook
|       `-- views/                   # 页面、面板、对话框和样式
`-- <legacy-entry>.ts(x)             # 仅保留源码导出桥接，逐步删除
```

### MVC 职责与依赖规则

- `app` 只负责组装工作台和模块，不实现实体校验、文件协议或具体领域业务。
- `entities` 不依赖 React、Workbench Storage 或其它模块；schema 解析失败必须显式报告格式错误。
- `data-access` 只通过 `WorkbenchStorage` 访问小说项目文件，保存必须使用 `expectedContent`；事务和并发语义集中在 Repository 或公共基础设施。
- `business` 负责领域规则、跨实体计算、AI 请求构造和提案校验，不直接渲染界面。
- `controllers` 负责加载、刷新、保存、错误和外部焦点等状态编排；视图通过控制器使用业务和数据访问能力。
- `views` 只负责用户交互和展示；跨模块引用必须使用目标模块的公开入口，不得引用其内部文件路径。
- `shared` 不拥有某个具体领域的数据，不得把人物、时间线或物品的业务规则下沉为公共工具。
- 依赖方向固定为 `app -> modules/shared`、`views/controllers -> business/data-access/entities`、`data-access/business -> entities`。领域模块不得反向依赖 `app` 或宿主内部实现。

### 当前迁移状态

已按该结构迁移并通过类型检查和定向测试的模块包括：

- `modules/project`：项目实体、规划、Repository 和项目控制器；
- `modules/inspiration`：灵感实体、Repository、画布数据访问、AI 业务和工作台视图；
- `modules/timeline`：时间线实体、Repository、提案、AI 业务和时间线视图；
- `modules/maps`：地图实体、地图与提案 Repository、画布、编辑器和原型视图；
- `modules/prompts`：提示词实体、Repository、默认种子、解析业务和管理视图；
- `modules/research`：资料库视图；
- `modules/knowledge`：知识图谱业务、知识库、图谱和百科视图；
- `modules/items`：物品实体、Repository、AI 业务、批量提案和管理视图；
- `modules/factions`：势力实体、Repository、提案审核和势力管理视图；
- `modules/characters`：人物实体、默认值、Repository、提案审核和人物管理视图，并通过模块公开入口供正文、叙事工程、时间线和势力使用。
- `modules/locations`：地点实体、目录 Repository、跨空间节点校验和地点管理视图；

根目录中与这些模块同名的少量 `.ts` / `.tsx` 文件是过渡性的导出桥接，仅服务尚未完成分模块迁移的调用方；它们不负责旧数据兼容或迁移。无引用桥接必须直接删除，当前已清理人物、势力及 19 个不再被调用的公共层、灵感、物品、知识、地图、提示词和时间线薄转发文件。后续设定、正文、叙事工程和修炼生态模块完成迁移后，应继续删除对应桥接并让应用层直接引用模块公开入口。

## 13. 设定库编辑与独立地图模块

- 设定库使用“空间节点 → 必选层级类型 → 类型默认设定模板 + 节点自定义设定”模型，不再使用固定的 15 类、82 节点结构。
- 空间树由作者自由组织。每个空间节点必须关联一个 `LevelType`，但类型的建议父子关系只用于新建提示，不得阻止作者保存幻想世界中的非标准层级。
- 元配置由 `LevelType`、`SettingTemplate` 和 `LevelTypeSettingProfile` 组成。层级类型、Markdown 页面模板、类型与模板关联均为项目级可配置数据。
- 默认模板不是允许列表。任何节点始终可以新增自定义设定，例如宇宙节点可以额外创建“水系”页面。
- 类型默认页面采用惰性落盘：未编辑时只根据模板形成虚拟页面，首次编辑或新增词条时才创建 Markdown 正文和词条 JSON。
- 修改节点类型、修改模板、移除类型模板关联或归档类型时，不得删除、覆盖或重置已经落盘的正文与词条；不再匹配当前默认方案的页面保留为节点设定。
- 选中任一设定页面后，“内容”页签以占满内容区的可视化 Markdown 编辑器呈现；“词条”页签保存名称、分类、别名和定义。Markdown 始终是连续说明的事实源，富文本 HTML 不得落盘。
- 不再使用“取自真实”“架空改造”“冲突优先级”“作用域继承”“结构”“关系”等旧版编辑字段或页签。知识图谱由设定页 Markdown 标题与正文、词条、空间树、设定索引和其他项目事实派生，不反向替代正文；新项目不再初始化旧版 `world/worldview.md`、`world/rules.json` 与 `world/codex/`，旧项目打开时仅作兼容读取。
- 正式存储位于 `world/setting-library/`：`meta.json` 保存元配置，`spatial-tree.json` 保存空间树，`settings.json` 保存已落盘页面索引，`pages/<node-id>/*.md` 保存正文，`entries/<node-id>/*.json` 保存词条。
- 地图是小说工作台的独立一级模块，拥有单独导航入口；不得作为设定库侧栏、设定页签或编辑器内嵌面板出现。
- 地图模块独立负责世界结构、大陆与星球投影、多元或平行宇宙拓扑、地图图层、时间切片和空间约束检查。拓扑节点除世界类型、活动状态和关联地图外，可以通过 `MapFeature.entityRef` 关联世界架构设定节点；节点检查器必须支持从当前节点原子创建前置 / 后继节点、在通道中点插入节点和反转通道方向，所有操作仍只写 `MapDocument.features`。
- Agent 生成地图时可以读取设定库 Markdown 和知识图谱作为输入，但地图产物独立保存，不能把派生结果自动回写到设定文档正文。
- `MapDocument` 是全部地图类型的唯一事实源。`continent | planet` 由 OpenLayers 地理画布渲染，使用本地画布坐标编辑点、标签、自由圈定区域与路线；`multiverse | parallel` 由 XYFlow 拓扑画布渲染，`node` 表示世界节点，带 `sourceNodeId / targetNodeId` 属性的 `route` 表示世界之间的分支或通道。拓扑节点的世界类型、活动状态和关联地图，以及通道的关系类型、单向 / 双向和动态展示都保存在对应 `MapFeature.props`；自动布局只重算节点坐标并同步派生路线端点，不保存第二份拓扑数据。自由圈定区域新建时一律写为 `MapFeature(kind: area)`；早期 `polygon` 仅用于读取、编辑和导出既有地图的兼容，不能再作为独立工具或新建值。拓扑节点移动时必须同步路线端点，删除节点时必须级联删除关联路线。
- 大陆与星球地图的成图表面由 `MapScene` 可重建合成：海陆区域和地形增减笔触共同形成唯一海陆遮罩，海岸、沙滩和浅滩由遮罩派生；区域的纸纤维与水面波纹从稳定地图坐标和 `MapSceneRegion.texture` 派生，区域边线从 `edgeColor / edgeWidth` 派生，交互画布与 PNG 导出必须一致，不能保存纹理或描边像素。草原、林地、荒漠、赤地、冻土、雪原、沼泽和火山岩作为独立材质笔触保存，只能裁剪混合到陆地表面，不能改变海陆形状或生成第二份栅格事实；每种材质必须从笔触和稳定地图坐标重建可辨识的地貌结构（例如林冠、沙脊、地层、冰雪风纹、水洼或裂隙），不得退化为统一的色块或随机噪点。旧笔触缺少材质字段时保持原有海陆或素材语义。
- 山脉、雪峰、丘陵、森林、针叶林、枯木林、城市、村镇和地标等成品构件使用内置矢量素材目录，不以 UI 图标或文字字符代替成图素材。同一素材可以提供多个手绘轮廓变体：独立印章把 `variant` 保存到 `MapDocument.artwork`，旧印章缺失时默认首个变体；连续素材笔刷按笔触稳定 ID 和采样序号派生变体，保证同一笔内自然混排且重新打开、缩放和导出时不随机跳变。内置矢量素材的填色从笔触 `color` 事实派生，项目导入图片保持原色，均不得保存染色后的图像。素材目录可以声明横向构件（当前为山脉）沿笔触切线稳定转向，树木等有上下朝向的构件保持自身朝向；方向只由已保存控制点派生，不另存角度。素材本体和派生图像仍不写入地图 JSON。
- 构件库卡片点击后必须进入明确的画布放置状态，禁止在画布中心静默插入。大陆和群岛在画布显示预制区域预览并落为 `MapSceneRegion`；河流、道路、城墙、疆界、裂谷、峡谷和洋流进入路线拖绘，松手后以预设 `props` 写入单一 `MapFeature`；山脉、植被、聚落与地标进入带实物预览的素材印章放置。对声明支持连续笔刷的山脉、森林和地貌素材，主卡点击必须直接进入拖动笔刷，单个印章只通过独立准星入口选择；素材库拖入画布是同一落地语义的快捷入口，不能因为入口不同而保存成另一种对象类型。
- 独立素材印章的直接操控必须拆分为互不混用的动作：拖动素材本体只移动，四角手柄只等比缩放，上方独立手柄只旋转。拖动期间使用画布本地预览，松开后一次性提交到 `MapDocument.artwork`，保证一次手势只产生一个撤销历史节点；普通要素、笔触和区域等不支持该变换协议的对象只能显示选中边界，不能显示不可操作的假手柄。
- 路线与自由圈定区域等拥有多个控制点的普通地图要素在选中后必须显示独立顶点手柄：拖动要素本体只整体移动，拖动顶点手柄只替换对应控制点。顶点拖动使用本地画布预览，松手后一次性通过 `MapDocument.features[].points` 写入，顶点命中范围按屏幕像素保持稳定；单点标记、标签和节点不显示伪造的顶点手柄。
- 连续素材、海陆和材质笔触的原始采样点可能很多，选中后只能从 `MapSceneStroke.points` 稳定派生有限控制点（当前最多 8 个，包含首尾），不得保存第二套编辑曲线或向作者暴露全部采样点。首次点击未选中笔触只选中；拖动已选中笔触本体才整体移动；拖动控制点以相邻控制点中点为边界平滑偏移附近采样点。三种操作均使用本地预览，松手后一次性更新原 `points`，缩放下的控制点命中范围保持屏幕像素稳定。
- 河流继续使用 `MapFeature(kind: route, props.terrain: river)` 作为唯一事实源，作者控制点不能被派生曲线替换。`sourceWidth`、`mouthWidth`、水色、岸线色和岸线宽度属于河流样式事实；场景 Canvas 与 OpenLayers 必须复用同一 Cardinal spline 和渐宽算法，从第一个控制点的源头向最后一个控制点的河口单调增宽，并允许在检查器中反转控制点顺序来反转流向。平滑采样、分段岸线和高光只属于可重建渲染结果，不写入地图 JSON。
- 道路、石板大道、林间小径、城墙和疆界继续使用 `MapFeature(kind: route)`；路线类别、主体与边缘颜色、主体宽度等样式事实只保存在 `props`，不能为纹理、塔楼或铺装另存路线或栅格。场景交互 Canvas、OpenLayers 兼容画布和 PNG 导出必须复用同一分层路线样式：双边、虚线、铺装横纹、城墙分缝和塔楼都从控制点与样式派生；这些成图细节不写回 JSON。
- 地图标签继续由 `MapFeature.name` 与 `props.showLabel` 承载，不建立独立文本副本。字体预设、字号、字重、颜色、描边、旋转、偏移、斜体和沿路径方向属于标签样式事实，交互画布、OpenLayers 兼容画布与高清导出必须复用同一解析规则；自由圈定区域标签锚点由区域质心派生，路线与河流标签锚点和正向可读角度由路径派生，均不写回地图 JSON。旧 `polygon` 兼容使用同一质心规则。独立文本标签成图时只渲染文字，不显示定位圆点；旧地图缺少标签样式字段时使用与要素类型匹配的兼容默认值。
- 地图 PNG 导出必须从当前 `MapDocument` 按 `canvas.width × canvas.height` 离屏重绘背景预设、自定义底图、地形合成、场景笔触、语义要素和素材印章，不得复制当前视口 Canvas。背景预设的渐变、波纹、星点与颗粒，以及自定义底图的 contain 构图和透明度，必须由编辑画布与导出器复用同一 Canvas 合成规则，禁止一侧使用独立 CSS 背景。相机缩放和平移、网格、选中框、变换手柄、笔刷轮廓与拖动预览都属于编辑器交互态，不能进入成图文件；导出与交互画布必须复用路径取样、河流渐宽和素材变换算法，并遵守图层可见性、透明度及时间切片。
- 地图生成器只能创建作者确认前的内存候选，不能直接写正式地图。Fantasy Map Generator 能力封装为小说工作台内置工具 `novel_maps_generate_fantasy_map`：Agent 必须先调用 `novel_world_get_context` 读取世界架构空间树、设定索引、Markdown、词条和地点，再把 `sourceHash` 传给地图工具；工具重新读取并比对哈希后，按设定生成连续大陆、区域、河流、山脉和聚落候选，写入地图草稿而不是正式地图。Red Blob 风格生成器仍可作为本地简化候选；Azgaar Fantasy Map Generator 作为外部生成与编辑工具，通过其官方导出的 Full/Minimal JSON、GeoJSON 或 SVG 进入候选转换层。Full JSON/GeoJSON 转为正式 `MapFeature`、`MapScene` 和 `MapArtwork`，成图与编辑对象均来自同一份 `MapDocument`；SVG 只作为运行时诊断或视觉参考，不能成为唯一底图事实，SVG-only 返回必须降级为同一规划驱动的结构化候选。作者在地图提案审阅中确认后才进入统一保存和冲突保护链路。地图提案采用 `schemaVersion: 2` 的小清单协议：`proposal.json` 只保存候选摘要、状态和 `candidates/<candidate-id>.json` 路径，候选 `MapDocument` 独立保存；采纳时再写正式地图。旧式把完整 `MapDocument` 内嵌进 `proposal.json` 的 v1 提案只用于兼容读取，并在首次采纳或拒绝时原地迁移为 v2，不能继续生成新的超大清单。
- Azgaar 完整运行时不嵌入主 Renderer。其静态构建包含旧式全局脚本、jQuery UI 和大量纹理资源，由 `scripts/prepare-azgaar-runtime.mjs` 固定到官方 `1.141.2` / commit `49f75b9e003468bfe9e7cbad08a359210507350d`，放入独立资源目录并保留 MIT 许可证。Sidecar 按次启动隔离的 Edge/Chrome/Chromium DevTools 会话和本地静态 Host，生成结束立即释放；Host 只允许回环资源和官方页面自身脚本。官方高度图模板使用 `Function()` 编译，因此只在这个固定资源、禁外网、一次性 profile 的页面 CSP 中放行 `unsafe-eval`，不能扩大到主应用，也不能接管 `MapDocument` 权威。
- 当前 Agent Tool 已提供 `Azgaar Runtime Adapter`：默认优先使用本地浏览器 Runtime，也可用 `MYAGENTS_AZGAAR_RUNTIME_URL` 指向外部同协议服务。生成请求必须携带刚由 `novel_world_get_context` 返回的 `sourceHash`，且 Agent 必须基于已读范围显式选择陆块、区域、河流意图及 Azgaar 原生高度图模板、国家、文化、宗教、降水参数；工具不得补猜这些决定。工具重新读取完整世界架构并先校验哈希，再把快照、空间/地点/势力名称及该方案 POST 到 `/generate`。高度图模板只允许固定 Runtime 内置集，陆块意图通过模板落实，区域、文明与宗教分别落实为 Azgaar 国家、文化与宗教数量，河流密度通过降水与高度图共同影响。方案和实际 Runtime/降级状态必须保留在地图提案中，作者可以审阅生成依据。本地 Runtime 优先返回官方 Full JSON 与 SVG 参考，结构化数据转换为统一 `MapDocument` 的 `MapFeature`、`MapScene` 和玄幻素材印章；若 Runtime 只返回 SVG，工具不得把 SVG 作为独立成图底图，而必须明确诊断并使用同一 `MapGenerationPlan` 生成结构化候选。Full JSON、GeoJSON 与单独 SVG 继续由手工导入适配器支持；缺少 Azgaar 资源或浏览器时明确返回 `runtime: compatibility-adapter`，这是设定驱动降级候选，不宣称调用了 Azgaar 核心。

### 13.1 地点库（`world/locations/index.json`）

- 地点库与空间树并存，职责边界固定为：**空间树 = 世界结构层**（星球、大陆、国家、城市等层级与层级类型），**地点库 = 叙事引用层**（故事中实际登场、被正文与时间线引用的地点）。两棵树都允许存在同名条目，稳定 ID 是引用身份，不要求互相同步。
- 地点库物理结构固定为 `world/locations/index.json + world/locations/records/<location-id>.json`。根索引只保存 `schemaVersion: 1`、`storageVersion: 1` 和有序 `{id,path}` 引用；`path` 必须严格等于 `world/locations/records/<id>.json`，记录内 `id` 必须与索引一致。
- 地点 Repository 递归聚合根索引引用的全部记录，在界面和业务层提供完整 `LocationLibraryIndex`。保存以根索引和全部已引用 records 的有序内容快照执行 CAS，只写新增或变化记录，根索引在同一事务中最后提交；删除地点后再清理不被新索引引用的孤立记录。旧的根索引内嵌完整地点数组格式不兼容、不迁移。
- 地点库是正文连续性追踪、时间线事件 `locationIds`、地图要素 `entityRef`（kind 为 `location`）与跨库引用检查的唯一事实源；空间树节点不能直接作为叙事引用目标。
- 每条地点保存稳定 ID、所属空间节点 `nodeId`、同节点内上级地点 `parentLocationId`（不得跨节点、不得成环）、名称、别名、类型、状态、摘要、出场说明、描述与排序。地点必须归属现有空间节点；节点被删除时，归属它的地点会阻止删除。
- 设定库的“地点”页签只是地点库的编辑入口之一，数据文件独立；新建地点时选择归属的空间节点。
- 世界架构 Agent 提案允许修改逻辑聚合路径 `world/locations/index.json`（见第 16 节允许目标）；审阅和应用由地点 Repository 将逻辑 before/after 快照拆装到 records，Agent 不需要也不允许管理物理 `records/` 路径。

### 13.2 设定库维护语义

- 空间节点支持硬删除：存在下级节点、已落盘设定页面、地点库归属或势力地盘引用时删除被阻止，错误信息列出全部原因；删除后空间树至少保留一个节点。
- 已落盘设定页面支持硬删除（正文与词条文件一并删除）。删除来自默认模板的页面后，该页会重新以虚拟页面出现；需要隐藏默认页时在模板管理中将模板归档（`archived: true`），归档模板不再生成虚拟页面，已落盘页面保留。模板归档/恢复在模板管理界面提供入口。
- 设定页面状态 `draft | completed` 由作者在页面列表显式切换；“已完成”表示作者确认该页可作为事实引用，系统不自动判定。
- 编辑模板的任意内容字段（名称、分组、说明、骨架、引导）都会自动递增模板 `version`（patch 版本）；落盘时 `settings.json` 记录 `templateVersion`。当页面记录的模板版本与模板当前版本不一致时，页面列表显示“旧模板”标记；新版本只影响未填写的虚拟页面，不覆盖已落盘正文。

## 14. 小说工作台 AI 与提示词模块

- 提示词管理位于小说工作台“设置 / 提示词”二级菜单，保持独立管理工作面；不得隐藏在某个世界构建向导、Agent 小窗、模型场景或设定页面内部。
- 平台拥有 Prompt Registry、解析、版本协议、Session 执行和运行状态；小说工作台只拥有小说领域提示词定义、上下文选择规则、输出 Schema 和项目级覆盖。
- 提示词只采用一种组织模型：`Package Source -> Package Installation -> Group Tree -> Prompt Instance`。系统预设只是来源为 `builtin` 的技能包，不再拥有独立类型、特殊分组或更高优先级。
- 每次安装产生一个独立 `Package Installation`。安装实例是提示词树的唯一顶层分组，来源目录作为其下级目录树，提示词实例只能属于该安装实例内的一个目录。
- 不允许创建脱离技能包的根分组。用户扩展结构时必须先创建项目本地技能包或安装外部技能包，再在选定安装实例内创建目录；目录的父节点只能是同一安装实例的根节点或其他目录。
- 技能包来源使用稳定 `packageId`；一次安装使用唯一 `installationId`；同一来源允许存在多个安装副本。提示词使用跨副本稳定的 `promptId` 和副本内唯一的 `instanceId`，稳定 ID 只负责识别同一能力，不能取代实例身份。
- 所有安装副本在安装完成后都属于用户配置，可修改名称、目录、提示词正文、作用域和启停状态。`builtin`、`github`、`project` 只表示来源渠道，不表示只读权限。
- 分组采用树结构，每个目录保存稳定实例 ID、`parentId`、安装副本 ID、来源相对路径和作用域。用户可在任意安装副本中新增、改名和移动目录；来源路径只用于审计与差异对照，不约束用户编辑后的组织方式。
- 目录管理采用按技能包分区的紧凑树列表。树行只显示目录名称和提示词数量、作用域、启停、修改状态等必要短标签，不直接展开说明、来源路径或可编辑表单；新增和编辑目录统一使用独立弹窗展示所属技能包、父目录、说明、作用域和启停配置。
- 分组启用状态沿树向下生效：任一祖先目录停用，其整个子树中的提示词都不得进入当前启用集。子目录仍保留自己的配置和启用状态，父目录重新启用后恢复按自身规则解析。
- 技能包安装时，manifest 必须声明一个或多个提示词内容根目录。安装器只处理这些受控根目录，不扫描 `.git`、`node_modules`、构建产物或仓库中的其它文件。
- 首次安装时，内容根目录到提示词文件之间的目录必须一对一复制到安装副本中，并为每个提示词保存仓库内 `sourcePath`。复制完成后副本与来源解耦，后续编辑不得回写来源仓库。
- 重新安装、升级或恢复系统技能包都必须创建全新的安装副本，不得覆盖、合并或重置现有副本。旧副本及用户修改完整保留，新副本从指定来源版本重新复制；用户可对照后自行启停、迁移或删除。
- 分组和单个提示词都可以声明作用域。作用域当前支持“全局”或“多个小说题材”；提示词未声明时继承分组作用域，提示词显式声明时以提示词作用域为准。
- 提示词实例、目录和安装副本均有启用状态。当前项目的候选启用集按以下顺序解析：提示词实例启用 → 所有祖先目录启用 → 所属安装副本启用 → 最终作用域与当前小说题材相交。实际结果完全服从用户配置，不存在“系统优先”“新版本优先”或来源自动兜底。
- 候选启用集中只要有多个实例使用同一稳定 `promptId`，即形成阻断型冲突。冲突实例全部不得进入 Agent 请求，直到用户明确选择保留一个实例；冲突处理只把其余实例写为停用，不删除内容，不改变来源身份。
- 提示词管理提供“总览”和“当前启用集”两个视图。总览以安装副本为顶层统一展示全部目录和提示词；当前启用集统一展示所有来源和所有副本的解析结果，不再按系统、用户或 GitHub 分区。
- 总览顶部提供独立“新增提示词”入口。创建时必须选择技能包安装副本和该副本下的目录；创建成功后直接选中新实例并进入空白 Markdown 编辑器。
- 提示词编辑页以正文为主工作面：完整分组路径与稳定提示词 ID 显示在名称上方，路径必须完整展示并允许按片段换行；名称后按“当前版本、技能包名称、修改状态”的顺序展示元信息。
- 提示词正文使用与设定库一致的成熟可视化 Markdown 编辑器，并占满标题与作用域工具条之外的全部可用区域；作用域保留为紧凑单行工具条，题材多选通过浮层展开，不得持续挤压正文高度。
- 当前启用集必须同时展示用户已启用数、排除数、冲突数、安装副本数和最终可执行数；每个冲突项需列出稳定提示词 ID、所有冲突副本、版本和修改状态，并允许用户选择保留副本。被排除项必须可展开查看具体原因。
- 技能包采用版本化 `skill-pack` manifest，允许内置、项目本地和 GitHub 来源。GitHub 安装、更新、校验和权限提示必须复用 MyAgents 平台安装能力；小说工作台只发起安装意图和展示 Registry 投影，不实现独立下载器或直接执行仓库代码。
- 技能包副本停用不删除安装内容或用户修改；卸载、升级和来源切换必须保留可审阅记录。后续持久化必须保留来源快照、安装身份和用户修改状态，不能仅依赖技能包内部文件路径恢复关系。
- 大型 AI 功能必须复用 MyAgents 完整 Agent 对话窗口。工作台只提交任务意图、项目身份和领域上下文，不复制消息列表、输入框、权限审批、工具过程或 Session 生命周期。
- 小型 AI 功能必须通过 Workbench Host AI 接口执行，并复用统一的 Agent 运行信息小窗。小窗只显示运行投影和候选结果，可以停止任务或展开到完整对话。正文局部润色必须使用无工具、单轮的一次性 Run；允许把最终文本通道的增量作为临时候选预览原位展示，但不得流出思维链、工具入参或工具返回，Run 完成后仍按正式候选审阅协议处理。
- 工作台发起的每一次性 AI Run 和完整 Agent Session 都必须在系统提示词前追加由 `novel.json` 总览生成的硬约束：书名、题材、语言、总字数目标、每章目标字数、写作视角及叙事限制、本书简介。局部任务、用户临时要求与按需读取资料不得覆盖这些总览前提；总览缺省字段按 Schema 的兼容默认值处理。
- Workbench API 1.9 允许小型一次性 AI Run 声明宿主识别的业务工具集。1.10 追加受控运行档位：普通请求保持标准预算与 60,000 字符提示词上限；需要读取多个领域并输出长结果的正文方案工作流使用 `extended`，默认 300 秒并由宿主限制在最多 600 秒、16 轮及 200,000 字符提示词上限，工作台不得直接申请任意轮次、时限或更大上下文。完整生成窗口为本次工作流统一提供 1～10 分钟超时选择，默认 5 分钟，方案生成、AI 建议和正文生成必须共享同一设置；正文连续性分析同样使用该受控档位并提供 1～10 分钟超时选择，默认 5 分钟，状态同步主页面与右侧同步面板共享当前工作台会话设置。“本章上下文”提供本章目标字数，打开时默认继承项目总览的每章字数，作者可仅为本次生成调整；调整后旧方案和选片结果失效。读取方式分为“快速模式”和“智能体自主读取”：自主读取继续开放小说工作台只读工具，由 Agent 判断所需资料；快速模式由作者人工选择世界架构层级或具体资料页、完整时间线、剧情工程线路 / 大纲 / 章节、可搜索多选的人物、最多前 5 章正文、灵感与势力。快速模式必须在并发请求前只组装一次同一资料快照并注入各 Agent 的用户上下文，不开放任何工具，Agent 依据已附资料一次性输出；切换模式或调整选择后旧方案、选片和正文候选全部失效。方案与正文请求都必须携带本章目标；正文返回后先清除模型泄漏的计数、自检或推理说明，再按非空字符校验目标的 ±10%，超出时允许做一次无工具篇幅调整，仍不合格的候选不得直接采用。正文方案返回应先在本地兼容严格 JSON、代码围栏、常见包装字段和结构化 Markdown；仍无法解析时，只允许使用原 Agent 的模型对该次已有返回做一次无工具格式整理，不得重新读取项目资料、重新生成剧情或重跑整批 Agent。此通道不创建或持久化 Chat Session，工具上下文按运行隔离；宿主只向模型开放登记的只读上下文工具并拒绝任何写入或普通文件工具。需要写入提案、权限审批或连续追问的任务仍必须使用完整 Agent Session。1.11 追加 `aiRuns.cancel(runId)`：调用方只能停止自己持有的在途 Run，宿主按稳定 `runId` 中断对应 SDK 运行并保持运行间隔离；取消后不得返回或写入候选内容，界面必须明确显示已取消状态。
- 人物库、物品库、世界架构、修行体系等 AI 会话使用的读上下文、校验和提交提案能力，产品语义统一为“小说工作台内置工具”。它们由 Workbench Host 按会话自动装配，不进入“设置 / MCP 服务”，不允许用户开关，也不得向用户展示连接或断开状态。
- 小说工作台所有 AI 写入工具都必须支持可恢复的小批量增量写入：单次调用默认不超过 32 项、64 KB，Agent 应通过同一草稿多次调用逐步累积候选；禁止为了修改少量字段重新上传完整大 JSON。对象候选使用稳定 ID 合并、追加或删除，文件型事实使用领域 patch 工具生成最终快照；只有小文件新建或确有必要时才允许整份替换。
- builtin Runtime 可在 Claude Agent SDK 边界通过进程内自定义工具适配器承载上述能力；SDK 生成的 `mcp__` 前缀和 `novel-workbench` 标识仅是传输层实现细节。UI 工具卡、运行提示、错误消息和模型回答必须使用业务名称，不得引导用户检查 MCP 设置、切换 MCP 服务或重启应用。
- 小说工作台完整 Agent Session 保留 MyAgents 常规命令和文件工具能力。Workbench Host 不得因会话属于小说工作台而硬拦截 `Bash`、`Read`、`Glob`、`Grep`、`Write`、`Edit` 等普通 SDK 工具；Agent 可以按任务需要读取小说目录内外的素材和设定，也可以执行作者要求的通用文件操作。小说工作台内置工具负责结构化领域上下文与正式提案协议，不取代文件系统访问权限；Agent 不得声称受控会话没有文件访问权限。
- 工具可用性与正式事实写回是两条独立边界。由小说工作台 Repository 管理的正式结构化事实仍必须遵守 `草稿 -> 领域校验 -> 待审提案 -> 作者审阅 -> Repository 原子写入`；原始文件工具不得被用来伪造提案提交结果或绕过审阅协议。项目外素材、项目内辅助文件和作者明确要求的其它普通文件操作不受该领域写回协议限制。
- 工作台 Tab 继续不隐式持有 Sidecar。只有用户明确发起大型对话或小型生成请求时，宿主才创建或绑定显式 Agent Session owner。
- `novel.world.guide` 是首个正式执行入口。“AI 创建世界”必须先解析当前启用集；缺失、停用或同 ID 多副本冲突时阻止请求。解析成功后由 Workbench API 1.5 打开绑定小说目录的 MyAgents Chat Tab。
- Workbench API 1.5 打开带初始消息的 Chat Tab 前，MyAgents 宿主必须解析并冻结当前可用的 Provider/Model 或外部 Runtime Model；项目或 Agent 中失效、停用、缺少凭据的旧 Provider 配置不得进入首次自动发送。系统没有可用模型服务时必须在创建 Sidecar 前返回明确错误。
- 模型场景是小说工作台所有 AI 入口的强制配置层，导航路径为“设置 / 模型场景”。项目级配置保存在 `settings/ai-model-scenes.json`，当前 `schemaVersion` 为 `1`；`defaultModel` 保存小说工作台默认 `{ providerId, model }` 二元组，`bindings` 以稳定场景 ID 为键保存场景覆盖。模型选择优先级固定为“场景绑定 → 小说工作台默认模型 → 全局默认模型”；小说工作台默认未设置时才使用 MyAgents 全局默认解析链路，工作台不得实现其它隐式回退。保存小说工作台默认模型不得写入、重置或改变已有场景绑定。
- 设置页的供应商和模型列表只能来自 MyAgents 当前已配置且可用的 Provider/Model 集合，采用“供应商 → 模型”二级级联选择。一次性 AI 生成场景不得允许绑定运行时托管供应商；完整 Agent 对话场景可沿用宿主支持的运行时托管模型能力。
- 每个新增或改造的 AI 功能都必须先在模型场景注册表声明稳定场景 ID、显示名称和执行类型（`agent` 或 `run`），再实现 UI 与调用逻辑。发起 `context.agentSessions.open()` 或 `context.aiRuns.run()` 前必须读取项目绑定，并把存在的选择作为 `modelSelection` 传给 Workbench Host；没有声明并接入模型场景的 AI 功能视为实现不完整，不得合入。
- Workbench Host 是模型选择的最终权威：收到 `modelSelection` 后必须验证供应商仍存在、可用且模型仍属于该供应商；验证失败必须阻止调用并提示用户回到“设置 / 模型场景”修复，禁止静默回退到默认模型。完整 Agent 会话创建时须把已验证的选择冻结到初始消息；工作台“重新开始”必须恢复同一模型选择。
- 项目级提示词覆盖继续使用 Git 友好的 Markdown + JSON；平台安全协议、工具策略和输出校验规则不可被项目覆盖。

## 15. 提示词持久化协议

- `prompts/registry.json` 是提示词结构化事实源，当前 `schemaVersion` 为 `1`。它保存安装副本、目录树、提示词元数据、作用域、启停状态、来源身份与 Markdown 相对路径，不保存提示词正文。
- 提示词正文独立保存在 `prompts/installations/<installation-id>/content/**/*.md`。来自技能包的提示词保持 manifest 内容根目录下的原始相对路径；项目内新建提示词写入该安装副本的 `_local/` 目录。
- 注册表磁盘字段使用领域正式名称：技能包副本为 `installationId`，稳定提示词标识为 `promptId`，副本内实例为 `instanceId`。同一个 `promptId` 可以存在于多个安装副本中，但 `instanceId` 与 `contentPath` 在项目内必须唯一。
- 每个安装副本必须且只能拥有一个根分组；目录父子关系不得跨安装副本或形成循环；提示词只能关联同一安装副本内的目录。
- 新小说初始化时复制一套可编辑的 `StoryForge 小说提示词库` 安装副本，以及 `MyAgents 小说工作台提示词` 安装副本。StoryForge 当前快照来自 `3.7.5`，包含 89 个 Markdown 提示词：40 个通用模板默认启用，49 个题材模板保留来源中的默认停用状态；工作台安装副本包含人物库 Agent 的 `novel.characters.assist` 默认提示词。
- StoryForge 默认包目录固定映射为 `prompts/general/**` 与 `prompts/genre-packs/<genre>/**`；题材目录通过小说工作台的中文题材集合声明作用域。工作台提示词位于 `prompts/characters/**`，系统提示词、用户模板、变量、参数、示例、模型覆盖和来源文件统一写入 Markdown。
- 默认包是项目初始化材料，不是某一部测试小说的专用数据。每次新建小说都会把注册表、目录树和 90 份 Markdown 复制到该小说根目录，复制后与内置快照解耦并允许作者修改。已存在注册表但缺少工作台人物库提示词的旧项目，在读取时只补齐缺失安装副本，不覆盖已有提示词或用户修改。
- 已存在 `prompts/registry.json` 的旧小说不得在普通打开流程中被默认数据静默覆盖；显式迁移或测试数据重置可以用当前快照整体替换。
- 保存 Markdown 与注册表时必须使用 `expectedContent` 检测人工编辑冲突。发现磁盘内容变化时停止覆盖并提示载入磁盘版本；新提示词只有在 Markdown 创建成功后才能登记到注册表，登记失败时回滚新建正文。
- 当前正式实现覆盖本地技能包、目录、提示词、作用域、启停、重新安装副本、启用集解析与冲突处理。GitHub 下载仍等待 MyAgents 平台安装能力，正式工作台不得用模拟下载替代。

## 16. 世界架构 Agent 提案与差异审阅

- 世界架构 Agent 不得直接修改 `world/setting-library/` 下的正式事实文件。作者确认方案后，Agent 只能写入 `world/setting-library/proposals/<proposal-id>/`。
- 每份提案使用 `proposal.json` 作为结构化清单，当前 `schemaVersion` 为 `1`。清单保存来源提示词、创建时间、目标文件、操作类型、摘要和逐文件处理状态，不内嵌文件正文。
- 提案正文采用镜像目录：`before/<设定库相对路径>` 保存 Agent 生成时读取的正式版本，`after/<设定库相对路径>` 保存建议版本。新增文件只有 after，修改文件必须同时具有 before 和 after。
- “设定库相对路径”明确以 `world/setting-library/` 为根：`targetPath` 仍写项目根相对路径，但快照中不得再次嵌套 `world/setting-library/`。例如 `targetPath=world/setting-library/spatial-tree.json` 对应 `before/spatial-tree.json` 与 `after/spatial-tree.json`。
- `proposal.json` 的 changes 与 after 文件必须一一对应；`settings.json` 新增的每个设置必须同时具备并登记其 Markdown 页面与词条 JSON。Agent 完成前必须检查 JSON 可解析、modify 的 before 齐全、after 全部登记及 settings 引用闭合。
- 审阅器兼容早期提案中重复嵌套 `world/setting-library/` 的快照路径，并把合法但漏登记的 after 文件作为“自动补录”变更展示。单个快照缺失只阻断该变更，不再使整份提案不可审阅；引用闭合校验仍会阻止不完整提案写入正式设定。
- 允许的目标严格限制为设定库 `meta.json`、`spatial-tree.json`、`settings.json`、`pages/<node-id>/<setting-id>.md`、`entries/<node-id>/<setting-id>.json` 和地点库逻辑聚合路径 `world/locations/index.json`；禁止提案修改小说目录中的其它文件、地点 `records/` 或递归修改 proposals。地点 before/after 保存完整逻辑聚合 JSON，冲突检测、写后复验与回滚均通过地点 Repository 转译为目录操作，物理根索引不得被完整数组覆盖。
- “审阅提案”是世界架构页内的全屏工具工作面。左侧按提案和文件组织队列，右侧使用项目已依赖的开源 Monaco `DiffEditor` 展示只读差异，并支持并排和行内两种模式。
- 用户可以逐文件选择接受或拒绝。已应用、已拒绝和冲突文件保留在提案清单中作为可审阅记录，不因操作完成而删除快照。
- 应用前必须重新读取正式目标并与 before 快照比较。正式文件不存在、意外已存在或内容变化时将该文件标记为阻断冲突，不允许用过期提案覆盖人工编辑。
- 应用前必须解析所有选中 JSON，并使用最终组合结果校验层级类型、空间节点、模板和设置索引引用。多文件写入中任一操作或提案审计状态更新失败时，Repository 必须按反序回滚已写文件。
- 选择性应用还必须闭合 `settings.json` 的文件依赖：最终索引引用的 Markdown 正文和词条 JSON 必须已经存在或包含在本次选择中；被选中的正文或词条文件也必须被最终索引引用。写入完成后、更新提案审计状态前，Repository 必须从磁盘重新加载并复验最终组合，失败时按原规则回滚，且不得覆盖未参与提案应用的外部修改。
- Agent 完整对话的初始消息必须在用户可编辑领域提示词之后追加平台控制的提案协议。项目提示词可以决定创作方法，不能关闭受控写回、路径限制、差异审阅和冲突保护。

## 16.1 统一提案审阅协议

- 所有需要 Agent 写入正式事实源的领域都遵循同一流程：`草稿 -> 领域校验 -> 待审提案 -> 作者逐项采纳、拒绝或删除 -> Repository 原子写入`。AI、页面组件和审阅器不得绕过领域 Repository 直接改写正式事实源。
- 提案审阅的通用契约为 `FileProposalRepository`：负责列出提案、投影逐项变更、应用、拒绝、删除、删除整份提案和解决单项冲突；`resolveConflict` 是必选能力，不完整的领域适配器不得接入统一审阅器。`WorldProposalReview` 是该契约的统一审阅工作面，统一提供提案队列、候选勾选、冲突状态、差异查看、批量处理和审计状态展示。
- 领域差异只能存在于适配器：领域 Repository 负责将候选投影成 `FileProposalChange`，校验目标事实源、处理引用闭合、实施回滚，并在写入后刷新提案状态。审阅器不拥有领域事实，也不解释业务规则。
- 冲突项必须提供三种明确处理：保留正式版本并将该候选标记为已拒绝；经二次确认后使用提案版本；打开三方合并窗口核对“生成基准 / 当前正式内容 / 提案内容”并编辑最终结果。覆盖或合并只能逐项执行，不能由批量应用隐式越过冲突。
- `FileProposalChange` 必须投影当前正式内容；`resolveConflict` 必须携带并再次比较 `expectedCurrentContent`，随后仍经过领域 Schema、引用闭合、原子写入和失败回滚。正式内容在审阅期间再次变化时必须中止并要求重新加载，不得应用旧的合并结果。
- 支持对象候选的领域应保存对象级生成基准。剧情提案 v4 为每个线路、故事弧、卷篇组目录和章节候选保存 `baseValue`，新增对象使用 `null`；章节候选完整包含其节与段规划，节和段不另建顶层提案。只有目标对象相对基准发生变化才判定冲突，无关对象或事实源元数据变化不得锁死整份提案。旧提案缺少对象级基准时保留兼容读取，但三方基准视图必须明确不可用，自动合并不得声称已可靠判断冲突字段。

| 领域     | 候选形态                                     | 领域应用器                                                | 审阅工作面                                               |
| -------- | -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| 世界架构 | 文件快照（before/after）                     | `NovelWorldProposalRepository`                            | `WorldProposalReview`                                    |
| 剧情工程 | 线路、故事弧、关键节点、卷篇组目录及章节候选 | `NarrativeProposalRepository`，通过文件变更适配器投影     | `WorldProposalReview`                                    |
| 势力组织 | 单势力对象候选                               | `NovelFactionProposalRepository`，通过文件变更适配器投影  | `WorldProposalReview`                                    |
| 时间线   | 单事件对象候选                               | `NovelTimelineProposalRepository`，通过文件变更适配器投影 | `WorldProposalReview`                                    |
| 人物库   | 人物、种族、分组、灵魂操作候选               | `NovelCharacterProposalRepository`                        | 领域预览包装；后续接入同一 `FileProposalRepository` 契约 |
| 物品库   | 同分类的物品批量候选                         | `NovelItemBatchProposalRepository`                        | 领域预览包装；后续接入同一 `FileProposalRepository` 契约 |

- 人物与物品的字段型预览可以作为统一审阅工作面的内容插槽或页面包装保留；不得因此复制第二套提案状态、选择、冲突或应用协议。新的提案领域必须先实现通用契约，再按需要提供领域预览。

## 17. 物品库与自定义字段

- 物品库是小说工作台独立一级模块，拥有单独导航入口；不得隐藏在设定库、知识库或地图内部。
- 物品分类采用可自由组织的树结构。每件物品必须关联一个主分类；跨分类维度使用标签表达，不允许一件物品同时套用多个分类字段方案。
- 项目保留稳定的“未分类”归宿。删除或归档分类不得使物品失去可解析的分类引用；非空分类必须先迁移物品或只做归档。
- 所有物品拥有不可删除的基础字段：稳定 ID、名称、别名、主分类、状态、标签、一句话摘要、封面或参考图路径、创建时间、更新时间和 Markdown 详细描述。
- 分类可以定义有序的自定义字段，并沿分类树向后代继承。字段使用稳定 `fieldId` 作为值键，显示名称不是身份；重命名字段不得改变已有值的关联。
- 自定义字段至少支持单行文本、多行文本、带可选单位的数字、单选、多选、开关、日期或故事时间文本、实体引用、项目内图片或附件引用。
- 字段定义保存名称、说明、分组、类型、是否必填、默认值、选项、单位、排序、来源分类和归档状态。子分类可以追加字段并调整本地展示顺序，但不得直接改变已有数据字段的类型或稳定 ID。
- 物品编辑页新增字段时必须明确选择“应用到当前分类”或“仅此物品”。分类字段对当前分类及其后代生效；物品字段只属于当前物品。
- 物品迁移分类、字段归档、分类方案变化均采用非破坏语义：不再适用但已经填写的值进入“保留字段”，允许审阅、迁移或恢复，不得静默删除。
- 已有数据的字段类型不能原地修改。需要改变类型时创建新字段并执行显式迁移；默认值变化只影响新物品或尚未填写的字段。
- 正式存储位于 `world/items/`：`meta.json` 保存分类树与字段定义，`index.json` 保存物品摘要和文件索引，`records/<item-id>.json` 保存基础字段与自定义字段值，`pages/<item-id>.md` 保存连续阅读的详细描述。图片和附件仍存放在 `assets/`，JSON 只保存项目内相对路径。
- 物品库 Repository 只能依赖绑定项目根目录的 `WorkbenchStorage`。保存必须使用 `expectedContent` 检测外部修改；新增物品先创建 record 与 Markdown，再登记 index，登记失败时回滚新文件。
- 已有小说只有旧版 `world/items/index.json` 时允许内存归一化；未经显式迁移操作不得在普通打开流程中静默重写用户文件。
- 主物品库使用“分类树 / 物品列表 / 物品详情”三栏工作面。详情分为“资料”和“描述”：资料展示基础字段、分类字段、仅此物品字段与保留字段；描述复用设定库的页面级可视化 Markdown 编辑器。
- 分类与字段管理是物品库内的全屏配置工作面，覆盖分类树、分类属性、字段方案、字段排序、归档和影响摘要；已有数据时字段类型控件必须锁定并解释原因。
- 物品 AI 使用工作台一次性生成能力，提供“完善资料”和“撰写描述”两个入口。模型只能基于当前物品、有效字段和已有描述生成候选；资料候选必须按字段类型与选项校验，描述候选必须是完整 Markdown。所有结果先进入可编辑、可逐项取消的预览，由作者确认后写入当前草稿，再通过物品库 Repository 保存；AI 不得直接修改项目文件。
- “AI 批量生产”复用 MyAgents 完整 Agent 会话和小说工作台受控工具集，交互方式与世界架构向导一致。Agent 必须先读取物品分类与字段上下文，在作者确认分类、数量和方向后校验整批候选，再写入 `world/items/proposals/<proposal-id>/proposal.json`；不得直接创建正式物品。作者在物品库提案审阅窗口逐件选择、拒绝或确认创建，确认创建必须通过物品库 Repository 原子更新 records、pages 与 index。

## 18. 势力组织

- 势力组织是小说工作台独立一级模块，位于人物库与世界架构之间；用于记录宗门、家族、帮派、商会、官方机构及其它长期行动主体。
- 正式事实源位于 `world/factions/`。`index.json` 当前使用 `schemaVersion: 2`、`storageVersion: 1`，只保存势力的有序 `{id,path}` 引用；每个势力的完整内容保存到 `records/<faction-id>.json`，包括稳定 ID、名称、类型、当前状态、状态快照、概要、地盘、成员、经营资产、争夺资源、组织单元、势力关系、权利与名分、跨库关联和创建/更新时间。
- 势力 Repository 必须递归读取根索引引用的全部记录，在内存中提供完整 `FactionLibrary`。保存使用整个目录的精确内容快照执行 CAS，在同一存储事务中先差量创建或更新记录、最后提交根索引；事务失败必须回滚已完成的文件操作，提交成功后再清理不被新索引引用的孤立记录。旧的内嵌数组单文件格式不兼容、不迁移。
- 势力地盘可以关联世界架构的空间节点，关联仅保存空间节点稳定 ID；也可以不关联，直接建立据点、辖区、城池或其它地盘说明。关联不存在或被调整时，势力记录不得被静默删除。
- 势力成员可以关联人物库的稳定角色 ID，也可以直接创建故事发展中的成员类别。未命名成员使用“打手”“帮众”等类别名称，并通过数量表达同类人物规模；命名人物和成员类别都必须保留职责与说明。
- 经营资产保存名称、类型、规模或收益和说明；争夺资源保存名称、资源类型、控制状态、控制权等级、关联地盘、关联物品、争夺势力和争夺历史。它们是势力视角的事实，不替代物品库或世界架构中的原始资料。
- 组织单元是势力内部的无环层级树，保存上级、名称、类型、可选负责人和说明；宗门堂口、王朝官署、商会分号、家族支脉都属于组织单元。独立势力之间的隶属、联盟、敌对、竞争和依附必须使用势力关系，不能伪装为内部组织节点。
- 势力关系保存目标势力、关系类型、方向、效力状态、起止时间和说明；方向性关系仅保存发起方的事实，对称关系同样只保存一个作者确认的关系条目，避免双向数据漂移。删除势力时必须解除其它势力的关系、授权方和资源争夺引用。
- 权利与名分保存类型、授予势力、适用地盘、范围、状态、起止时间和说明；默认类型包括法统、名分、辖权、通行权、采购权、贸易权、采矿权、税权和铸币权，也允许自定义类型。
- 势力当前状态快照包括治理、军事、经济、民望和领土完整度。历史变化的唯一时间事实仍由 `timeline/index.json` 事件承载：势力库仅按 `factionIds` 汇总展示事件，不反向修改时间线，也不复制一份可独立编辑的势力历史。
- 商路、战争、产业、人物、世界设定、物品与时间线事件通过跨库关联记录连接；关联仅保存稳定 ID（可用时）和作者可读标签，不反向修改任何目标资料库。
- 势力 AI 场景必须注册到模型场景设置：组织架构、势力关系、资源与产业、权限与法统、势力演化、势力批量设计。场景模型按“场景绑定 → 小说工作台默认模型 → 全局默认模型”解析。会话通过 `novel_factions_get_context` 按需读取目录聚合后的正式事实，`sourceHash` 必须覆盖根索引和全部被引用记录；提示词不得内嵌整份势力库。单势力 AI 只能围绕当前势力和直接关联对象生成可编辑建议，不得做全库 N×N 冲突分析或直接修改正式资料；批量设计必须先确认数量、类型和叙事目标，基于既有势力摘要生成待作者审核的候选卡，不得直接写入正式势力库。
- 势力提案必须通过文件变更适配器接入 `WorldProposalReview`，不得维护独立的卡片审批状态或应用协议。每个候选投影为 `world/factions/records/<faction-id>.json`；新建候选的对象级生成基准为 `null`，更新候选保存生成时读取的完整正式势力。应用、拒绝、删除和冲突合并均由势力 Repository 执行 Schema、跨库引用、CAS 与回滚；旧更新提案缺少对象基准时必须作为不可可靠自动判断的冲突处理。早期 AI 提案中的 `aliases`、`location`、`coreGoals`、`hierarchy`、`keyMembers`、`authority`、`evolutionHook` 仅是已由正式字段表达的预览辅助信息，兼容读取时不得写入正式势力记录，新提案校验必须拒绝这些非正式字段。
- 势力模块不得反向修改人物库和世界架构。关联只为创作检索与一致性提示服务，作者始终可以解除关联后保留势力内的自定义记录。

## 19. 灵感

- 灵感是独立素材库，用于保存尚未定稿的片段、意象、问题和研究触发点，不代表正文已经发生或设定已经确定。
- 正式事实源位于 `inspiration/`：`index.json` 使用 `schemaVersion: 1`、`storageVersion: 1`，只保存灵感的有序 `{id,path}` 引用和库更新时间；每条灵感的完整内容独立保存到 `records/<inspiration-id>.json`。Repository 在内存中聚合完整 `InspirationLibrary`，保存时比较整个灵感目录快照并差量写入变化记录，最后提交根索引；提交成功后清理不再被索引引用的孤立记录。旧单文件灵感库不兼容、不迁移。
- 每条灵感保存稳定 ID、标题、Markdown 正文、状态、来源、标签及创建/更新时间。状态只有收集箱、待整理、暂不使用和已归档。
- 灵感支持列表、看板、搜索、来源排序和状态筛选。不存在采用关系、规划对象、自定义类型或项目级自定义字段。
- 页面存在未保存草稿时，离开必须提供“保存并离开 / 放弃修改 / 继续编辑”三种明确选择。
- 灵感诊断、展开与深度共创均复用 MyAgents 完整会话；提示词只携带任务和灵感稳定 ID，正式内容通过小说工作台内置工具 `novel_inspiration_get_context` 按需读取。它们都只产生建议，不自动修改灵感、正文或其它项目数据。
- 新项目初始化 `inspiration/index.json` 与 `inspiration/records/` 目录，不再创建故事规划、旧大纲或规划自定义文件；打开既有项目时不会主动删除用户磁盘上的其它旧文件。

## 20. 剧情工程

- 剧情工程是小说工作台独立一级模块。它不是必须按顺序完成的向导，不要求作者依次规划线路、大纲和章节；正文、线路、故事弧、目录和章节计划均可独立创建并在任意阶段回填关联。
- 正式事实源位于 `narrative/`，领域 `schemaVersion` 为 `4`，目录 `storageVersion` 为 `1`。`index.json` 只保存更新时间、各类对象顺序和规范化 `{id,path}` 引用；线路、故事弧、卷篇组目录、章节计划与旧版剧情推演提案分别保存到 `lines/arcs/directories/chapters/simulation-proposals/records/<id>.json`。Repository 在内存中聚合完整剧情工程，保存时比较整个已读取目录快照并只写变化记录，根索引最后提交。JSON 仍是剧情规划的唯一事实源，SQLite、甘特图区间或其它分析视图不得保存第二份同义事实。
- `simulation-proposals` 仅保留旧版 AI 剧情路径记录的兼容审阅；它们接受后才由剧情工程生成可编辑章节计划。
- 线路、故事弧、卷篇组目录和章节计划可选保存 `simulationConstraint`：时间窗、必需/禁止事件或领域命令谓词、必需主体/地域和灵活度。该字段属于剧情工程自身的结构化设计，不由其它运行时模块反向修改。
- 数据所有权明确分为两层：卷、篇、组只负责目录组织；章、节、段负责正文规划和内容拆解。目录保存为自由引用树，章节归属一个目录或暂时未归类，节和段作为章节内部的嵌套数组保存。`01节`、`02节`、`01段`、`02段`等编号由当前排序动态生成，稳定 ID 不因拖动排序而变化。
- 卷只能位于根层；篇位于卷下；组可以位于卷、篇或其它组下并自由递归嵌套。卷、篇、组均可直接收纳章节。非空目录必须先移动子目录和章节后才能删除。
- 剧情工程内部顶部导航固定为“总览、线路、故事弧、大纲、章节、故事编排、叙事检查”。大纲页只管理卷、篇、组，采用目录树与目录详情两栏；章节页采用目录树、章节列表、章节详情三栏，默认显示所选目录及子目录章节，并允许切换为仅当前目录。
- 章节保存标题、说明、状态、正文关联、所属目录、线路和故事弧关联；章节内可以添加、删除、折叠和拖动排序多个节。节保存可选标题、长文本简述、视角人物、线路和故事弧关联，并拥有多个可拖动排序的段。段只保存长文本规划，不得出现线路、故事弧或人物关联字段。
- 正文仍以 `manuscript/index.json` 和 `manuscript/chapters/*.md` 为唯一事实源。章节规划通过稳定 `manuscriptChapterId` 可选关联正文，一篇正文最多关联一个章节规划；未关联正文和未关联规划都不阻止继续创作。修改或删除章节规划不得移动、改写或删除正文文件。
- 人物库以 `characters/library.json`、`characters/index.json`、`characters/records/<id>.json` 和 `characters/souls/` 为事实源。`library.json` 只保存种族、分组和未分组定义，`characters/index.json` 只保存人物可检索摘要，单角色详情独立保存；`characters/souls/index.json` 只保存灵魂顺序、名称、分类、内置状态和规范化记录路径，完整灵魂定义独立保存到 `characters/souls/records/<soul-id>.json`。Repository 在内存中聚合 `meta.souls` 供现有界面使用，保存时比较整个灵魂目录快照并差量写入记录，最后提交灵魂索引；旧 `library.json` 内嵌灵魂结构不兼容、不迁移。故事弧通过稳定 `characterId` 和 `characterArcStageId` 关联人物，并保存人物弧阶段标题快照用于人工核对；剧情工程不得反向覆盖人物小传、总弧光或弧阶段。人物不存在或角色弧阶段失效时只产生一致性提示，不自动删除作者的故事弧设计。
- 线路与故事弧的活动关联由章和节单向拥有，最细绑定层级是节，段不得关联。删除线路或故事弧时必须清理章、节和故事弧内部的相应引用；跨库人物或正文被删除时保留剧情记录并提示作者重新关联。
- “故事编排”是由章、节关联实时投影的甘特式泳道视图，不保存 `startChapter` 或 `endChapter`。横轴只显示全书章节序号；支持双头拖动选择起止章节，粒度为每格 `1~1000` 章，默认根据当前范围适配约 10 格。点击泳道色条弹出该格实际关联的章节列表，并下钻展示章级关联和命中的节级关联。
- “总览”只汇总目录、章、节、段数量、正文关联进度、线路和故事弧覆盖、未归类章节、诊断数量与最近编辑章节，不再编辑主题、母题或项目叙事摘要。主题、关键节拍、代价账本和因果图不再属于活动功能。
- “叙事检查”是非阻断式诊断面。目录循环、悬空目录或线路/故事弧引用、重复正文关联属于错误；未归类章节、章节没有节、节或段为空、跨库人物或正文失效属于警告或提示；线路存在异常长空档只作为可忽略提示。检查结果不得强迫作者补齐后才能保存。
- 旧的单文件 `narrative/index.json` 以及 `schemaVersion: 1`、`2`、`3` 数据不兼容、不迁移，也不得在普通加载时自动归档或改写。现有 `legacyArchive` 若已属于 v4 聚合，则独立保存在 `narrative/legacy/archive.json`。
- 页面存在未保存修改时，离开必须提供“保存并离开 / 放弃修改 / 继续编辑”三种明确选择。
- 剧情工程文本控件分为短文本和长叙事。名称与标题使用单行输入；目录说明、线路驱动、故事弧内在变化、章节说明、节简述和段规划使用可自动增高并可展开到大编辑窗口的长文本输入。展开编辑只修改当前页面 draft，不单独写盘，也不替代正文编辑器。
- 固定枚举继续使用轻量下拉；人物、正文、目录、线路和故事弧等稳定 ID 引用必须使用可搜索实体选择器。实体选择器支持名称、别名、编号和业务元数据搜索，角色额外支持拼音；多选不把全部候选项铺成标签墙，只显示选择摘要并在弹层中管理。
- 潜在超过 100 项的实体结果列表必须虚拟化，只渲染可见行；搜索、上下键、Enter、Escape、当前选中项可见性、结果计数、空结果和失效引用状态属于基础交互，不得因当前测试项目数据较少而省略。选择器始终保存稳定 ID，展示名称、别名、章节路径和类型说明均为派生内容。
- 剧情工程 AI 使用模型场景 `narrative.assist`，复用 MyAgents 的完整 Agent Session。启动消息只携带当前视图、线路、故事弧、目录、章节的稳定 ID、任务和作者要求，不携带剧情、人物、正文事实或页面草稿；Agent 按需读取 `novel_narrative_get_context` 及其它小说工作台内置读取工具，并输出“发现 / 原因 / 建议动作 / 影响范围”。大纲页的“AI 规划目录”预选卷、篇、组结构规划任务；作者要求实际创建或调整大纲时，AI 必须使用目录候选，不得创建同名故事弧或章节候选冒充目录。目录候选保存父目录、类型、标题、规划说明、状态和顺序，父目录可引用同一草稿候选或已有稳定 ID。“章节与节规划”预选章节创建任务，必须生成章节候选；每个章节候选完整保存目录归属、章级线路/故事弧、至少一个节以及节内可选段规划，章和节可关联线路/故事弧，段不关联。作者明确要求创建线路、故事弧、卷篇组目录或章节与节时，AI 必须先读取已保存事实取得 `sourceHash`，再创建剧情草稿并写入对应候选；线路和故事弧候选必须包含至少一个关键节点，完成校验后提交到 `narrative/proposals/<proposal-id>/proposal.json`。补充既有对象时，候选必须携带既有对象的 `targetId`；更新章节时，保留的节和段也必须携带各自 `targetId`，以维持稳定关联。提案在剧情工程中直接复用 `WorldProposalReview` 逐项审阅；采纳时仍由剧情领域 Repository 使用目录快照 CAS 更新对应正式记录与根索引，AI 不得直接写入正式事实源。页面存在未保存草稿或 sourceHash 已失效时禁止提交，避免覆盖作者编辑。当前受控写入可以创建或改写章节、节和段规划，但不创建、覆盖或删除正文 Markdown；新章节的 `manuscriptChapterId` 默认为 `null`，更新章节时保持原正文关联不变。
- 小说工作台 Agent 可以一次性看到完整内置工具表，并根据任务自主选择时间线、剧情、人物、世界、物品、灵感或修行体系的上下文读取工具；不得为了遍历模块而机械调用全部工具。上下文事实原则上由工具按需读取，启动消息不得序列化完整项目快照、设定库、时间线、剧情或页面草稿；只保留任务引导、范围约束和稳定目标标识。七类事实读取工具允许跨会话领域调用，草稿、校验和提交工具仍只允许当前会话所属领域执行。
