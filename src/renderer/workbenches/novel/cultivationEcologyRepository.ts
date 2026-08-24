import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createEmptyCultivationEcology,
  cultivationEcologySchema,
  type CultivationEcology,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";
import {
  CULTIVATION_ECOLOGY_DIRECTORY,
  CULTIVATION_ECOLOGY_INDEX_PATH,
  createCultivationEcologyFiles,
  cultivationFileMap,
  loadCultivationEcologyFiles,
  serializeCultivationFileSnapshot,
} from "../../../shared/workbenches/novel/cultivationEcologyStorage";
import { validateCultivationEcology } from "../../../shared/workbenches/novel/cultivationEcologyValidation";
import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";
import { rebuildCultivationAudits } from "./cultivationEcologyAudit";

export { CULTIVATION_ECOLOGY_DIRECTORY, CULTIVATION_ECOLOGY_INDEX_PATH };

async function readItemIds(
  storage: WorkbenchStorage,
): Promise<ReadonlySet<string> | undefined> {
  const [entry] = await storage.stat(["world/items/index.json"]);
  if (!entry?.exists) return undefined;
  const parsed = JSON.parse(
    (await storage.readText("world/items/index.json")).content,
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("物品索引不是有效 JSON 对象");
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("物品索引缺少 items 数组");
  return new Set(
    items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

async function validateForSave(
  storage: WorkbenchStorage,
  ecology: CultivationEcology,
): Promise<void> {
  const errors = validateCultivationEcology(ecology, {
    itemIds: await readItemIds(storage),
  });
  if (errors.length > 0) {
    throw new Error(`修行生态语义校验失败：${errors.slice(0, 100).join("；")}`);
  }
}

async function loadFiles(storage: WorkbenchStorage) {
  return loadCultivationEcologyFiles(
    async (path) => (await storage.readText(path)).content,
  );
}

export function createCultivationEcologyInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return createCultivationEcologyFiles(createEmptyCultivationEcology());
}

/**
 * 目录细节全部封装在 Repository 内。界面仍编辑一个领域聚合，但保存时只写变化模块，
 * 根 index.json 最后提交；expectedContent 是整组已读取文件的精确快照。
 */
export function createCultivationEcologyRepository(storage: WorkbenchStorage) {
  const loadExisting = async () => {
    const loaded = await loadFiles(storage);
    return {
      ecology: rebuildCultivationAudits(loaded.ecology),
      content: serializeCultivationFileSnapshot(loaded.files),
      files: loaded.files,
    };
  };

  return {
    async load() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_INDEX_PATH]);
      if (!entry?.exists) return null;
      return loadExisting();
    },

    async initialize() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_INDEX_PATH]);
      if (entry?.exists) return loadExisting();
      const transaction = createStorageTransaction(storage);
      for (const file of createCultivationEcologyInitializationFiles()) {
        transaction.createText(file.path, file.content);
      }
      await transaction.commit();
      return loadExisting();
    },

    async save(ecology: CultivationEcology, expectedContent: string) {
      const current = await loadFiles(storage);
      const currentSnapshot = serializeCultivationFileSnapshot(current.files);
      if (currentSnapshot !== expectedContent) {
        throw new Error("修行生态事实源已被外部修改，请重新加载后再保存");
      }
      const next = cultivationEcologySchema.parse({
        ...rebuildCultivationAudits(ecology),
        updatedAt: new Date().toISOString(),
      });
      await validateForSave(storage, next);

      const nextFiles = cultivationFileMap(createCultivationEcologyFiles(next));
      const transaction = createStorageTransaction(storage);
      const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
        if (left === CULTIVATION_ECOLOGY_INDEX_PATH) return 1;
        if (right === CULTIVATION_ECOLOGY_INDEX_PATH) return -1;
        return left.localeCompare(right);
      });
      for (const path of orderedPaths) {
        const content = nextFiles.get(path);
        if (content === undefined) continue;
        const previous = current.files.get(path);
        if (previous === content) continue;
        if (previous === undefined) transaction.createText(path, content);
        else transaction.writeText(path, content, previous);
      }
      await transaction.commit();

      // 根索引已经不再引用这些文件；清理失败只会留下不可见的孤立文件，不破坏事实源。
      const removedPaths = [...current.files.keys()].filter(
        (path) => !nextFiles.has(path),
      );
      await Promise.allSettled(
        removedPaths.map((path) => storage.remove(path, { permanent: true })),
      );
      return loadExisting();
    },
  };
}
