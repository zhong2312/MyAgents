import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "vitest";

import { readNovelIndexIdSet } from "../utils/novel-id-set";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("readIdSet 人物分片索引", () => {
  it("仅凭 characters/index.json 的摘要条目读取角色 id", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "myagents-id-set-"));
    temporaryRoots.push(workspace);
    const characterDirectory = join(workspace, "characters");
    await mkdir(characterDirectory, { recursive: true });
    await writeFile(
      join(characterDirectory, "index.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        characters: [
          {
            id: "character-a",
            name: "甲",
            recordPath: "characters/records/character-a.json",
            updatedAt: "2026-08-05T00:00:00.000Z",
          },
          {
            id: "character-b",
            name: "乙",
            recordPath: "characters/records/character-b.json",
            updatedAt: "2026-08-05T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(
      readNovelIndexIdSet(
        join(characterDirectory, "index.json"),
        "characters",
        "characters/index.json",
      ),
    ).resolves.toEqual(new Set(["character-a", "character-b"]));
  });
});
