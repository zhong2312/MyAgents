import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createDefaultModelSceneSettings,
  MODEL_SCENE_SETTINGS_PATH,
  parseModelSceneSettings,
  serializeModelSceneSettings,
  type ModelSceneSettings,
} from "./modelSceneSettings";

export interface LoadedModelSceneSettings {
  readonly settings: ModelSceneSettings;
  readonly content: string;
}

export interface NovelModelSceneSettingsRepository {
  load(): Promise<LoadedModelSceneSettings>;
  save(
    current: LoadedModelSceneSettings,
    settings: ModelSceneSettings,
  ): Promise<LoadedModelSceneSettings>;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

export function createNovelModelSceneSettingsRepository(
  storage: WorkbenchStorage,
): NovelModelSceneSettingsRepository {
  const load = async (): Promise<LoadedModelSceneSettings> => {
    if (!storage.isAvailable) {
      throw new Error("模型场景设置仅在 MyAgents 桌面端可用");
    }
    const defaultSettings = createDefaultModelSceneSettings();
    const file = await ensureTextFile(
      storage,
      MODEL_SCENE_SETTINGS_PATH,
      serializeModelSceneSettings(defaultSettings),
    );
    return Object.freeze({
      settings: parseModelSceneSettings(MODEL_SCENE_SETTINGS_PATH, file.content),
      content: file.content,
    });
  };

  return Object.freeze({
    load,
    async save(
      current: LoadedModelSceneSettings,
      settings: ModelSceneSettings,
    ) {
      const content = serializeModelSceneSettings(settings);
      const parsed = parseModelSceneSettings(MODEL_SCENE_SETTINGS_PATH, content);
      const file = await storage.writeText(MODEL_SCENE_SETTINGS_PATH, content, {
        expectedContent: current.content,
      });
      return Object.freeze({
        settings: parsed,
        content: file.content,
      });
    },
  });
}
