# 世界推演叙事规则与修炼转折设计

日期：2026-08-21
状态：待书面确认
适用范围：小说工作台世界推演、修炼生态与运行存储

## 1. 目标

世界推演首先服务于故事演变，而不是模拟资源余额、经济或数值成长。本阶段把“发生了什么、人物经历了什么、哪些关系或抉择改变了角色”变成可追溯的运行状态；修炼突破只是这些叙事状态满足条件后的一个世界结果。

本阶段交付：结构化叙事里程碑、正式事实投影、修炼转折规则、确定性候选裁定、离散故事状态、规则命中与拒绝审计，以及基线和轮次重放。

## 2. 明确非目标

本阶段不实现资源数量、余额、消耗、产出、交易、市场、经济指标、经验值、概率成功、随机失败、品质比较、伤势数值、环境数值、寿命数值、数值阈值或数值副作用。也不从自然语言、正文或模型输出自动猜测硬规则，不自动写回正式资料。

模型只能提交结构化候选，不能创建未声明的事实、自由文本里程碑或直接修改运行状态。

## 3. 不变量

1. 时间线事实、章节事实和修炼资料各自保持 authority，运行只保存不可变投影。
2. 每个叙事里程碑必须有稳定 ID，并有正式来源或作者确认的结构化命令。
3. 自然语言不是可执行合同；缺少机器规则时不能猜测角色应当转折。
4. 世界与修炼硬规则先于模型叙述、剧情偏好和软目标。
5. 相同基线、状态、命令集合和排序必须得到相同故事状态、命中、拒绝和哈希。
6. 新规则只能读写离散故事字段，不得读写 resources 或其他数值成长字段。

## 4. 架构与边界

正式时间线和章节事实，加上修炼机器字段，经过 NarrativeRuleCompiler 形成冻结规则与里程碑快照；结构化经历和转折候选交给 RuleArbiter，输出离散故事事实、境界转折或结构化拒绝。

worldSimulationProjection 只编译快照和诊断；worldSimulationRules 提供纯函数 Schema、编译器和裁定器；worldSimulationCore 处理命令顺序、原子提交和审计；Repository 只负责持久化；UI 只展示快照和构造候选。内核不读取正式 Repository、正文或 UI 草稿。

## 5. 修炼领域机器声明

现有修炼存储不新增平行规则目录。体系记录可选保存 narrativeMilestones；progression track 内显式突破 transition 可选保存 simulationRule；ordered 轨道没有显式 transition 时，目标 level 可选保存 simulationBreakthroughRule。体系级 transition 与 branching、cyclic、free 轨道不隐式推导。

修炼 schemaVersion 6 保持不变，新增字段均可选；旧文件缺少字段表示没有可执行叙事规则，不迁移、不批量补默认路径。

叙事里程碑字段：id、name、summary、category 和 satisfiedBy。category 只允许 trial、choice、revelation、relationship、loss、achievement。satisfiedBy 为空表示只能由运行中的结构化里程碑命令达成；非空时只能引用已确认的时间线或章节事实，不能引用 planned、author-secret 或 simulated。引用失效或事实列表为空属于基线阻断诊断。

突破规则字段：schemaVersion、status、enabled、requiredMethodIds、requiredAbilityIds、forbiddenActiveConstraintIds 和 requiredNarrativeMilestoneIds。status 只有 approved；模型生成的规则候选必须先经作者审阅。描述性 conditions、breakthroughConditions、successRule 和 failureResult 只用于阅读，不参与执行。规则没有资源、数量、概率、阈值或数值副作用字段。

路径编译顺序固定为：显式 breakthrough transition 优先；无显式 transition 时仅 ordered 轨道允许按 order 推导相邻境界；branching、cyclic、free 轨道必须显式声明。同一层级对存在多个启用规则时产生歧义诊断。

## 6. 运行快照

