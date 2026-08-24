import { describe, expect, it } from "vitest";

import {
  appendNovelOverviewContext,
  formatNovelOverviewContext,
} from "./novelOverviewContext";

describe("novel overview AI context", () => {
  const metadata = {
    title: "雾城守夜人",
    genres: ["悬疑", "都市异能"],
    targetWordCountMin: 800_000,
    targetWordCountMax: 1_000_000,
    chapterWordCount: 3_500,
    language: "zh-CN",
    writingPerspective: "first-person" as const,
    description: "失忆调查员在雨夜追查一桩会吞噬记忆的连环案。",
  };

  it("provides every project overview constraint to AI prompts", () => {
    const context = formatNovelOverviewContext(metadata);

    expect(context).toContain("雾城守夜人");
    expect(context).toContain("悬疑、都市异能");
    expect(context).toContain("800,000 字 至 1,000,000 字");
    expect(context).toContain("3,500 字");
    expect(context).toContain("229 至 286 章");
    expect(context).toContain("第一人称");
    expect(context).toContain("失忆调查员");
    expect(context).toContain("必须与以上总览一致");
  });

  it("puts the overview ahead of the task-specific system prompt", () => {
    const prompt = appendNovelOverviewContext(metadata, "只生成本章的开场。 ");

    expect(prompt).toContain("只生成本章的开场。");
    expect(prompt.indexOf("【小说总览")).toBeLessThan(
      prompt.indexOf("只生成本章的开场。"),
    );
  });
});
