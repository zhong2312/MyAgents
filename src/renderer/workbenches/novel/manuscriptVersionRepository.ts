import type { WorkbenchStorage } from "@/workbench-sdk";

import type { LoadedNovelChapter } from "./repository";
import {
  DEFAULT_MANUSCRIPT_VERSION_LIMIT,
  MANUSCRIPT_VERSION_SCHEMA_VERSION,
  normalizeManuscriptVersionLimit,
  parseManuscriptVersion,
  parseManuscriptVersionSettings,
  serializeManuscriptVersionSettings,
  type ManuscriptVersionRecord,
  type ManuscriptVersionSettings,
  type ManuscriptVersionSource,
} from "./manuscriptVersionSchema";

const SETTINGS_PATH = "settings/manuscript-version.json";
const VERSION_ROOT = "manuscript/versions";

function createVersionId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `version-${Date.now().toString(36)}-${random.toLowerCase()}`;
}

function versionPath(chapterId: string, versionId: string): string {
  return `${VERSION_ROOT}/${chapterId}/${versionId}.json`;
}

function sortVersions(versions: readonly ManuscriptVersionRecord[]) {
  return [...versions].sort((left, right) => {
    const time = right.createdAt.localeCompare(left.createdAt);
    return time || right.versionId.localeCompare(left.versionId);
  });
}

export interface ManuscriptVersionRepository {
  loadSettings(): Promise<ManuscriptVersionSettings>;
  saveSettings(maxVersions: number): Promise<ManuscriptVersionSettings>;
  prune(chapterId: string): Promise<void>;
  list(chapterId: string): Promise<readonly ManuscriptVersionRecord[]>;
  create(
    chapter: Pick<LoadedNovelChapter, "id" | "title">,
    content: string,
    source?: ManuscriptVersionSource,
  ): Promise<ManuscriptVersionRecord>;
  restore(
    chapter: Pick<LoadedNovelChapter, "id" | "title" | "content">,
    target: ManuscriptVersionRecord,
    saveCurrent: (
      content: string,
      expectedContent: string,
    ) => Promise<void>,
  ): Promise<void>;
}

export function createManuscriptVersionRepository(
  storage: WorkbenchStorage,
): ManuscriptVersionRepository {
  const ensureSettings = async (): Promise<ManuscriptVersionSettings> => {
    const [info] = await storage.stat([SETTINGS_PATH]);
    if (!info?.exists) {
      const settings = Object.freeze({
        schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
        maxVersions: DEFAULT_MANUSCRIPT_VERSION_LIMIT,
      });
      await storage.createText(
        SETTINGS_PATH,
        serializeManuscriptVersionSettings(settings),
        { createParents: true },
      );
      return settings;
    }
    return parseManuscriptVersionSettings(
      (await storage.readText(SETTINGS_PATH)).content,
    );
  };

  const repository: ManuscriptVersionRepository = {
    async loadSettings() {
      return ensureSettings();
    },

    async saveSettings(maxVersions) {
      const next = Object.freeze({
        schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
        maxVersions: normalizeManuscriptVersionLimit(maxVersions),
      });
      const [info] = await storage.stat([SETTINGS_PATH]);
      const content = serializeManuscriptVersionSettings(next);
      if (info?.exists) {
        await storage.writeText(SETTINGS_PATH, content);
      } else {
        await storage.createText(SETTINGS_PATH, content, { createParents: true });
      }
      const chapterEntries = await storage.list(VERSION_ROOT).catch(() => []);
      await Promise.all(
        chapterEntries
          .filter((entry) => entry.kind === "directory")
          .map((entry) => repository.prune(entry.name)),
      );
      return next;
    },

    async list(chapterId) {
      const directory = `${VERSION_ROOT}/${chapterId}`;
      const entries = await storage.list(directory).catch(() => []);
      const files = entries.filter((entry) => entry.kind === "file");
      const versions = await Promise.all(
        files.map(async (entry) =>
          parseManuscriptVersion((await storage.readText(entry.path)).content),
        ),
      );
      return Object.freeze(
        sortVersions(
          versions.filter(
            (item): item is ManuscriptVersionRecord =>
              item !== null && item.chapterId === chapterId,
          ),
        ),
      );
    },

    async prune(chapterId) {
      const settings = await ensureSettings();
      const versions = await repository.list(chapterId);
      await Promise.all(
        versions.slice(settings.maxVersions).map((item) =>
          storage.remove(versionPath(chapterId, item.versionId), {
            permanent: true,
          }),
        ),
      );
    },

    async create(chapter, content, source = "manual-save") {
      await ensureSettings();
      const version: ManuscriptVersionRecord = Object.freeze({
        schemaVersion: MANUSCRIPT_VERSION_SCHEMA_VERSION,
        versionId: createVersionId(),
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        content,
        wordCount: Array.from(content).filter((character) => !/\s/u.test(character))
          .length,
        createdAt: new Date().toISOString(),
        source,
      });
      await storage.createText(
        versionPath(chapter.id, version.versionId),
        `${JSON.stringify(version, null, 2)}\n`,
        { createParents: true },
      );
      await repository.prune(chapter.id);
      return version;
    },

    async restore(chapter, target, saveCurrent) {
      if (target.chapterId !== chapter.id) throw new Error("版本不属于当前章节");
      await this.create(chapter, chapter.content, "restore");
      await saveCurrent(target.content, chapter.content);
    },
  };
  return Object.freeze(repository);
}
