import { z } from "zod";

import type { WorkbenchModelSelection } from "@/workbench-sdk";

export const MODEL_SCENE_SETTINGS_SCHEMA_VERSION = 1 as const;
export const MODEL_SCENE_SETTINGS_PATH = "settings/ai-model-scenes.json";

export const MODEL_SCENE_IDS = [
  "world.architecture",
  "world.template",
  "world.assist",
  "maps.fantasy",
  "narrative.assist",
  "timeline.assist",
  "manuscript.generate",
  "manuscript.continue",
  "manuscript.revise",
  "manuscript.expand",
  "manuscript.continuity",
  "manuscript.quality",
  "manuscript.outlineExtract",
  "manuscript.brainstorm.agent1",
  "manuscript.brainstorm.agent2",
  "manuscript.brainstorm.agent3",
  "manuscript.brainstorm.agent4",
  "manuscript.brainstorm.agent5",
  "manuscript.brainstorm.agent6",
  "manuscript.brainstorm.synthesis",
  "manuscript.simulation.agent1",
  "manuscript.simulation.agent2",
  "manuscript.simulation.agent3",
  "manuscript.simulation.agent4",
  "manuscript.simulation.agent5",
  "manuscript.simulation.agent6",
  "cultivation.assist",
  "cultivation.module",
  "inspiration.assist",
  "inspiration.coauthor",
  "items.profile",
  "items.description",
  "items.batch",
  "characters.design",
  "characters.relationship",
  "characters.soul",
  "characters.race",
  "characters.group",
  "factions.organization",
  "factions.relations",
  "factions.resources",
  "factions.rights",
  "factions.history",
  "factions.batch",
  "simulation.actor",
  "simulation.world",
  "simulation.resolve",
  "simulation.report",
  "simulation.council",
  "simulation.epoch-narration",
] as const;

export type NovelModelSceneId = (typeof MODEL_SCENE_IDS)[number];
export type ModelSceneExecution = "agent" | "run";

export interface NovelModelSceneDefinition {
  readonly id: NovelModelSceneId;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly execution: ModelSceneExecution;
}

