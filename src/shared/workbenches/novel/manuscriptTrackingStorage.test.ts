import { describe, expect, it } from "vitest";

import {
  MANUSCRIPT_TRACKING_BASELINES_PATH,
  MANUSCRIPT_TRACKING_INDEX_PATH,
  createManuscriptTrackingFiles,
  loadManuscriptTrackingFiles,
  manuscriptTrackingBatchPath,
} from "./manuscriptTrackingStorage";

const NOW = "2026-08-09T00:00:00.000Z";

function batch(id: string) {
  return {
    id,
    chapterId: "chapter-000001",
    chapterContentHash: "fnv1a-12345678",
    summary: "第一章连续性",
    status: "proposed",
    createdAt: NOW,
    appliedAt: null,
    revertedAt: null,
    changes: [],
    mutations: [],
  };
}

describe("manuscriptTrackingStorage", () => {
  it("将逻辑账本拆成根索引、基线和独立批次", () => {
    const files = createManuscriptTrackingFiles({
      schemaVersion: 3,
      updatedAt: NOW,
      baselines: { "character-field:hero:status": "清醒" },
      batches: [batch("tracking-batch-one")],
    });
    expect(JSON.parse(files.at(-1)?.content ?? "{}")).toEqual({
      schemaVersion: 3,
      storageVersion: 1,
      updatedAt: NOW,
      baselinesPath: MANUSCRIPT_TRACKING_BASELINES_PATH,
      batches: [
        {
          id: "tracking-batch-one",
          path: "manuscript/state-ledger/batches/tracking-batch-one.json",
        },
      ],
    });
    expect(files.at(-1)?.path).toBe(MANUSCRIPT_TRACKING_INDEX_PATH);
    expect(
      files.some(
        (file) =>
          file.path === manuscriptTrackingBatchPath("tracking-batch-one"),
      ),
    ).toBe(true);
  });

  it("递归聚合基线和批次并保留目录快照", async () => {
    const source = new Map(
      createManuscriptTrackingFiles({
        schemaVersion: 3,
        updatedAt: NOW,
        baselines: { "character-field:hero:status": "清醒" },
        batches: [batch("tracking-batch-one")],
      }).map((file) => [file.path, file.content]),
    );
    const loaded = await loadManuscriptTrackingFiles(async (path) => {
      const content = source.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });
    expect(loaded.ledger.batches[0]?.summary).toBe("第一章连续性");
    expect(loaded.ledger.baselines).toEqual({
      "character-field:hero:status": "清醒",
    });
    expect(
      loaded.files.has(manuscriptTrackingBatchPath("tracking-batch-one")),
    ).toBe(true);
  });

  it("拒绝旧单文件结构和索引路径伪造", async () => {
    await expect(
      loadManuscriptTrackingFiles(async () =>
        JSON.stringify({
          schemaVersion: 3,
          updatedAt: NOW,
          baselines: {},
          batches: [],
        }),
      ),
    ).rejects.toThrow("旧单文件正文状态账本不兼容且不迁移");

    await expect(
      loadManuscriptTrackingFiles(async (path) => {
        if (path === MANUSCRIPT_TRACKING_INDEX_PATH) {
          return JSON.stringify({
            schemaVersion: 3,
            storageVersion: 1,
            updatedAt: NOW,
            baselinesPath: MANUSCRIPT_TRACKING_BASELINES_PATH,
            batches: [
              {
                id: "tracking-batch-one",
                path: "manuscript/state-ledger/batches/other.json",
              },
            ],
          });
        }
        if (path === MANUSCRIPT_TRACKING_BASELINES_PATH) {
          return JSON.stringify({ schemaVersion: 1, baselines: {} });
        }
        throw new Error(`unexpected ${path}`);
      }),
    ).rejects.toThrow(
      "manuscript/state-ledger/batches/tracking-batch-one.json",
    );
  });
});
