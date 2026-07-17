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

小说工作台的标识为 `io.myagents.novel`，当前使用 Workbench API `1.3`。

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
  -> 填写小说名称、保存位置、目录名、题材和目标字数
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

- Markdown：承载需要连续阅读和人工编辑的内容，如正文、大纲、故事核心、世界观和研究笔记。
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
|   `-- chapters/
|       `-- .gitkeep
|-- outline/
|   |-- outline.md
|   |-- volumes.json
|   |-- plotlines.json
|   |-- volumes/
|   |   `-- .gitkeep
|   `-- scenes/
|       `-- .gitkeep
|-- story/
|   |-- core.md
|   `-- themes.md
|-- characters/
|   `-- index.json
|-- world/
|   |-- worldview.md
|   |-- power-system.md
|   |-- rules.json
|   |-- locations/
|   |   `-- index.json
|   |-- factions/
|   |   `-- index.json
|   |-- items/
|   |   `-- index.json
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
|   `-- codex/
|       `-- index.json
|-- timeline/
|   |-- events.json
|   |-- foreshadowing.json
|   `-- facts.json
|-- research/
|   |-- index.json
|   `-- notes/
|       `-- .gitkeep
|-- knowledge/
|   |-- entities.json
|   |-- relations.json
|   `-- facts.json
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
  "status": "planning",
  "language": "zh-CN",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

约束：

- `genres` 至少一项、允许多选、不得重复。
- `targetWordCount` 保存实际字数，不保存“万”单位值。
- `status` 为 `planning | writing | completed | paused`。
- 旧项目的单值 `genre` 和 `form` 字段只用于兼容读取；新项目不再写入。

### 6.2 章节协议

- 章节正文位于 `manuscript/chapters/`。
- 文件名使用六位数字，例如 `000001.md`。
- 章节 ID 使用同一编号，例如 `chapter-000001`。
- `manuscript/index.json` 是章节顺序、状态和路径的结构化索引。
- `nextChapterNumber` 必须大于已有的最大章节编号。
- 章节 ID、编号和路径必须一一对应且不得重复。

### 6.3 知识图谱事实源

- `knowledge/entities.json`：稳定实体 ID、类型、名称、别名和来源。
- `knowledge/relations.json`：实体之间带类型、方向和来源的关系。
- `knowledge/facts.json`：可验证事实、有效范围、来源和冲突状态。
- `timeline/facts.json`：强调时间有效性的故事事实，可投影到知识图谱。

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

- 小说名称；
- 保存位置；
- 项目目录名；
- 题材多选；
- 目标字数，界面单位为“万字”。

已确认的交互：

- 题材使用分组标签布局，当前包含 14 组、73 个选项，并支持跨组多选。
- 默认选中“玄幻”，多选摘要显示选中数量。
- 题材弹层通过 Portal 挂载，可以超出弹窗边界；弹层内部独立滚动，不得让弹窗因为下拉展开出现纵向滚动条。
- 目标字数默认 100 万字，允许小数万字，提交时转换为实际字数并取整。
- 小说工作台左侧导航默认显示为 64px 图标栏，用户可以通过顶部图标按钮展开或再次收起。
- 不显示“初始结构”选择。
- 不显示“初始化 Git”开关，初始化蓝图固定 `initializeGit: false`。

## 9. 版本与兼容性

- Workbench manifest 使用 `manifestVersion: 1`。
- 小说工作台当前版本为 `0.3.0`。
- 宿主 API 兼容范围当前固定为 `1.3`。
- 项目文件使用各自的 `schemaVersion`，当前为 `1`。
- 读取旧格式时可以做内存归一化，但未经明确迁移操作不得静默重写用户文件。
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

1. 完善人物、世界观、大纲、时间线和资料的领域 Repository，仍只依赖 `WorkbenchStorage`。
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

## 13. 设定库编辑与独立地图模块

- 设定库使用“空间节点 → 必选层级类型 → 类型默认设定模板 + 节点自定义设定”模型，不再使用固定的 15 类、82 节点结构。
- 空间树由作者自由组织。每个空间节点必须关联一个 `LevelType`，但类型的建议父子关系只用于新建提示，不得阻止作者保存幻想世界中的非标准层级。
- 元配置由 `LevelType`、`SettingTemplate` 和 `LevelTypeSettingProfile` 组成。层级类型、Markdown 页面模板、类型与模板关联均为项目级可配置数据。
- 默认模板不是允许列表。任何节点始终可以新增自定义设定，例如宇宙节点可以额外创建“水系”页面。
- 类型默认页面采用惰性落盘：未编辑时只根据模板形成虚拟页面，首次编辑或新增词条时才创建 Markdown 正文和词条 JSON。
- 修改节点类型、修改模板、移除类型模板关联或归档类型时，不得删除、覆盖或重置已经落盘的正文与词条；不再匹配当前默认方案的页面保留为节点设定。
- 选中任一设定页面后，“内容”页签以占满内容区的可视化 Markdown 编辑器呈现；“词条”页签保存名称、分类、别名和定义。Markdown 始终是连续说明的事实源，富文本 HTML 不得落盘。
- 不再使用“取自真实”“架空改造”“冲突优先级”“作用域继承”“结构”“关系”等旧版编辑字段或页签。知识图谱由 Markdown、词条、空间树和其他项目事实派生，不反向替代正文。
- 正式存储位于 `world/setting-library/`：`meta.json` 保存元配置，`spatial-tree.json` 保存空间树，`settings.json` 保存已落盘页面索引，`pages/<node-id>/*.md` 保存正文，`entries/<node-id>/*.json` 保存词条。
- 地图是小说工作台的独立一级模块，拥有单独导航入口；不得作为设定库侧栏、设定页签或编辑器内嵌面板出现。
- 地图模块独立负责世界结构、大陆与星球投影、多元或平行宇宙拓扑、地图图层、时间切片和空间约束检查。
- Agent 生成地图时可以读取设定库 Markdown 和知识图谱作为输入，但地图产物独立保存，不能把派生结果自动回写到设定文档正文。

