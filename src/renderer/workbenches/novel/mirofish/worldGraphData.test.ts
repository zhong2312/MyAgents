import { describe, expect, it } from "vitest";

import type { WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";

import type { KnowledgeGraphSnapshot } from "../knowledgeGraph";
import { projectWorldGraph } from "./worldGraphData";

const knowledge: KnowledgeGraphSnapshot = {
  builtAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    {
      id: "entity:lingxu",
      label: "灵墟",
      kind: "entity",
      description: "上古秘境",
      aliases: ["灵墟秘境"],
      sourceRefs: [{ path: "knowledge/entities.json" }],
    },
    {
      id: "setting:cultivation",
      label: "修炼体系",
      kind: "setting",
      description: "境界划分",
      aliases: [],
      sourceRefs: [{ path: "world/setting-library/settings.json" }],
    },
    {
      id: "heading:manuscript/chapters/000001.md:3",
      label: "第一章 入城",
      kind: "heading",
      description: "第一章 入城",
      aliases: [],
      sourceRefs: [{ path: "manuscript/chapters/000001.md", line: 3 }],
    },
  ],
  edges: [
    {
      id: "relation:entity:lingxu:setting:cultivation:0",
      from: "entity:lingxu",
      to: "setting:cultivation",
      label: "关联",
      kind: "relation",
      sourceRefs: [{ path: "knowledge/relations.json" }],
    },
  ],
  documents: [],
};

const simulation = {
  schemaVersion: 1,
  projectId: "novel-test",
  title: "测试小说",
  sourceRevision: "sha256:test",
  anchor: "第一章",
  actors: [
    {
      id: "character-1",
      name: "陆沉渊",
      kind: "character",
      summary: "主角",
      locationId: null,
      goals: ["寻回灵墟"],
      traits: [],
      resources: [],
      knowledge: [],
      constraints: [],
      sourceRefs: [],
    },
  ],
  locations: [
    { id: "location-1", name: "临渊城", summary: "边城", parentId: null, sourceRefs: [] },
  ],
  rules: [],
  timelineEvents: [
    {
      id: "event-1",
      title: "陆沉渊入城",
      summary: "主角抵达临渊城",
      timeLabel: "第一章",
      actorIds: ["character-1"],
      locationIds: ["location-1"],
      causeEventIds: [],
      sourceRefs: [],
    },
    {
      id: "event-2",
      title: "镇夜司戒严",
      summary: "入城后城内进入戒备状态",
      timeLabel: "第二章",
      actorIds: ["character-1"],
      locationIds: ["location-1"],
      causeEventIds: ["event-1"],
      sourceRefs: [],
    },
  ],
} as WorkbenchSimulationWorldSnapshot;

describe("projectWorldGraph", () => {
  it("把知识图谱节点与边投影为 GraphPanel 格式", () => {
    const graph = projectWorldGraph(knowledge, null);

    expect(graph.nodes).toHaveLength(3);
    const node = graph.nodes.find((item) => item.uuid === "entity:lingxu");
    expect(node?.name).toBe("灵墟");
    expect(node?.labels).toEqual(["实体"]);
    expect(node?.summary).toBe("上古秘境");
    expect(node?.attributes["别名"]).toBe("灵墟秘境");

    const edge = graph.edges.find(
      (item) => item.uuid === "relation:entity:lingxu:setting:cultivation:0",
    );
    // 契约对齐：GraphPanel.vue 读取 source_node_uuid/target_node_uuid。
    expect(edge?.source_node_uuid).toBe("entity:lingxu");
    expect(edge?.target_node_uuid).toBe("setting:cultivation");
    expect(edge?.name).toBe("关联");
    expect(edge?.fact_type).toBe("relation");
  });

  it("融合推演快照的行动主体、地点与事件及关联边", () => {
    const graph = projectWorldGraph(knowledge, simulation);

    const actor = graph.nodes.find((item) => item.uuid === "actor:character-1");
    expect(actor?.name).toBe("陆沉渊");
    expect(actor?.labels).toEqual(["人物"]);
    expect(actor?.attributes["目标"]).toBe("寻回灵墟");

    const event = graph.nodes.find((item) => item.uuid === "event:event-1");
    expect(event?.labels).toEqual(["事件"]);
    expect(event?.attributes["时间"]).toBe("第一章");

    expect(graph.edges.some((edge) => edge.name === "参与")).toBe(true);
    expect(graph.edges.some((edge) => edge.name === "发生地")).toBe(true);
    expect(graph.edges).toContainEqual({
      uuid: "event-cause:event-1:event-2",
      source_node_uuid: "event:event-1",
      target_node_uuid: "event:event-2",
      name: "导致",
      fact_type: "causes",
      fact: "时间线显式因果关系",
    });
  });

  it("超过上限时优先保留有连边的节点", () => {
    const manyNodes: KnowledgeGraphSnapshot = {
      builtAt: "2026-01-01T00:00:00.000Z",
      nodes: Array.from({ length: 20 }, (_, index) => ({
        id: `entity:${index}`,
        label: `实体${index}`,
        kind: "entity" as const,
        description: "",
        aliases: [],
        sourceRefs: [],
      })),
      edges: [
        {
          id: "relation:0:1",
          from: "entity:0",
          to: "entity:1",
          label: "相关",
          kind: "relation",
          sourceRefs: [],
        },
      ],
      documents: [],
    };

    const graph = projectWorldGraph(manyNodes, null, 5);
    expect(graph.nodes).toHaveLength(5);
    // 有边的 entity:0 / entity:1 必须保留。
    expect(graph.nodes.some((node) => node.uuid === "entity:0")).toBe(true);
    expect(graph.nodes.some((node) => node.uuid === "entity:1")).toBe(true);
    // 被截断节点对应的边一并丢弃。
    expect(
      graph.edges.every(
        (edge) =>
          graph.nodes.some((n) => n.uuid === edge.source_node_uuid) &&
          graph.nodes.some((n) => n.uuid === edge.target_node_uuid),
      ),
    ).toBe(true);
  });

  it("投影结果满足 GraphPanel.vue 的完整数据契约", () => {
    const graph = projectWorldGraph(knowledge, simulation);
    for (const node of graph.nodes) {
      expect(typeof node.uuid).toBe("string");
      expect(typeof node.name).toBe("string");
      expect(Array.isArray(node.labels)).toBe(true);
      expect(node.attributes).toBeTypeOf("object");
      expect(typeof node.summary).toBe("string");
    }
    for (const edge of graph.edges) {
      expect(typeof edge.uuid).toBe("string");
      expect(typeof edge.source_node_uuid).toBe("string");
      expect(typeof edge.target_node_uuid).toBe("string");
      expect(typeof edge.name).toBe("string");
      expect(typeof edge.fact_type).toBe("string");
    }
  });
});
