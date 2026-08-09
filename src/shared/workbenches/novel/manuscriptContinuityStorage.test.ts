import { describe, expect, it } from "vitest";

import {
  MANUSCRIPT_CONTINUITY_INDEX_PATH,
  MANUSCRIPT_CONTINUITY_LEGACY_PATH,
  createManuscriptContinuityFiles,
  loadManuscriptContinuityFiles,
  manuscriptContinuityFactPath,
} from "./manuscriptContinuityStorage";

const NOW = "2026-08-09T00:00:00.000Z";

function fact(id: string) {
  return {
    id,
    domain: "continuity" as const,
    entityId: "hero",
    title: "主角状态",
    value: "清醒",
    evidence: "第一章证据",
    chapterId: "chapter-000001",
    batchId: "tracking-batch-one",
    changeId: "tracking-change-one",
    updatedAt: NOW,
  };
}

describe("manuscriptContinuityStorage", () => {
  it("将连续性事实拆成根索引和独立记录", () => {
    const files = createManuscriptContinuityFiles({
      schemaVersion: 1,
      updatedAt: NOW,
      facts: [fact("fact-hero-state")],
    });
    expect(files.at(-1)?.path).toBe(MANUSCRIPT_CONTINUITY_INDEX_PATH);
    expect(JSON.parse(files.at(-1)?.content ?? "{}")).toEqual({
      schemaVersion: 1,
      storageVersion: 1,
      updatedAt: NOW,
      facts: [
        {
          id: "fact-hero-state",
          path: manuscriptContinuityFactPath("fact-hero-state"),
        },
      ],
    });
    expect(
      files.find(
        (file) => file.path === manuscriptContinuityFactPath("fact-hero-state"),
      )?.content,
    ).toContain('"id": "fact-hero-state"');
  });

  it("严格聚合事实并保留目录快照", async () => {
    const source = new Map(
      createManuscriptContinuityFiles({
        schemaVersion: 1,
        updatedAt: NOW,
        facts: [fact("fact-hero-state")],
      }).map((file) => [file.path, file.content]),
    );
    const loaded = await loadManuscriptContinuityFiles(async (path) => {
      const content = source.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });
    expect(loaded.state.facts).toHaveLength(1);
    expect(loaded.state.facts[0]?.value).toBe("清醒");
    expect(
      loaded.files.has(manuscriptContinuityFactPath("fact-hero-state")),
    ).toBe(true);
  });

  it("拒绝旧单文件结构和伪造记录路径", async () => {
    await expect(
      loadManuscriptContinuityFiles(async (path) => {
        if (path === MANUSCRIPT_CONTINUITY_INDEX_PATH) {
          return JSON.stringify({
            schemaVersion: 1,
            updatedAt: NOW,
            facts: [],
          });
        }
        throw new Error(`unexpected ${path}`);
      }),
    ).rejects.toThrow("旧单文件连续性状态不兼容且不迁移");

    await expect(
      loadManuscriptContinuityFiles(async (path) => {
        if (path === MANUSCRIPT_CONTINUITY_INDEX_PATH) {
          return JSON.stringify({
            schemaVersion: 1,
            storageVersion: 1,
            updatedAt: NOW,
            facts: [
              {
                id: "fact-hero-state",
                path: "manuscript/continuity-state/facts/other.json",
              },
            ],
          });
        }
        throw new Error(`unexpected ${path}`);
      }),
    ).rejects.toThrow("manuscript/continuity-state/facts/fact-hero-state.json");

    expect(MANUSCRIPT_CONTINUITY_LEGACY_PATH).toBe(
      "manuscript/continuity-state.json",
    );
  });
});
