import { z } from "zod";

import type { WorkbenchModelSelection } from "@/workbench-sdk";

export const MODEL_SCENE_SETTINGS_SCHEMA_VERSION = 1 as const;
export const MODEL_SCENE_SETTINGS_PATH = "settings/ai-model-scenes.json";

export const MODEL_SCENE_IDS = [
  "world.architecture",
  "world.template",
  "world.assist",
  "items.profile",
  "items.description",
  "items.batch",
  "characters.design",
  "characters.relationship",
  "characters.soul",
  "characters.race",
  "characters.group",
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
