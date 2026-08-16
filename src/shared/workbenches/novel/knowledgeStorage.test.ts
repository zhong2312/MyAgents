import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_COLLECTIONS,
  createKnowledgeFiles,
  knowledgeIndexPath,
  knowledgeRecordPath,
  loadKnowledgeFiles,
} from "./knowledgeStorage";

function library() {
  return {
    schemaVersion: 1 as const,
    entities: [
      {
        id: "entity-hero",
        name: "洛言",
        aliases: ["阿言"],
        description: "故事主角",
      },
    ],
    relations: [
      {
        id: "relation-hero-sect",
        fromId: "entity-hero",
        toId: "entity-sect",
        type: "隶属",
      },
    ],
    facts: [
      {
        id: "fact-hero-awake",
        title: "主角苏醒",
        content: "洛言已经苏醒。",
      },
    ],
  };
}

describe("knowledgeStorage", () => {
  it("将实体、关系和事实拆成三个索引及独立记录", () => {
    const files = createKnowledgeFiles(library());
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      expect(
        files.some((file) => file.path === knowledgeIndexPath(collection)),
      ).toBe(true);
      const index = JSON.parse(
        files.find((file) => file.path === knowledgeIndexPath(collection))
          ?.content ?? "{}",
      ) as Record<string, unknown>;
      expect(index).toMatchObject({
        schemaVersion: 1,
        storageVersion: 1,
      });
      expect(index[collection]).toHaveLength(1);
    }
    expect(
      files.some(
        (file) => file.path === knowledgeRecordPath("entities", "entity-hero"),
      ),
    ).toBe(true);
  });

  it("只聚合索引引用的正式记录并保留目录快照", async () => {
    const source = new Map(
      createKnowledgeFiles(library()).map((file) => [file.path, file.content]),
    );
    source.set(
      knowledgeRecordPath("facts", "fact-orphan"),
      JSON.stringify({ id: "fact-orphan", content: "孤立事实" }),
    );
    const loaded = await loadKnowledgeFiles(async (path) => {
      const content = source.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    });
    expect(loaded.library.entities[0]?.name).toBe("洛言");
    expect(loaded.library.facts.map((fact) => fact.id)).toEqual([
      "fact-hero-awake",
    ]);
    expect(loaded.files.has(knowledgeRecordPath("facts", "fact-orphan"))).toBe(
      false,
    );
  });

  it("拒绝旧内嵌结构、伪造路径和记录 ID 不一致", async () => {
    const source = new Map(
      createKnowledgeFiles(library()).map((file) => [file.path, file.content]),
    );
    source.set(
      knowledgeIndexPath("entities"),
      JSON.stringify({ schemaVersion: 1, entities: [] }),
    );
    await expect(
      loadKnowledgeFiles(async (path) => source.get(path) ?? ""),
    ).rejects.toThrow("旧单文件知识库不兼容且不迁移");

    const forged = new Map(
      createKnowledgeFiles(library()).map((file) => [file.path, file.content]),
    );
    forged.set(
      knowledgeIndexPath("facts"),
      JSON.stringify({
        schemaVersion: 1,
        storageVersion: 1,
        facts: [
          {
            id: "fact-hero-awake",
            path: "knowledge/facts/records/other.json",
          },
        ],
      }),
    );
    await expect(
      loadKnowledgeFiles(async (path) => forged.get(path) ?? ""),
    ).rejects.toThrow(knowledgeRecordPath("facts", "fact-hero-awake"));

    const mismatched = new Map(
      createKnowledgeFiles(library()).map((file) => [file.path, file.content]),
    );
    mismatched.set(
      knowledgeRecordPath("entities", "entity-hero"),
      JSON.stringify({ id: "entity-other", name: "洛言" }),
    );
    await expect(
      loadKnowledgeFiles(async (path) => mismatched.get(path) ?? ""),
    ).rejects.toThrow("id 与索引不一致");
  });
});
