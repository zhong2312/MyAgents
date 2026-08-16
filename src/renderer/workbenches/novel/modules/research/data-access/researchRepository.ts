import {
  ensureWorkbenchTextFile,
  type WorkbenchStorage,
} from "@/workbench-sdk";

export const RESEARCH_PATHS = Object.freeze({
  index: "research/index.json",
  notes: "research/notes",
  trash: "research/trash",
  trashIndex: "research/trash/index.json",
});

export interface ResearchSourceRecord {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface ResearchTrashRecord {
  readonly id: string;
  readonly originalPath: string;
  readonly trashPath: string;
  readonly title: string;
  readonly deletedAt: string;
}

export interface LoadedResearchSource extends ResearchSourceRecord {
  readonly exists: boolean;
  /** 当前会话加载到的磁盘快照，用于保存和移入回收站前的并发校验。 */
  readonly diskContent: string | null;
}

export interface LoadedResearchTrash extends ResearchTrashRecord {
  readonly exists: boolean;
}

export interface LoadedResearchLibrary {
  readonly sources: readonly LoadedResearchSource[];
  readonly indexContent: string;
  readonly trash: readonly LoadedResearchTrash[];
  readonly trashContent: string;
}

export interface LoadedResearchDocument {
  readonly source: LoadedResearchSource;
  readonly content: string;
}

interface ResearchIndex {
  readonly schemaVersion: 1;
  readonly sources: readonly ResearchSourceRecord[];
}

interface ResearchTrashIndex {
  readonly schemaVersion: 1;
  readonly items: readonly ResearchTrashRecord[];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pathId(path: string): string {
  let hash = 2166136261;
  for (const character of path) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `research-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function fileTitle(path: string, content = ""): string {
  const heading = content.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  if (heading) return heading;
  return path.split("/").at(-1)?.replace(/\.md$/iu, "") || "未命名资料";
}

function parseDate(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : fallback;
}

function parseIndex(content: string): ResearchIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new Error(
      `资料库索引无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("资料库索引必须是 JSON 对象");
  }
  const values = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(values)) throw new Error("资料库索引缺少 sources 数组");
  const now = new Date().toISOString();
  const sources = values.flatMap((value): ResearchSourceRecord[] => {
    if (typeof value === "string") {
      const path = value.trim();
      return path.endsWith(".md")
        ? [{ id: pathId(path), path, title: fileTitle(path), createdAt: now }]
        : [];
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path || !path.endsWith(".md")) return [];
    return [
      {
        id:
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : pathId(path),
        path,
        title:
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : fileTitle(path),
        createdAt: parseDate(item.createdAt, now),
      },
    ];
  });
  const seen = new Set<string>();
  return {
    schemaVersion: 1,
    sources: sources.filter((source) => {
      if (seen.has(source.path)) return false;
      seen.add(source.path);
      return true;
    }),
  };
}

