import { describe, expect, it } from "vitest";

import {
  buildKnowledgeGraph,
  searchKnowledgeGraph,
  type KnowledgeDocument,
} from "./knowledgeGraph";

const SETTING_PAGE_PATH =
  "world/setting-library/pages/world-root/page-world-root-universe-overview.md";

function documents(): readonly KnowledgeDocument[] {
  return [
    {
      path: "world/setting-library/settings.json",
      content: `${JSON.stringify(
        {
          schemaVersion: 1,
          settings: [
            {
              id: "page-world-root-universe-overview",
              nodeId: "world-root",
              templateId: "universe-overview",
              name: "宇宙总览",
              group: "世界",
              status: "draft",
              pagePath: SETTING_PAGE_PATH,
              entriesPath:
                "world/setting-library/entries/world-root/page-world-root-universe-overview.json",
            },
          ],
        },
        null,
        2,
      )}\n`,
      lineCount: 12,
    },
    {
      path: SETTING_PAGE_PATH,
      content: [
        "# 宇宙总览",
        "",
        "> 用一句话定义这个宇宙在故事中的独特位置。",
        "",
        "## 核心特征",
        "",
        "灵气复苏三百年，[[character:char-luoyan|洛言]] 来自东界。",
        "",
        "## 空间边界",
        "",
        "东界之外是[[归墟]]。",
        "",
      ].join("\n"),
      lineCount: 12,
    },
    {
      path: "characters/index.json",
      content: `${JSON.stringify(
        {
          schemaVersion: 1,
          characters: [
            {
              id: "char-luoyan",
              name: "洛言",
              aliases: [],
              summary: "主角",
            },
          ],
        },
        null,
        2,
      )}\n`,
      lineCount: 8,
    },
  ];
}

describe("buildKnowledgeGraph（设定页 Markdown 派生）", () => {
  it("indexes setting page headings with section body as description", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const headings = snapshot.nodes.filter(
      (node) => node.kind === "heading",
    );
    expect(headings.some((node) => node.label === "宇宙总览")).toBe(true);
    const featureHeading = headings.find((node) => node.label === "核心特征");
    expect(featureHeading).toBeDefined();
    expect(featureHeading?.description).toContain("灵气复苏三百年");
  });

  it("lets search hit setting page body text", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const results = searchKnowledgeGraph(snapshot, "灵气复苏");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some(
        (result) =>
          result.node.kind === "heading" &&
          result.node.sourceRefs.some(
            (source) => source.path === SETTING_PAGE_PATH,
          ),
      ),
    ).toBe(true);
  });

  it("connects heading levels with parent edges", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const h1 = snapshot.nodes.find(
      (node) =>
        node.kind === "heading" &&
        node.label === "宇宙总览" &&
        node.sourceRefs.some((source) => source.path === SETTING_PAGE_PATH),
    );
    const h2 = snapshot.nodes.find(
      (node) =>
        node.kind === "heading" &&
        node.label === "核心特征" &&
        node.sourceRefs.some((source) => source.path === SETTING_PAGE_PATH),
    );
    expect(h1 && h2).toBeDefined();
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "parent" &&
          edge.from === h1?.id &&
          edge.to === h2?.id,
      ),
    ).toBe(true);
  });

  it("links the setting index page to its markdown first heading", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const setting = snapshot.nodes.find(
      (node) => node.id === "setting:page-world-root-universe-overview",
    );
    expect(setting).toBeDefined();
    const pageHeading = snapshot.nodes.find(
      (node) =>
        node.kind === "heading" &&
        node.label === "宇宙总览" &&
        node.sourceRefs.some((source) => source.path === SETTING_PAGE_PATH),
    );
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "contains" &&
          edge.from === setting?.id &&
          edge.to === pageHeading?.id,
      ),
    ).toBe(true);
  });

  it("resolves stable entity links to library entities", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const character = snapshot.nodes.find(
      (node) => node.id === "entity:characters/index.json:char-luoyan",
    );
    expect(character).toBeDefined();
    const mentions = snapshot.edges.filter(
      (edge) => edge.kind === "mentions" && edge.to === character?.id,
    );
    expect(mentions.length).toBeGreaterThan(0);
    const owner = snapshot.nodes.find(
      (node) => node.id === mentions[0]?.from,
    );
    expect(owner?.label).toBe("核心特征");
  });

  it("keeps legacy wiki links working", () => {
    const snapshot = buildKnowledgeGraph(documents());
    const legacy = snapshot.nodes.find(
      (node) => node.id === "entity:term:归墟",
    );
    expect(legacy).toBeDefined();
    expect(
      snapshot.edges.some(
        (edge) => edge.kind === "mentions" && edge.to === legacy?.id,
      ),
    ).toBe(true);
  });
});
