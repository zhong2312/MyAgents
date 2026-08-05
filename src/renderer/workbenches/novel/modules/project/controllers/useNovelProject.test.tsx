import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { createNovelRepository } from "../data-access/repository";
import { createEmptyNovelStorage, type NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { useNovelProject } from "./useNovelProject";

const CHAPTER_INDEX_PATH = "manuscript/index.json";

/**
 * 把磁盘推进到稳定的当前 schema 状态：createEmptyNovelStorage 产出 v1 索引，
 * 首次同步会执行 v1→v4 迁移写盘。稳定态下的刷新才应当零写入。
 */
async function settleToStableSchema(
  storage: NovelMemoryStorage,
): Promise<void> {
  const repository = createNovelRepository(storage);
  const project = await repository.load();
  await repository.synchronizeNarrative(
    project,
    project.chapterIndex.structureMode,
  );
}

function countIndexReads(storage: NovelMemoryStorage): () => number {
  let reads = 0;
  const original = storage.readText.bind(storage);
  storage.readText = async (path: string) => {
    if (path === CHAPTER_INDEX_PATH) reads += 1;
    return original(path);
  };
  return () => reads;
}

describe("useNovelProject 刷新路径读盘次数", () => {
  it("稳定态首次加载只做一次全量读取", async () => {
    const storage = createEmptyNovelStorage();
    await settleToStableSchema(storage);
    const indexReads = countIndexReads(storage);

    const { result } = renderHook(() => useNovelProject(storage, true));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.project).not.toBeNull();
    expect(indexReads()).toBe(1);
  });

  it("同步确实改写索引时仍会重新加载以反映结果", async () => {
    const storage = createEmptyNovelStorage();
    const indexReads = countIndexReads(storage);

    const { result } = renderHook(() => useNovelProject(storage, true));
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // v1 索引会被同步迁移为当前版本，因此必须二次加载才能拿到迁移后的状态
    expect(result.current.project?.chapterIndexNeedsMigration).toBe(false);
    expect(indexReads()).toBe(2);
  });
});
