# 小说叙事工程工作台

> 状态：已实现。本文记录叙事设计、灵感和创作方案三个工作面的事实源、解析规则与 owner 边界。

## 目标与范围

小说工作台提供题材中立的叙事工程内核，让不同类型小说复用同一组稳定对象：

- 结构单元：部、卷、幕、案件、人生阶段或作者自定义层级；
- 叙事线路：主线、支线、人物线、关系线、调查线或主题线；
- 故事弧：任意数量的状态阶段及其结构、章节锚点；
- 叙事节点：场景、节拍、转折、信息揭示与章节节点；
- 期待：承诺、悬念、谜团、伏笔、预言及其建立、强化、兑现和失效；
- 章节计划：连接叙事对象、正文章节和方案交付字段；
- 检查项：可来源于创作方案，也可由作者在具体对象上自定义。

当前范围不包含旧项目导入、外部模板下载、项目 JavaScript、运行时注入 React 组件或自动改写正文。`outline/outline.md` 继续作为自由大纲事实源，结构化模块不替代它。

## Owner 边界

正式事实文件固定为：

```text
story/narrative-design.json
inspiration/index.json
settings/creative-profile.json
```

- `story/narrative-design.json` 拥有结构、线路、故事弧、节点、期待、章节计划和对象关系。
- `inspiration/index.json` 拥有项目灵感副本及 `adopted-as` 采用记录。灵感是否“已采用”只由采用记录推导，不持久化第二份状态。
- `settings/creative-profile.json` 拥有创作方案层、声明式定义和显式覆盖规则。
- `outline/outline.md` 仍由原大纲 Repository 保存。
- 正文章节的 ID、序号和标题仍由既有章节 Repository 拥有；章节计划只保存稳定引用和计划信息。
- 验收结果、搜索结果、已采用状态和解析后的创作定义都是派生投影，不建立第四份事实源。

三个新 Repository 只依赖绑定当前项目根目录的 `WorkbenchStorage`，不得直接导入 Tauri API、Sidecar、Chat 或宿主文件服务。

## 数据协议

三份 JSON 当前均为 `schemaVersion: 1`，使用 Zod 严格解析。ID 使用小写字母、数字、点、下划线和连字符。

### 叙事对象

对象关系保存 `fromKind/fromId` 与 `toKind/toId`，并显式区分：

- `planned`：作者计划中的锚点；
- `actual`：已经发生的故事事实。

删除对象时必须解除所有直接引用，不得留下只能靠标题猜测的悬空关系。结构父级必须存在且不得形成循环；父级选择器排除自身和全部后代，审查器仍会检查外部手改 JSON 造成的循环。

故事弧阶段数量不固定。每个阶段可以独立关联结构和正文章节。章节计划关联线路、故事弧和期待，并保存由当前创作方案声明的交付字段值。

### 检查项

检查项状态为 `pending`、`passed` 或 `waived`。`waived` 必须填写 `waiverReason`，格式校验会阻止保存无原因的豁免。

方案中 `category=check` 的定义按 `scope` 投影到对应对象。对象尚未接入方案检查时，验收页显示“未执行”；接入后通过 `sourceDefinitionId` 保持来源追溯。方案停用后已经填写的检查记录仍保留，并显示来源已停用建议，不静默删除作者结果。

### 灵感采用

一条灵感可以有多个采用记录。采用记录保存目标对象稳定引用、采用类型、显示快照、说明和时间。删除采用记录只改变派生的“已采用”状态，不改写灵感正文；删除灵感时一并删除其采用记录。

## 创作方案解析

默认层级为：

```text
通用叙事内核
-> 篇幅配置
-> 发布方式
-> 题材配置
-> 创作方法（可选）
-> 项目规则
-> 作者调整
```

启用层按 `order` 从上到下解析。定义支持：

- `define`：创建新的稳定定义；
- `extend`：以新稳定 ID 扩展已经解析的定义；
- `override`：显式覆盖已有定义。

直接重复稳定 ID 是阻断冲突。`override` 必须复用目标稳定 ID，并保持类别、作用对象和字段类型不变，避免已有章节交付值失去映射。覆盖可以改变显示名称、说明、选项和是否必填。

