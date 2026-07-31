export const MANUSCRIPT_VERSION_SCHEMA_VERSION = 1;
export const DEFAULT_MANUSCRIPT_VERSION_LIMIT = 20;
export const MIN_MANUSCRIPT_VERSION_LIMIT = 1;
export const MAX_MANUSCRIPT_VERSION_LIMIT = 200;

export type ManuscriptVersionSource =
  | "manual-save"
  | "ai-apply"
  | "restore";

export interface ManuscriptVersionRecord {
  readonly schemaVersion: typeof MANUSCRIPT_VERSION_SCHEMA_VERSION;
  readonly versionId: string;
  readonly chapterId: string;
  readonly chapterTitle: string;
  readonly content: string;
  readonly wordCount: number;
  readonly createdAt: string;
  readonly source: ManuscriptVersionSource;
}

export interface ManuscriptVersionSettings {
  readonly schemaVersion: typeof MANUSCRIPT_VERSION_SCHEMA_VERSION;
  readonly maxVersions: number;
}

export function normalizeManuscriptVersionLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MANUSCRIPT_VERSION_LIMIT;
  return Math.min(
    MAX_MANUSCRIPT_VERSION_LIMIT,
    Math.max(MIN_MANUSCRIPT_VERSION_LIMIT, Math.round(parsed)),
  );
}

export function parseManuscriptVersionSettings(
  content: string,
): ManuscriptVersionSettings {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("设置必须是 JSON 对象");
    }
    const raw = parsed as Record<string, unknown>;
    return Object.freeze({
      schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
      maxVersions: normalizeManuscriptVersionLimit(raw.maxVersions),
    });
  } catch {
    return Object.freeze({
      schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
      maxVersions: DEFAULT_MANUSCRIPT_VERSION_LIMIT,
    });
  }
}

export function serializeManuscriptVersionSettings(
  settings: ManuscriptVersionSettings,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
      maxVersions: normalizeManuscriptVersionLimit(settings.maxVersions),
    },
    null,
    2,
  )}\n`;
}

export function parseManuscriptVersion(
  content: string,
): ManuscriptVersionRecord | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const raw = parsed as Record<string, unknown>;
    if (
      typeof raw.versionId !== "string" ||
      typeof raw.chapterId !== "string" ||
      typeof raw.content !== "string" ||
      typeof raw.createdAt !== "string"
    ) {
      return null;
    }
    const source =
      raw.source === "ai-apply" || raw.source === "restore"
        ? raw.source
        : "manual-save";
    return Object.freeze({
      schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
      versionId: raw.versionId,
      chapterId: raw.chapterId,
      chapterTitle:
        typeof raw.chapterTitle === "string" ? raw.chapterTitle : "",
      content: raw.content,
      wordCount:
        typeof raw.wordCount === "number" && Number.isFinite(raw.wordCount)
          ? raw.wordCount
          : Array.from(raw.content).filter((character) => !/\s/u.test(character))
              .length,
      createdAt: raw.createdAt,
      source,
    });
  } catch {
    return null;
  }
}
