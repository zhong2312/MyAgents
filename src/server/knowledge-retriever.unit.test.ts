import { describe, expect, it } from "vitest";

import { retrieveKnowledgeDocuments } from "./knowledge-retriever";

describe("knowledge retriever", () => {
  it("combines phrase, n-gram coverage and deterministic reranking", () => {
    const results = retrieveKnowledgeDocuments(
      [
        { path: "world/setting.md", content: "玄霜城位于北境，城墙由黑曜石铸成。" },
        { path: "characters/records/li.json", content: "李玄在北境寻找玄霜城。" },
        { path: "misc.md", content: "南境有一片森林。" },
      ],
      "玄霜城 北境",
      3,
    );

    expect(results).toHaveLength(2);
    const setting = results.find((result) => result.path === "world/setting.md");
    expect(setting).toBeDefined();
    expect(setting?.retrieval.lexicalScore).toBeGreaterThan(0);
    expect(setting?.retrieval.semanticScore).toBeGreaterThan(0);
    expect(setting?.retrieval.rerankScore).toBe(setting?.score);
    expect(setting?.citations[0]?.line).toBe(1);
  });

  it("returns no false positives for unmatched queries", () => {
    expect(
      retrieveKnowledgeDocuments(
        [{ path: "world/setting.md", content: "玄霜城" }],
        "完全不存在的词",
        5,
      ),
    ).toEqual([]);
  });
});