配置只声明术语、对象类型、字段、关系、检查项和视图。它不执行项目代码。项目专属概念必须位于项目规则层，不得硬编码到通用内核或 React 组件。

章节字段支持单行文本、多行文本、数字、开关、单选和多选控件。底层仍保存字符串值，以保持 v1 JSON 协议稳定；多选按换行分隔，选项被移除时已有值继续可见。

## 保存与外部修改

首次打开旧项目且文件不存在时，Repository 通过 `createText(..., { createParents: true })` 创建空事实文件；并发创建失败后重新读取，不覆盖另一写者。

每次保存都执行以下流程：

1. 更新时间并通过 Zod 序列化；
2. 使用上次读取的完整正文作为 `expectedContent`；
3. 调用 `WorkbenchStorage.writeText` 原子写入；
4. 以写入结果更新内存 baseline。

Workspace watcher 发现外部变化时重新读取。没有本地修改则更新视图；存在本地草稿时保留草稿并显示冲突，用户必须显式选择载入磁盘版本。普通读取不会为了补默认字段而静默重写文件。

## 工作面

叙事设计使用结构、内容、详情三栏：

- 结构树支持任意层级和折叠；
- 线路使用 CSS Grid 泳道，画布只在内部横向滚动；
- 故事弧按当前最大阶段数动态生成列；
- 章节计划使用语义表格；
- 验收按来源层分组；
- 自由大纲复用 `MarkdownVisualEditor`。

灵感提供收集箱、待整理、已采用、未采用、已归档，支持列表、看板、搜索和排序。创作方案提供层级、解析定义和影响三栏，并提供只读临时题材预览。

移动端把三栏转为“结构/内容/详情”分步导航。线路、故事弧、表格和看板的横向滚动必须限制在内容容器内，页面本身不得产生横向溢出。

## GitHub 调研与取舍

实现前按功能分别调研了以下开源项目：

| 功能 | 调研项目 | 采用结论 |
| --- | --- | --- |
| 长篇结构与章节管理 | [novelWriter](https://github.com/vkbo/novelWriter)、[Manuskript](https://github.com/olivierkes/manuskript) | 采用项目树、场景/章节元数据与写作正文分离的思路，不复制其桌面数据模型。 |
| 线路与关系画布 | [React Flow](https://github.com/xyflow/xyflow) | 参考节点选择与可平移画布交互；v1 泳道是规则表格，CSS Grid 更直接，不为它新增图编辑依赖。 |
| 排序与密集表格 | [dnd-kit](https://github.com/clauderic/dnd-kit)、[TanStack Table](https://github.com/TanStack/table) | 数据协议保留显式 `order`；当前交互不需要拖拽和复杂列状态，使用原生语义表格。 |
| 灵感看板 | [Focalboard](https://github.com/mattermost-community/focalboard)、[AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)、[Logseq](https://github.com/logseq/logseq) | 采用收集、整理、采用关系和派生状态分离；不建立全局块数据库。 |
| 自由大纲编辑 | [MDXEditor](https://github.com/mdx-editor/editor) | 复用仓库已经封装的 `MarkdownVisualEditor`，不创建第二套编辑器。 |
| 配置与校验 | [Zod](https://github.com/colinhacks/zod)、[cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)、[ESLint](https://github.com/eslint/eslint)、[JSON Schema](https://github.com/json-schema-org/json-schema-spec) | 采用声明式层、稳定 ID、确定性合并和阻断冲突；复用现有 Zod，不允许配置执行 JavaScript。 |

## 扩展约束

- 新题材只增加或调整创作方案定义，不创建题材专属工作台分支。
- 新字段先确定稳定 ID 和 owner；显示名称不是身份。
- 新检查项必须声明作用对象和来源层，不得只在 UI 写死提示文本。
- 新关系必须继续区分计划与事实。
- 新派生视图不得反向成为事实源。
- 导入功能单独设计迁移、预览和确认协议；不得把导入逻辑塞进普通打开流程。