function parseTrashIndex(content: string): ResearchTrashIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause) {
    throw new Error(
      `资料库回收站索引无法解析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("资料库回收站索引必须是 JSON 对象");
  }
  const values = (raw as { items?: unknown }).items;
  if (!Array.isArray(values))
    throw new Error("资料库回收站索引缺少 items 数组");
  const items = values.flatMap((value): ResearchTrashRecord[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.originalPath !== "string" ||
      typeof item.trashPath !== "string" ||
      typeof item.title !== "string"
    )
      return [];
    return [
      {
        id: item.id,
        originalPath: item.originalPath,
        trashPath: item.trashPath,
        title: item.title,
        deletedAt: parseDate(item.deletedAt, new Date().toISOString()),
      },
    ];
  });
  return { schemaVersion: 1, items };
}

async function listMarkdown(storage: WorkbenchStorage, directory: string) {
  const entries = await storage.list(directory);
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      result.push(...(await listMarkdown(storage, entry.path)));
    } else if (entry.path.toLowerCase().endsWith(".md")) {
      result.push(entry.path);
    }
  }
  return result;
}

function freezeLibrary(
  sources: readonly LoadedResearchSource[],
  indexContent: string,
  trash: readonly LoadedResearchTrash[],
  trashContent: string,
): LoadedResearchLibrary {
  return Object.freeze({
    sources: Object.freeze([...sources]),
    indexContent,
    trash: Object.freeze([...trash]),
    trashContent,
  });
}

export function createResearchRepository(storage: WorkbenchStorage) {
  const load = async (): Promise<LoadedResearchLibrary> => {
    if (!storage.isAvailable) throw new Error("资料库存储仅在桌面端可用");
    const [indexFile, trashFile] = await Promise.all([
      ensureWorkbenchTextFile(
        storage,
        RESEARCH_PATHS.index,
        json({ schemaVersion: 1, sources: [] }),
      ),
      ensureWorkbenchTextFile(
        storage,
        RESEARCH_PATHS.trashIndex,
        json({ schemaVersion: 1, items: [] }),
      ),
    ]);
    const index = parseIndex(indexFile.content);
    const trashIndex = parseTrashIndex(trashFile.content);
    const [activePaths, trashPaths] = await Promise.all([
      listMarkdown(storage, "research"),
      listMarkdown(storage, RESEARCH_PATHS.trash),
    ]);
    const activePathSet = new Set(
      activePaths.filter(
        (path) => !path.startsWith(`${RESEARCH_PATHS.trash}/`),
      ),
    );
    const trashPathSet = new Set(trashPaths);
    const activeContentByPath = new Map(
      await Promise.all(
        [...activePathSet].map(async (path) => {
          const file = await storage.readText(path);
          return [path, file.content] as const;
        }),
      ),
    );
    const now = new Date().toISOString();
    const indexedByPath = new Map(
      index.sources.map((source) => [source.path, source]),
    );
    const sources: LoadedResearchSource[] = index.sources.map((source) => ({
      ...source,
      exists: activePathSet.has(source.path),
      diskContent: activeContentByPath.get(source.path) ?? null,
    }));
    for (const path of activePathSet) {
      if (indexedByPath.has(path)) continue;
      const content = activeContentByPath.get(path) ?? "";
      sources.push({
        id: pathId(path),
        path,
        title: fileTitle(path, content),
        createdAt: now,
        exists: true,
        diskContent: content,
      });
    }
    const trash = trashIndex.items.map((item) => ({
      ...item,
      exists: trashPathSet.has(item.trashPath),
    }));
    return freezeLibrary(sources, indexFile.content, trash, trashFile.content);
  };

  const writeIndex = async (
    library: LoadedResearchLibrary,
    sources: readonly ResearchSourceRecord[],
  ) => {
    const persistedSources = sources.map(({ id, path, title, createdAt }) => ({
      id,
      path,
      title,
      createdAt,
    }));
    return storage.writeText(
      RESEARCH_PATHS.index,
      json({ schemaVersion: 1, sources: persistedSources }),
      { expectedContent: library.indexContent },
    );
  };

  const saveIndex = async (
    library: LoadedResearchLibrary,
    sources: readonly ResearchSourceRecord[],
  ): Promise<LoadedResearchLibrary> => {
    const file = await writeIndex(library, sources);
    return load().then((next) =>
      freezeLibrary(next.sources, file.content, next.trash, next.trashContent),
    );
  };

  const saveTrash = async (
    library: LoadedResearchLibrary,
    items: readonly ResearchTrashRecord[],
  ): Promise<LoadedResearchLibrary> => {
    const file = await storage.writeText(
      RESEARCH_PATHS.trashIndex,
      json({ schemaVersion: 1, items }),
      { expectedContent: library.trashContent },
    );
    return load().then((next) =>
      // 保留调用方加载时的活动索引基线。不能用 load() 的最新索引替换
      // 它，否则外部修改会被误当成当前会话的 CAS 基线。
      freezeLibrary(
        library.sources,
        library.indexContent,
        next.trash,
        file.content,
      ),
    );
  };

  return Object.freeze({
    load,
    async loadSource(
      source: LoadedResearchSource,
    ): Promise<LoadedResearchDocument> {
      const file = await storage.readText(source.path);
      return Object.freeze({
        source: { ...source, exists: true, diskContent: file.content },
        content: file.content,
      });
    },
    async createSource(library: LoadedResearchLibrary, title: string) {
      const normalized = title.trim().replace(/\.md$/iu, "");
      if (!normalized || !/^[\w\u4e00-\u9fa5-]+$/u.test(normalized)) {
        throw new Error("资料标题只能使用中英文、数字、下划线与连字符");
      }
      const path = `${RESEARCH_PATHS.notes}/${normalized}.md`;
      const now = new Date().toISOString();
      const source: ResearchSourceRecord = {
        id: pathId(path),
        path,
        title: normalized,
        createdAt: now,
      };
      const content = `# ${normalized}\n\n`;
      let created = false;
      let indexCommitted = false;
      try {
        await storage.createText(path, content, { createParents: true });
        created = true;
        const indexFile = await writeIndex(library, [
          ...library.sources,
          source,
        ]);
        indexCommitted = true;
        const loaded = await load();
        const next = freezeLibrary(
          loaded.sources,
          indexFile.content,
          loaded.trash,
          loaded.trashContent,
        );
        return {
          library: next,
          source: { ...source, exists: true, diskContent: content },
          content,
        };
      } catch (cause) {
        if (created && !indexCommitted) {
          const current = await storage.readText(path).catch(() => null);
          if (current?.content === content) {
            await storage
              .remove(path, { permanent: true })
              .catch(() => undefined);
          }
        }
        throw cause;
      }
    },
    async saveSource(
      library: LoadedResearchLibrary,
      source: LoadedResearchSource,
      content: string,
      expectedContent: string,
    ) {
      const file = await storage.writeText(source.path, content, {
        expectedContent,
      });
      const nextSource: LoadedResearchSource = {
        ...source,
        exists: true,
        diskContent: file.content,
      };
      return Object.freeze({
        library: freezeLibrary(
          library.sources.map((item) =>
            item.path === source.path ? nextSource : item,
          ),
          library.indexContent,
          library.trash,
          library.trashContent,
        ),
        source: nextSource,
        content,
      });
    },
    async deleteSource(
      library: LoadedResearchLibrary,
      source: LoadedResearchSource,
    ) {
      if (!source.exists || source.diskContent === null) {
        throw new Error("资料文件不存在，无法移入回收站");
      }
      const current = await storage.readText(source.path);
      if (current.content !== source.diskContent) {
        throw new Error("资料已被外部修改，请刷新后确认内容再移入回收站");
      }
      const trashName = `${source.id}--${source.path.split("/").at(-1) ?? "note.md"}`;
      const trashDirectory = RESEARCH_PATHS.trash;
      let trashPath: string | null = null;
      let trashIndexed: LoadedResearchLibrary | null = null;
      try {
        await storage.createDirectory(trashDirectory).catch(() => undefined);
        const moved = await storage.move([source.path], trashDirectory);
        const transfer = moved.transfers[0];
        if (!transfer || moved.errors.length)
          throw new Error(moved.errors.join("；") || "资料移入回收站失败");
        trashPath = transfer.targetPath;
        if (!trashPath.endsWith(trashName)) {
          const renamed = await storage.rename(trashPath, trashName);
          trashPath = renamed.path;
        }
        const trashRecord: ResearchTrashRecord = {
          id: source.id,
          originalPath: source.path,
          trashPath,
          title: source.title,
          deletedAt: new Date().toISOString(),
        };
        // 先提交回收站索引，再提交活动索引。任一步 CAS 失败，都能依靠
        // 仍然存在的索引记录恢复资料，而不会留下不可见的孤立文件。
        trashIndexed = await saveTrash(library, [
          ...library.trash.map(({ exists: _exists, ...item }) => item),
          trashRecord,
        ]);
        const withoutSource = trashIndexed.sources
          .filter((item) => item.path !== source.path)
          .map(({ exists: _exists, ...item }) => item);
        return await saveIndex(trashIndexed, withoutSource);
      } catch (cause) {
        if (trashIndexed) {
          await storage
            .writeText(
              RESEARCH_PATHS.trashIndex,
              json({
                schemaVersion: 1,
                items: library.trash.map(
                  ({ exists: _exists, ...item }) => item,
                ),
              }),
              { expectedContent: trashIndexed.trashContent },
            )
            .catch(() => undefined);
        }
        if (trashPath) {
          await (async () => {
            const parent = source.path.split("/").slice(0, -1).join("/");
            const movedBack = await storage.move([trashPath], parent);
            const transfer = movedBack.transfers[0];
            if (!transfer) return;
            const originalName = source.path.split("/").at(-1);
            if (originalName && transfer.targetPath !== source.path) {
              await storage.rename(transfer.targetPath, originalName);
            }
          })().catch(() => undefined);
        }
        throw cause;
      }
    },
    async restoreSource(
      library: LoadedResearchLibrary,
      item: LoadedResearchTrash,
    ) {
      const parent = item.originalPath.split("/").slice(0, -1).join("/");
      let trashIndexed: LoadedResearchLibrary | null = null;
      let restoredPath: string | null = null;
      try {
        const moved = await storage.move([item.trashPath], parent);
        const transfer = moved.transfers[0];
        if (!transfer || moved.errors.length) {
          throw new Error(moved.errors.join("；") || "资料恢复失败");
        }
        const originalName = item.originalPath.split("/").at(-1);
        if (!originalName) throw new Error("资料原始路径无效");
        restoredPath = transfer.targetPath;
        if (restoredPath !== item.originalPath) {
          const [existing] = await storage.stat([item.originalPath]);
          if (existing?.exists)
            throw new Error(`目标资料已存在：${item.originalPath}`);
          restoredPath = (await storage.rename(restoredPath, originalName))
            .path;
        }
        if (restoredPath !== item.originalPath) {
          throw new Error(`资料恢复路径错误：${restoredPath}`);
        }
        const restored: ResearchSourceRecord = {
          id: item.id,
          path: item.originalPath,
          title: item.title,
          createdAt: item.deletedAt,
        };
        // 与删除相反，先从回收站索引移除，再提交活动索引；这样活动索引
        // CAS 失败时，回收站索引仍能作为恢复入口。
        trashIndexed = await saveTrash(
          library,
          library.trash
            .filter((trash) => trash.id !== item.id)
            .map(({ exists: _exists, ...trash }) => trash),
        );
        return saveIndex(trashIndexed, [
          ...trashIndexed.sources
            .filter((source) => source.path !== item.originalPath)
            .map(({ exists: _exists, ...source }) => source),
          restored,
        ]);
      } catch (cause) {
        if (trashIndexed) {
          await storage
            .writeText(
              RESEARCH_PATHS.trashIndex,
              json({
                schemaVersion: 1,
                items: library.trash.map(
                  ({ exists: _exists, ...trash }) => trash,
                ),
              }),
              { expectedContent: trashIndexed.trashContent },
            )
            .catch(() => undefined);
        }
        if (restoredPath)
          await (async () => {
            const movedBack = await storage.move(
              [restoredPath],
              RESEARCH_PATHS.trash,
            );
            const transfer = movedBack.transfers[0];
            const trashName = item.trashPath.split("/").at(-1);
            if (
              transfer &&
              trashName &&
              transfer.targetPath !== item.trashPath
            ) {
              await storage.rename(transfer.targetPath, trashName);
            }
          })().catch(() => undefined);
        throw cause;
      }
    },
  });
}
