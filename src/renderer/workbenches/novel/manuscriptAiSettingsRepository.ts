import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createDefaultManuscriptAiSettings,
  MANUSCRIPT_AI_SETTINGS_PATH,
  parseManuscriptAiSettings,
  serializeManuscriptAiSettings,
  type ManuscriptAiSettings,
} from "./manuscriptAiSettings";

export interface LoadedManuscriptAiSettings {
  readonly settings: ManuscriptAiSettings;
  readonly content: string;
}

export function createManuscriptAiSettingsRepository(
  storage: WorkbenchStorage,
) {
  const load = async (): Promise<LoadedManuscriptAiSettings> => {
    const [info] = await storage.stat([MANUSCRIPT_AI_SETTINGS_PATH]);
    if (info?.exists) {
      const file = await storage.readText(MANUSCRIPT_AI_SETTINGS_PATH);
      return {
        settings: parseManuscriptAiSettings(file.path, file.content),
        content: file.content,
      };
    }
    const content = serializeManuscriptAiSettings(
      createDefaultManuscriptAiSettings(),
    );
    try {
      const file = await storage.createText(
        MANUSCRIPT_AI_SETTINGS_PATH,
        content,
        { createParents: true },
      );
      return { settings: createDefaultManuscriptAiSettings(), content: file.content };
    } catch {
      const file = await storage.readText(MANUSCRIPT_AI_SETTINGS_PATH);
      return {
        settings: parseManuscriptAiSettings(file.path, file.content),
        content: file.content,
      };
    }
  };

  return Object.freeze({
    load,
    async save(
      current: LoadedManuscriptAiSettings,
      settings: ManuscriptAiSettings,
    ): Promise<LoadedManuscriptAiSettings> {
      const content = serializeManuscriptAiSettings(settings);
      const file = await storage.writeText(
        MANUSCRIPT_AI_SETTINGS_PATH,
        content,
        { expectedContent: current.content },
      );
      return { settings, content: file.content };
    },
  });
}
