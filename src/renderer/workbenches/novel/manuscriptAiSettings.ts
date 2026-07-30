import { z } from "zod";

export const MANUSCRIPT_AI_SETTINGS_PATH = "settings/manuscript-ai.json";

export const manuscriptAiPresentationSchema = z.enum([
  "compact-review",
  "full-dialog",
]);

export const manuscriptAiSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    presentation: manuscriptAiPresentationSchema,
  })
  .strict();

export type ManuscriptAiSettings = z.infer<typeof manuscriptAiSettingsSchema>;
export type ManuscriptAiPresentation = z.infer<
  typeof manuscriptAiPresentationSchema
>;

export function createDefaultManuscriptAiSettings(): ManuscriptAiSettings {
  return { schemaVersion: 1, presentation: "compact-review" };
}

export function parseManuscriptAiSettings(
  path: string,
  content: string,
): ManuscriptAiSettings {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${path} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = manuscriptAiSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${path} 格式错误：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return parsed.data;
}

export function serializeManuscriptAiSettings(
  settings: ManuscriptAiSettings,
): string {
  return `${JSON.stringify(manuscriptAiSettingsSchema.parse(settings), null, 2)}\n`;
}
