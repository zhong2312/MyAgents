export const IMAGE_UNDERSTANDING_TOOL_ID = 'image-understanding' as const;

export type OfficialToolId = typeof IMAGE_UNDERSTANDING_TOOL_ID;

export interface ImageUnderstandingToolSettings {
  providerId?: string;
  model?: string;
}

export type ImageUnderstandingCapabilityConfidence = 'declared' | 'inferred' | 'unknown';

export type ImageUnderstandingCapabilitySource =
  | 'provider'
  | 'preset'
  | 'custom'
  | 'discovered'
  | 'litellm';

export interface ImageUnderstandingModelOption {
  providerId: string;
  providerName: string;
  model: string;
  modelName: string;
  capabilityConfidence: ImageUnderstandingCapabilityConfidence;
  capabilitySource?: ImageUnderstandingCapabilitySource;
}

export interface OfficialToolSettings {
  imageUnderstanding?: ImageUnderstandingToolSettings;
}

export interface OfficialToolDefinition {
  id: OfficialToolId;
  name: string;
  description: string;
  badge: 'CLI';
  cliGroup: 'vision';
  requiresConfig: boolean;
}

export const OFFICIAL_TOOLS: readonly OfficialToolDefinition[] = [
  {
    id: IMAGE_UNDERSTANDING_TOOL_ID,
    name: '图片理解',
    description: '使用已配置的多模态模型分析图片，帮助文本主模型看懂截图、照片和图表。',
    badge: 'CLI',
    cliGroup: 'vision',
    requiresConfig: true,
  },
] as const;

const OFFICIAL_TOOL_ID_SET = new Set<string>(OFFICIAL_TOOLS.map(tool => tool.id));

export function isOfficialToolId(value: unknown): value is OfficialToolId {
  return typeof value === 'string' && OFFICIAL_TOOL_ID_SET.has(value);
}

export function normalizeOfficialToolIds(value: unknown): OfficialToolId[] {
  if (!Array.isArray(value)) return [];
  const ids: OfficialToolId[] = [];
  const seen = new Set<OfficialToolId>();
  for (const item of value) {
    if (!isOfficialToolId(item) || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function isImageUnderstandingToolConfigured(
  settings: OfficialToolSettings | undefined,
): boolean {
  const providerId = settings?.imageUnderstanding?.providerId?.trim();
  const model = settings?.imageUnderstanding?.model?.trim();
  return Boolean(providerId && model);
}

/**
 * Read only an offering row's explicit image-input declaration.
 *
 * `undefined` is intentional: historical/custom model rows commonly omit
 * `inputModalities`, and an empty/invalid list carries no capability evidence.
 * Callers must not collapse that unknown state into explicit text-only.
 */
export function getExplicitImageInputSupport(
  model: { inputModalities?: unknown } | null | undefined,
): boolean | undefined {
  if (!model || !Array.isArray(model.inputModalities)) return undefined;
  const modalities = model.inputModalities
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim().toLowerCase());
  if (modalities.length === 0) return undefined;
  return modalities.includes('image');
}

/**
 * Product policy for an explicitly selected image-understanding helper model:
 * unknown rows remain selectable (saving is the user's confirmation), while an
 * offering that explicitly excludes image input remains unavailable.
 */
export function isImageUnderstandingModelSelectable(
  model: { inputModalities?: unknown } | null | undefined,
): boolean {
  if (!model) return false;
  return getExplicitImageInputSupport(model) !== false;
}