基线新增 rules、narrativeMilestones 和 ruleCompilationSummary，全部进入 worldSimulationBaselineHash。旧运行缺字段时按空集合或全零摘要读取，新基线始终显式写入。

每个运行里程碑快照包含 id、systemId、name、summary、category、initiallySatisfied 和 sourceRefs。规则快照只保存可执行 WorldRuleDefinition；ruleSources 继续保存不可执行文本来源。没有机器规则但存在描述性突破条件时产生未编译警告；禁用规则只计入 disabledCount。

人物运行态新增 narrativeMilestoneIds，是按 ID 排序的离散集合，不是分值、计数器或经验条。初始值来自正式事实投影；当前分支接受里程碑后只增不减，撤销必须从旧轮边界创建分支。

第一版 WorldRuleDefinition 只允许 hard-boundary、cultivation-character、command、cultivation.breakthrough；效果只有设置目标境界；条件只有当前体系、轨道、境界、必需功法、必需能力、禁止活动约束和 narrative-milestone.all。Schema 使用严格判别联合，未知字段和 kind 拒绝编译。规则 ID 由体系、轨道、起止境界和来源实体的规范化哈希派生；条件、来源和读写集合按稳定键排序；优先级固定为 100。

## 7. 候选命令与同刻顺序

新增 character.narrative-milestone 命令，字段为 commandId、actorId、milestoneId 和 effectiveAt；新增 cultivation.breakthrough 命令，字段为 commandId、actorId、targetSystemId、targetTrackId、targetLevelId 和 effectiveAt。

WorldSimulationRoundInput 必须显式携带冻结的 rules 和 narrativeMilestones；它们不写入可变 state。命令只能引用冻结目录中的稳定 ID，没有自由文本标题或任意 tag。

同一 effectiveAt 固定按：通用 Schema、时间窗、命令 ID、人物存在和存活；记录叙事里程碑；裁定修炼转折；写入故事事件和审计。这样“经历试炼后突破”可在同轮成立，且不依赖命令字典序。重复里程碑、死亡人物、错误体系或路径、缺少前置都确定性拒绝；失败不改变任何人物离散状态。

## 8. 审计与界面

每次规则评估生成 WorldSimulationRuleHit，包含稳定 ID、commandId、effectiveAt、ruleId、accepted 或 rejected、每项条件结果、实际效果和 sourceRefs。规则拒绝必须给出具体缺失经历或替代路径；无匹配规则使用 cultivation.breakthrough.rule-required。命中记录进入轮边界、JSONL 账本和分支历史，不依赖当前资料重新推断。

第 0 轮摘要显示已编译规则、里程碑总数、初始达成数、未编译来源、禁用规则和阻断诊断。候选编辑器提供“记录经历”和“修炼转折”：只从冻结目录提供目标，允许提交前置不满足候选供内核审计拒绝，不在 UI 私自判断。修炼生态工作台使用实体选择器编辑里程碑和转折规则，不要求作者维护裸 ID。

## 9. 兼容与验收

旧修炼 v6、旧 baseline、旧 state 缺少新字段时按空集合读取，旧命令保持原语义；新命令缺少冻结规则或目录时拒绝。正式资料变化只影响新基线，旧运行继续使用自己的快照。

固定夹具至少包含一名人物、两条里程碑、一条由正式章节事实满足的前置、一条需运行确认的前置和一条批准突破规则。验收覆盖正式事实投影、同刻里程碑后突破、缺失经历、重复经历、死亡人物拒绝、规则与故事事件跨 baseline、轮边界、账本和分支重放，以及重复输入得到相同哈希；测试明确断言没有资源读取、扣除或数值演变。

## 10. 后续扩展

后续优先扩展剧情工程硬护栏、人物关系转折、势力事件、旅行消息传播和生命周期代际。每次扩展都必须明确事实来源、封闭条件与效果联合、同刻优先级、审计与重放测试，不以数值系统替代故事因果。