export const NOVEL_MODEL_SCENES: readonly NovelModelSceneDefinition[] = [
  {
    id: "world.architecture",
    group: "世界架构",
    label: "世界架构向导",
    description: "AI 创建世界",
    execution: "agent",
  },
  {
    id: "world.template",
    group: "世界架构",
    label: "模板配置向导",
    description: "AI 配置模板",
    execution: "agent",
  },
  {
    id: "world.assist",
    group: "世界架构",
    label: "单项 AI 写作",
    description: "设定页、层级与空间节点辅助",
    execution: "agent",
  },
  {
    id: "narrative.assist",
    group: "剧情工程",
    label: "剧情工程共创",
    description: "分析线路、故事弧、章节和叙事检查，并提出可审阅建议",
    execution: "agent",
  },
  {
    id: "maps.fantasy",
    group: "世界地图",
    label: "Agent + Azgaar 地图生成",
    description: "读取世界架构并调用 Azgaar 生成待作者审阅的地图提案",
    execution: "agent",
  },
  {
    id: "timeline.assist",
    group: "时间线",
    label: "时间线推演与校验",
    description: "分析时间序列、纪元、分支、伏笔与叙事揭示顺序",
    execution: "agent",
  },
  {
    id: "manuscript.generate",
    group: "正文写作",
    label: "完整生成",
    description: "根据章节规划和上下文生成完整正文候选",
    execution: "run",
  },
  {
    id: "manuscript.continue",
    group: "正文写作",
    label: "续写",
    description: "沿当前光标或正文结尾继续写作",
    execution: "run",
  },
  {
    id: "manuscript.revise",
    group: "正文写作",
    label: "润色与改写",
    description: "处理选区或当前章节全文",
    execution: "run",
  },
  {
    id: "manuscript.expand",
    group: "正文写作",
    label: "扩写",
    description: "扩展选区或当前章节并保持情节不越界",
    execution: "run",
  },
  {
    id: "manuscript.continuity",
    group: "正文写作",
    label: "连续性提取",
    description: "提取时间线、人物状态、关系、物品与未闭合线索候选",
    execution: "run",
  },
  {
    id: "manuscript.quality",
    group: "正文写作",
    label: "正文质量检查",
    description: "检查章节计划完成度、连续性、人物声线、节奏与章尾钩子",
    execution: "run",
  },
  {
    id: "manuscript.outlineExtract",
    group: "正文写作",
    label: "正文提炼剧情工程",
    description: "从已完成正文提炼剧情章节、节拍和实际内容",
    execution: "run",
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((number) => ({
    id: `manuscript.brainstorm.agent${number}` as NovelModelSceneId,
    group: "AI 脑暴室",
    label: `脑暴 Agent ${number}`,
    description: "围绕总控锁定的完整方案提交会诊意见与专业设计贡献",
    execution: "run" as const,
  })),
  {
    id: "manuscript.brainstorm.synthesis",
    group: "AI 脑暴室",
    label: "脑暴总控 Agent",
    description: "主持会诊、建立方案契约并整合审计完整正文方案",
    execution: "run",
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((number) => ({
    id: `manuscript.simulation.agent${number}` as NovelModelSceneId,
    group: "AI 剧情推演室",
    label: `推演 Agent ${number}`,
    description: "独立推演人物行动、规则碰撞与后续剧情分支",
    execution: "run" as const,
  })),
  {
    id: "cultivation.assist",
    group: "修行体系",
    label: "修行体系共创",
    description: "读取本源、轨道、资源、法门、能力与约束，提出可审阅的体系建议",
    execution: "agent",
  },
  {
    id: "cultivation.module",
    group: "修行体系",
    label: "修行模块完善",
    description: "针对当前修行模块和选中对象生成可应用字段补全",
    execution: "run",
  },
  {
    id: "inspiration.assist",
    group: "灵感",
    label: "灵感诊断与展开",
    description: "通过小说工作台工具读取灵感并提供可发展的方向",
    execution: "agent",
  },
  {
    id: "inspiration.coauthor",
    group: "灵感",
    label: "灵感深度共创",
    description: "通过工作台工具读取当前灵感的完整 MyAgents 会话",
    execution: "agent",
  },
  {
    id: "characters.design",
    group: "人物库",
    label: "角色设计",
    description: "人物库 AI 设计",
    execution: "agent",
  },
  {
    id: "characters.relationship",
    group: "人物库",
    label: "关系与弧光设计",
    description: "角色关系与剧情弧光",
    execution: "agent",
  },
  {
    id: "characters.soul",
    group: "人物库",
    label: "角色灵魂设计",
    description: "角色灵魂库设计",
    execution: "agent",
  },
  {
    id: "characters.race",
    group: "人物库",
    label: "种族设计",
    description: "种族库设计",
    execution: "agent",
  },
  {
    id: "characters.group",
    group: "人物库",
    label: "角色分组设计",
    description: "角色分组管理设计",
    execution: "agent",
  },
  {
    id: "factions.organization",
    group: "势力组织",
    label: "组织架构设计",
    description: "宗门、王朝、商会与家族的内部层级",
    execution: "agent",
  },
  {
    id: "factions.relations",
    group: "势力组织",
    label: "势力关系设计",
    description: "隶属、联盟、敌对、竞争与依附关系",
    execution: "agent",
  },
  {
    id: "factions.resources",
    group: "势力组织",
    label: "资源与产业设计",
    description: "资源控制权、商路与争夺历史",
    execution: "agent",
  },
  {
    id: "factions.rights",
    group: "势力组织",
    label: "权限与法统设计",
    description: "法统、名分、通行权与采购权",
    execution: "agent",
  },
  {
    id: "factions.history",
    group: "势力组织",
    label: "势力演化梳理",
    description: "势力状态变化与时间线事件梳理",
    execution: "agent",
  },
  {
    id: "factions.batch",
    group: "势力组织",
    label: "势力批量设计",
    description: "批量设计势力组织与叙事定位",
    execution: "agent",
  },
  {
    id: "items.profile",
    group: "物品库",
    label: "完善物品资料",
    description: "一次性生成资料候选",
    execution: "run",
  },
  {
    id: "items.description",
    group: "物品库",
    label: "撰写物品描述",
    description: "一次性生成 Markdown 描述",
    execution: "run",
  },
  {
    id: "items.batch",
    group: "物品库",
    label: "物品批量生产",
    description: "批量物品设计对话",
    execution: "agent",
  },
  {
    id: "simulation.actor",
    group: "世界推演",
    label: "主体决策",
    description: "角色与势力的下一步行动判断",
    execution: "run",
  },
  {
    id: "simulation.world",
    group: "世界推演",
    label: "世界响应",
    description: "规则、环境与外部势力响应",
    execution: "run",
  },
  {
    id: "simulation.resolve",
    group: "世界推演",
    label: "冲突裁定",
    description: "规则碰撞与行动结果裁定",
    execution: "run",
  },
  {
    id: "simulation.report",
    group: "世界推演",
    label: "推演报告",
    description: "事件流与状态变化摘要",
    execution: "run",
  },
  {
    id: "simulation.council",
    group: "世界推演",
    label: "圆桌会商",
    description: "多角色代表逐轮发言与投票",
    execution: "run",
  },
  {
    id: "simulation.epoch-narration",
    group: "世界推演",
    label: "纪元叙事",
    description: "将长尺度聚合状态整理为可追溯叙事",
    execution: "run",
  },
] as const;

const modelSceneBindingSchema = z
  .object({
    providerId: z.string().trim().min(1),
    model: z.string().trim().min(1),
  })
  .strict();

const modelSceneSettingsSchema = z
  .object({
    schemaVersion: z.literal(MODEL_SCENE_SETTINGS_SCHEMA_VERSION),
    defaultModel: modelSceneBindingSchema.optional(),
    bindings: z.record(z.string(), modelSceneBindingSchema),
  })
  .strict();

export interface ModelSceneSettings {
  readonly schemaVersion: typeof MODEL_SCENE_SETTINGS_SCHEMA_VERSION;
  readonly defaultModel?: WorkbenchModelSelection;
  readonly bindings: Readonly<Record<string, WorkbenchModelSelection>>;
}

export function createDefaultModelSceneSettings(): ModelSceneSettings {
  return Object.freeze({
    schemaVersion: MODEL_SCENE_SETTINGS_SCHEMA_VERSION,
    defaultModel: undefined,
    bindings: Object.freeze({}),
  });
}

export function parseModelSceneSettings(
  path: string,
  content: string,
): ModelSceneSettings {
  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `模型场景配置无法解析：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const parsed = modelSceneSettingsSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`模型场景配置格式无效：${path}`);
  }
  return Object.freeze({
    schemaVersion: MODEL_SCENE_SETTINGS_SCHEMA_VERSION,
    ...(parsed.data.defaultModel
      ? {
          defaultModel: Object.freeze({
            providerId: parsed.data.defaultModel.providerId,
            model: parsed.data.defaultModel.model,
          }),
        }
      : {}),
    bindings: Object.freeze(
      Object.fromEntries(
        Object.entries(parsed.data.bindings).map(([sceneId, selection]) => [
          sceneId,
          Object.freeze({
            providerId: selection.providerId,
            model: selection.model,
          }),
        ]),
      ),
    ),
  });
}

export function serializeModelSceneSettings(
  settings: ModelSceneSettings,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: MODEL_SCENE_SETTINGS_SCHEMA_VERSION,
      ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
      bindings: settings.bindings,
    },
    null,
    2,
  )}\n`;
}

export function getModelSceneBinding(
  settings: ModelSceneSettings,
  sceneId: NovelModelSceneId,
): WorkbenchModelSelection | undefined {
  return settings.bindings[sceneId];
}

export function getEffectiveModelSceneSelection(
  settings: ModelSceneSettings,
  sceneId: NovelModelSceneId,
): WorkbenchModelSelection | undefined {
  return getModelSceneBinding(settings, sceneId) ?? settings.defaultModel;
}
