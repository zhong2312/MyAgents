/**
 * 小说工作台全部 AI 场景的 promptId 注册表。
 *
 * 工作台各场景默认使用内置提示词（构建在 renderer/aiAssist 模块中）；
 * 用户在提示词管理器中以相同 promptId 创建并启用自定义提示词后，
 * 该场景将改用自定义模板（通过 {{projectName}}/{{genres}}/{{requirement}}
 * 等变量渲染），未自定义时自动回退内置提示词，默认行为不变。
 */
export interface NovelPromptScene {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export const NOVEL_PROMPT_SCENES: readonly NovelPromptScene[] = Object.freeze([
  {
    id: "novel.world.guide",
    name: "世界架构向导",
    description: "多轮对话引导创建世界架构与区域地点；模板配置模式共用该场景。",
  },
  {
    id: "novel.manuscript.generate",
    name: "正文·完整生成",
    description: "以大纲与设定为基础完整生成一个章节的候选正文。",
  },
  {
    id: "novel.manuscript.continue",
    name: "正文·续写",
    description: "从当前章节光标处续写后续内容。",
  },
  {
    id: "novel.manuscript.revise",
    name: "正文·润色",
    description: "在保持情节事实的前提下润色选中范围。",
  },
  {
    id: "novel.manuscript.expand",
    name: "正文·扩写",
    description: "扩展选中范围，补充细节与过程。",
  },
  {
    id: "novel.manuscript.continuity",
    name: "正文·连续性检查",
    description: "对照已应用的正文追踪事实检查当前章节的一致性。",
  },
  {
    id: "novel.manuscript.quality",
    name: "正文·质量评审",
    description: "对当前章节做质量评审并给出修改建议。",
  },
  {
    id: "novel.manuscript.outlineExtract",
    name: "正文·提炼剧情",
    description: "把已写正文提炼为剧情工程章节规划（含分节）。",
  },
  {
    id: "novel.manuscript.brainstorm",
    name: "正文·脑暴会议",
    description: "多 Agent 脑暴当前章节的走向、钩子与冲突方案。",
  },
  {
    id: "novel.narrative.assist",
    name: "剧情工程助手",
    description: "读取剧情工程并提交线路/故事弧/目录/章节规划提案。",
  },
  {
    id: "novel.timeline.assist",
    name: "时间线推演助手",
    description: "校验与推演时间线事件，提交待审阅的事件提案。",
  },
  {
    id: "novel.inspiration.coauthor",
    name: "灵感共创",
    description: "只读共创会话：讨论、追问与建议，不修改任何项目数据。",
  },
  {
    id: "novel.inspiration.assist",
    name: "灵感诊断与展开",
    description: "灵感诊断或发展建议，不写回灵感库。",
  },
  {
    id: "novel.characters.assist",
    name: "人物库设计",
    description: "设计角色、关系、灵魂、种族与分组，提交人物库提案。",
  },
  {
    id: "novel.factions.assist",
    name: "势力组织设计",
    description: "完善当前势力的组织、关系、资源与权限，提交势力提案。",
  },
  {
    id: "novel.factions.batch",
    name: "势力批量设计",
    description: "一次设计多个势力并提交批量势力提案。",
  },
  {
    id: "novel.items.batch",
    name: "物品批量设计",
    description: "一次设计多件物品并提交物品批量提案。",
  },
  {
    id: "novel.cultivation.assist",
    name: "修炼体系逻辑共创",
    description: "共创修炼体系资产并提交修行生态提案。",
  },
]);

export function findNovelPromptScene(
  promptId: string,
): NovelPromptScene | null {
  return NOVEL_PROMPT_SCENES.find((scene) => scene.id === promptId) ?? null;
}
