import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  MAP_LIBRARY_PATH,
  createEmptyMapDocument,
  mapRecordPath,
  parseMapDocument,
  parseMapLibraryIndex,
  serializeMapDocument,
  serializeMapLibraryIndex,
  type MapDocument,
  type MapEntityKind,
  type MapLibraryIndex,
  type MapProjectionType,
} from "./mapSchema";

export interface LoadedMapLibrary {
  readonly index: MapLibraryIndex;
  readonly content: string;
  readonly exists: boolean;
}

export interface LoadedMapDocument {
  readonly map: MapDocument;
  readonly content: string;
}

export interface NovelMapRepository {
  loadIndex(): Promise<LoadedMapLibrary>;
  createMap(input: {
    readonly id: string;
    readonly name: string;
    readonly projectionType: MapProjectionType;
  }): Promise<LoadedMapDocument>;
  loadMap(mapId: string): Promise<LoadedMapDocument>;
  saveMap(
    current: LoadedMapDocument,
    map: MapDocument,
  ): Promise<LoadedMapDocument>;
  deleteMap(mapId: string): Promise<void>;
}

export function createNovelMapRepository(
  storage: WorkbenchStorage,
): NovelMapRepository {
  const loadIndex = async (): Promise<LoadedMapLibrary> => {
    const [info] = await storage.stat([MAP_LIBRARY_PATH]);
    if (!info?.exists) {
      const content = serializeMapLibraryIndex({ schemaVersion: 1, maps: [] });
      return { index: { schemaVersion: 1, maps: [] }, content, exists: false };
    }
    const file = await storage.readText(MAP_LIBRARY_PATH);
    return { index: parseMapLibraryIndex(file.content), content: file.content, exists: true };
  };

  const loadMap = async (mapId: string): Promise<LoadedMapDocument> => {
    const path = mapRecordPath(mapId);
    const file = await storage.readText(path);
    const map = parseMapDocument(path, file.content);
    if (map.id !== mapId) {
      throw new Error("地图记录与 mapId 不一致");
    }
    return { map, content: file.content };
  };

  return {
    async loadIndex() {
      return loadIndex();
    },

    async createMap({ id, name, projectionType }) {
      const index = await loadIndex();
      if (index.index.maps.some((entry) => entry.id === id)) {
        throw new Error(`地图 id 已存在：${id}`);
      }
      const createdAt = new Date().toISOString();
      const map = createEmptyMapDocument({ id, name, projectionType, createdAt });
      const recordContent = serializeMapDocument(map);
      await storage.createText(mapRecordPath(id), recordContent, {
        createParents: true,
      });
      const nextIndex: MapLibraryIndex = {
        ...index.index,
        maps: [
          ...index.index.maps,
          {
            id,
            name: map.name,
            projectionType,
            updatedAt: createdAt,
          },
        ],
      };
      const indexContent = serializeMapLibraryIndex(nextIndex);
      try {
        if (index.exists) {
          await storage.writeText(MAP_LIBRARY_PATH, indexContent, { expectedContent: index.content });
        } else {
          await storage.createText(MAP_LIBRARY_PATH, indexContent, { createParents: true });
        }
      } catch (cause) {
        await storage.remove(mapRecordPath(id), { permanent: true }).catch(() => false);
        throw cause;
      }
      return { map, content: recordContent };
    },

    async loadMap(mapId) {
      return loadMap(mapId);
    },

    async saveMap(current, map) {
      if (map.id !== current.map.id) {
        throw new Error("保存地图时不得修改稳定 id");
      }
      const index = await loadIndex();
      if (!index.exists || !index.index.maps.some((entry) => entry.id === map.id)) {
        throw new Error(`地图索引中不存在记录：${map.id}`);
      }
      const next: MapDocument = { ...map, updatedAt: new Date().toISOString() };
      const recordContent = serializeMapDocument(next);
      await storage.writeText(mapRecordPath(map.id), recordContent, {
        expectedContent: current.content,
      });
      const nextIndex: MapLibraryIndex = {
        ...index.index,
        maps: index.index.maps.map((entry) =>
          entry.id === map.id
            ? {
                ...entry,
                name: next.name,
                projectionType: next.projectionType,
                updatedAt: next.updatedAt,
              }
            : entry,
        ),
      };
      const nextIndexContent = serializeMapLibraryIndex(nextIndex);
      try {
        await storage.writeText(MAP_LIBRARY_PATH, nextIndexContent, { expectedContent: index.content });
      } catch (cause) {
        try {
          await storage.writeText(mapRecordPath(map.id), current.content, { expectedContent: recordContent });
        } catch (rollbackCause) {
          throw new AggregateError([cause, rollbackCause], "地图索引保存失败，且地图记录回滚失败");
        }
        throw cause;
      }
      return { map: next, content: recordContent };
    },

    async deleteMap(mapId) {
      const index = await loadIndex();
      if (!index.exists) throw new Error("地图库索引不存在");
      if (!index.index.maps.some((entry) => entry.id === mapId)) return;
      const recordPath = mapRecordPath(mapId);
      const record = await storage.readText(recordPath);
      const trashPath = `world/maps/trash/${mapId}-${Date.now().toString(36)}.json`;
      await storage.createText(trashPath, record.content, { createParents: true });
      const nextIndex: MapLibraryIndex = {
        ...index.index,
        maps: index.index.maps.filter((entry) => entry.id !== mapId),
      };
      const nextIndexContent = serializeMapLibraryIndex(nextIndex);
      try {
        await storage.writeText(MAP_LIBRARY_PATH, nextIndexContent, { expectedContent: index.content });
        if (!(await storage.remove(recordPath, { permanent: true }))) {
          throw new Error(`地图记录删除失败：${recordPath}`);
        }
      } catch (cause) {
        await storage.writeText(MAP_LIBRARY_PATH, index.content, { expectedContent: nextIndexContent }).catch(() => undefined);
        await storage.remove(trashPath, { permanent: true }).catch(() => false);
        throw cause;
      }
    },
  };
}

/** 校验地图要素的实体引用存在性（复用领域索引思路，供 T11 使用）。 */
export async function validateMapEntityReferences(
  storage: WorkbenchStorage,
  map: MapDocument,
  availableIds: Readonly<Record<MapEntityKind, ReadonlySet<string>>>,
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const feature of map.features) {
    if (!feature.entityRef) continue;
    const { kind, id } = feature.entityRef;
    const set = availableIds[kind];
    if (!set.has(id)) {
      errors.push(`要素“${feature.name}”关联了不存在的${kind}：${id}`);
    }
  }
  return errors;
}
