import { describe, expect, it } from "vitest";

import {
  NARRATIVE_ENGINEERING_INDEX_PATH,
  createNarrativeEngineeringFiles,
  loadNarrativeEngineeringFiles,
  narrativeRecordPath,
  serializeNarrativeFileSnapshot,
  type NarrativeEngineeringStorageAggregate,
} from "./narrativeEngineeringStorage";

function fixture(): NarrativeEngineeringStorageAggregate {
  return {
    schemaVersion: 4,
    updatedAt: "2026-08-09T00:00:00.000Z",
    lines: [{ id: "line-main", title: "主线", content: "正文" }],
    arcs: [{ id: "arc-main", title: "人物弧" }],
    directories: [{ id: "directory-one", title: "第一卷" }],
    chapters: [{ id: "chapter-one", title: "第一章", sections: [] }],
    simulationProposals: [{ id: "simulation-one", title: "推演提案" }],
  };
}

describe("narrativeEngineeringStorage", () => {
  it("将聚合拆为轻量索引和独立记录，并可完整聚合读回", async () => {
    const files = createNarrativeEngineeringFiles(fixture());
    const fileMap = new Map(files.map((file) => [file.path, file.content]));
    const index = JSON.parse(fileMap.get(NARRATIVE_ENGINEERING_INDEX_PATH) ?? "{}");

    expect(index).toMatchObject({
      schemaVersion: 4,
      storageVersion: 1,
      lines: [{
        id: "line-main",
        path: "narrative/lines/records/line-main.json",
      }],
    });
    expect(index.lines[0]).not.toHaveProperty("content");
    expect(fileMap.get(narrativeRecordPath("lines", "line-main"))).toContain(
      '"content": "正文"',
    );

    const loaded = await loadNarrativeEngineeringFiles(async (path) => {
      const content = fileMap.get(path);
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    });
    expect(loaded.library).toEqual(fixture());
    expect(serializeNarrativeFileSnapshot(loaded.files)).toBe(
      serializeNarrativeFileSnapshot(files),
    );
  });

  it("拒绝索引引用非规范路径", async () => {
    const files = createNarrativeEngineeringFiles(fixture());
    const fileMap = new Map(files.map((file) => [file.path, file.content]));
    const index = JSON.parse(fileMap.get(NARRATIVE_ENGINEERING_INDEX_PATH) ?? "{}");
    index.lines[0].path = "narrative/lines/line-main.json";
    fileMap.set(NARRATIVE_ENGINEERING_INDEX_PATH, JSON.stringify(index));

    await expect(
      loadNarrativeEngineeringFiles(async (path) => fileMap.get(path) ?? ""),
    ).rejects.toThrow("path 必须是 narrative/lines/records/line-main.json");
  });

  it("拒绝旧单文件聚合格式", async () => {
    await expect(
      loadNarrativeEngineeringFiles(async () =>
        JSON.stringify({ ...fixture(), storageVersion: undefined }),
      ),
    ).rejects.toThrow("旧单文件剧情工程不兼容且不迁移");
  });
});
