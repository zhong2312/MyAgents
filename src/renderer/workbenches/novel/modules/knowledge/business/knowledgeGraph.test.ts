import { describe, expect, it } from "vitest";

import {
  buildKnowledgeGraph,
  buildKnowledgeGraphFromStorage,
  readKnowledgeDocuments,
  searchKnowledgeGraph,
  type KnowledgeDocument,
} from "./knowledgeGraph";
import {
  createKnowledgeFiles,
  knowledgeRecordPath,
} from "../../../../../../shared/workbenches/novel/knowledgeStorage";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

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
              summary: "主角",
              raceId: null,
              groupIds: [],
              recordPath: "characters/records/char-luoyan.json",
              updatedAt: "2026-01-01T00:00:00.000Z",
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
    const headings = snapshot.nodes.filter((node) => node.kind === "heading");
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
          edge.kind === "parent" && edge.from === h1?.id && edge.to === h2?.id,
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
    const owner = snapshot.nodes.find((node) => node.id === mentions[0]?.from);
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

  it("indexes directory-backed knowledge entities, facts and relations", () => {
    const knowledgeFiles = createKnowledgeFiles({
      schemaVersion: 1,
      entities: [
        { id: "entity-hero", name: "洛言", description: "故事主角" },
        { id: "entity-sect", name: "青云宗", description: "修行宗门" },
      ],
      facts: [
        {
          id: "fact-hero-awake",
          title: "主角苏醒",
          content: "洛言已经苏醒。",
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
    });
    const snapshot = buildKnowledgeGraph([
      ...documents(),
      ...knowledgeFiles.map((file) => ({
        ...file,
        lineCount: file.content.split("\n").length,
      })),
    ]);

    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entity:entity-hero", label: "洛言" }),
        expect.objectContaining({
          id: "fact:fact-hero-awake",
          description: "洛言已经苏醒。",
        }),
      ]),
    );
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        id: "relation:relation-hero-sect",
        from: "entity:entity-hero",
        to: "entity:entity-sect",
        label: "隶属",
      }),
    );
  });

  it("reads only records referenced by knowledge indexes and rejects legacy files", async () => {
    const files = createKnowledgeFiles({
      schemaVersion: 1,
      entities: [{ id: "entity-hero", name: "洛言" }],
      relations: [],
      facts: [],
    });
    const storage = new NovelMemoryStorage(
      Object.fromEntries([
        ...files.map((file) => [file.path, file.content] as const),
        [
          knowledgeRecordPath("entities", "entity-orphan"),
          JSON.stringify({ id: "entity-orphan", name: "孤立实体" }),
        ],
      ]),
    );
    const loaded = await readKnowledgeDocuments(storage);
    expect(
      loaded.some(
        (document) =>
          document.path === knowledgeRecordPath("entities", "entity-hero"),
      ),
    ).toBe(true);
    expect(
      loaded.some(
        (document) =>
          document.path === knowledgeRecordPath("entities", "entity-orphan"),
      ),
    ).toBe(false);

    const legacy = new NovelMemoryStorage({
      "knowledge/entities.json": JSON.stringify({
        schemaVersion: 1,
        entities: [],
      }),
    });
    await expect(readKnowledgeDocuments(legacy)).rejects.toThrow(
      "不兼容且不迁移",
    );
  });

  it("indexes timeline directory records without treating manifest refs as entities", () => {
    const timelineIndex: KnowledgeDocument = {
      path: "timeline/index.json",
      content: JSON.stringify({
        schemaVersion: 1,
        storageVersion: 1,
        calendars: [],
        periods: [],
        views: [],
        branches: [],
        events: [
          {
            id: "event-awakening",
            path: "timeline/events/records/event-awakening.json",
          },
        ],
      }),
      lineCount: 1,
    };
    const eventRecord: KnowledgeDocument = {
      path: "timeline/events/records/event-awakening.json",
      content: JSON.stringify({
        id: "event-awakening",
        title: "天裂之夜",
        summary: "灵潮第一次席卷东界。",
      }),
      lineCount: 1,
    };
    const mention: KnowledgeDocument = {
      path: "research/timeline-note.md",
      content: "# 时间线线索\n\n[[event:event-awakening|天裂之夜]]",
      lineCount: 3,
    };

    const snapshot = buildKnowledgeGraph([
      ...documents(),
      timelineIndex,
      eventRecord,
      mention,
    ]);
    const event = snapshot.nodes.find(
      (node) => node.id === "entity:timeline/index.json:event-awakening",
    );

    expect(event).toMatchObject({
      label: "天裂之夜",
      description: "灵潮第一次席卷东界。",
      sourceRefs: [{ path: "timeline/events/records/event-awakening.json" }],
    });
    expect(
      snapshot.edges.some(
        (edge) => edge.kind === "mentions" && edge.to === event?.id,
      ),
    ).toBe(true);
  });

  it("indexes faction directory records without treating manifest refs as entities", () => {
    const factionIndex: KnowledgeDocument = {
      path: "world/factions/index.json",
      content: JSON.stringify({
        schemaVersion: 2,
        storageVersion: 1,
        factions: [
          {
            id: "faction-cloud-sect",
            path: "world/factions/records/faction-cloud-sect.json",
          },
        ],
      }),
      lineCount: 1,
    };
    const factionRecord: KnowledgeDocument = {
      path: "world/factions/records/faction-cloud-sect.json",
      content: JSON.stringify({
        id: "faction-cloud-sect",
        name: "青云宗",
        summary: "坐镇东玄大陆的剑修宗门。",
      }),
      lineCount: 1,
    };
    const mention: KnowledgeDocument = {
      path: "research/faction-note.md",
      content: "# 势力线索\n\n[[faction:faction-cloud-sect|青云宗]]",
      lineCount: 3,
    };

    const snapshot = buildKnowledgeGraph([
      ...documents(),
      factionIndex,
      factionRecord,
      mention,
    ]);
    const faction = snapshot.nodes.find(
      (node) =>
        node.id === "entity:world/factions/index.json:faction-cloud-sect",
    );

    expect(faction).toMatchObject({
      label: "青云宗",
      description: "坐镇东玄大陆的剑修宗门。",
      sourceRefs: [{ path: "world/factions/records/faction-cloud-sect.json" }],
    });
    expect(
      snapshot.nodes.some(
        (node) =>
          node.id === "entity:world/factions/index.json:faction-cloud-sect" &&
          node.label === "faction-cloud-sect",
      ),
    ).toBe(false);
    expect(
      snapshot.edges.some(
        (edge) => edge.kind === "mentions" && edge.to === faction?.id,
      ),
    ).toBe(true);
  });

  it("reuses an in-memory graph snapshot keyed by fact-source hash without writing project files", async () => {
    const storage = new NovelMemoryStorage({
      "research/cache-note.md": "# 灵潮\n\n东界的灵气正在复苏。\n",
    });
    const first = await buildKnowledgeGraphFromStorage(storage);
    expect(storage.getText("knowledge/derived/graph.json")).toBeUndefined();
    const second = await buildKnowledgeGraphFromStorage(storage);
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(second.nodes).toEqual(first.nodes);
    expect(second).toBe(first);
  });

  it("reports malformed JSON instead of silently dropping the source", () => {
    const snapshot = buildKnowledgeGraph([
      { path: "world/items/index.json", content: "{", lineCount: 1 },
    ]);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invalid-json",
          source: { path: "world/items/index.json" },
        }),
      ]),
    );
  });

  it("reports dangling structured references with a JSON pointer", () => {
    const snapshot = buildKnowledgeGraph([
      {
        path: "knowledge/entities/records/hero.json",
        content: JSON.stringify({ id: "hero", name: "主角", characterId: "missing" }),
        lineCount: 1,
      },
    ]);
    const diagnostic = snapshot.diagnostics.find(
      (item) => item.kind === "dangling-reference",
    );
    expect(diagnostic?.source?.jsonPointer).toBe("/characterId");
  });
});