## 14. 小说工作台 AI 与提示词模块

- 提示词管理是小说工作台范围内的独立一级模块，与世界架构、模板配置、地图等模块平级；不得隐藏在某个世界构建向导、Agent 小窗或设定页面内部。
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
- 小型 AI 功能必须通过 Workbench Host AI 接口执行，并复用统一的 Agent 运行信息小窗。小窗只显示运行投影和候选结果，可以停止任务或展开到完整对话。
- 工作台 Tab 继续不隐式持有 Sidecar。只有用户明确发起大型对话或小型生成请求时，宿主才创建或绑定显式 Agent Session owner。
- `novel.world.guide` 是首个正式执行入口。“AI 创建世界”必须先解析当前启用集；缺失、停用或同 ID 多副本冲突时阻止请求。解析成功后由 Workbench API 1.3 打开绑定小说目录的 MyAgents Chat Tab。
- Workbench API 1.3 打开带初始消息的 Chat Tab 前，MyAgents 宿主必须解析并冻结当前可用的 Provider/Model 或外部 Runtime Model；项目或 Agent 中失效、停用、缺少凭据的旧 Provider 配置不得进入首次自动发送。系统没有可用模型服务时必须在创建 Sidecar 前返回明确错误。
- 项目级提示词覆盖继续使用 Git 友好的 Markdown + JSON；平台安全协议、工具策略和输出校验规则不可被项目覆盖。

## 15. 提示词持久化协议

- `prompts/registry.json` 是提示词结构化事实源，当前 `schemaVersion` 为 `1`。它保存安装副本、目录树、提示词元数据、作用域、启停状态、来源身份与 Markdown 相对路径，不保存提示词正文。
- 提示词正文独立保存在 `prompts/installations/<installation-id>/content/**/*.md`。来自技能包的提示词保持 manifest 内容根目录下的原始相对路径；项目内新建提示词写入该安装副本的 `_local/` 目录。
- 注册表磁盘字段使用领域正式名称：技能包副本为 `installationId`，稳定提示词标识为 `promptId`，副本内实例为 `instanceId`。同一个 `promptId` 可以存在于多个安装副本中，但 `instanceId` 与 `contentPath` 在项目内必须唯一。
- 每个安装副本必须且只能拥有一个根分组；目录父子关系不得跨安装副本或形成循环；提示词只能关联同一安装副本内的目录。
- 新小说初始化时复制一套可编辑的 `StoryForge 小说提示词库` 安装副本。当前快照来自 StoryForge `3.7.5`，包含 89 个 Markdown 提示词：40 个通用模板默认启用，49 个题材模板保留来源中的默认停用状态。
- 默认包目录固定映射为 `prompts/general/**` 与 `prompts/genre-packs/<genre>/**`；题材目录通过小说工作台的中文题材集合声明作用域，系统提示词、用户模板、变量、参数、示例、模型覆盖和来源文件统一写入 Markdown。
- 默认包是项目初始化材料，不是某一部测试小说的专用数据。每次新建小说都会把注册表、目录树和 89 份 Markdown 复制到该小说根目录，复制后与内置快照解耦并允许作者修改。
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
- 允许的目标严格限制为设定库 `meta.json`、`spatial-tree.json`、`settings.json`、`pages/<node-id>/<setting-id>.md` 和 `entries/<node-id>/<setting-id>.json`；禁止提案修改小说目录中的其它文件或递归修改 proposals。
- “审阅提案”是世界架构页内的全屏工具工作面。左侧按提案和文件组织队列，右侧使用项目已依赖的开源 Monaco `DiffEditor` 展示只读差异，并支持并排和行内两种模式。
- 用户可以逐文件选择接受或拒绝。已应用、已拒绝和冲突文件保留在提案清单中作为可审阅记录，不因操作完成而删除快照。
- 应用前必须重新读取正式目标并与 before 快照比较。正式文件不存在、意外已存在或内容变化时将该文件标记为阻断冲突，不允许用过期提案覆盖人工编辑。
- 应用前必须解析所有选中 JSON，并使用最终组合结果校验层级类型、空间节点、模板和设置索引引用。多文件写入中任一操作或提案审计状态更新失败时，Repository 必须按反序回滚已写文件。
- 选择性应用还必须闭合 `settings.json` 的文件依赖：最终索引引用的 Markdown 正文和词条 JSON 必须已经存在或包含在本次选择中；被选中的正文或词条文件也必须被最终索引引用。写入完成后、更新提案审计状态前，Repository 必须从磁盘重新加载并复验最终组合，失败时按原规则回滚，且不得覆盖未参与提案应用的外部修改。
- Agent 完整对话的初始消息必须在用户可编辑领域提示词之后追加平台控制的提案协议。项目提示词可以决定创作方法，不能关闭受控写回、路径限制、差异审阅和冲突保护。
