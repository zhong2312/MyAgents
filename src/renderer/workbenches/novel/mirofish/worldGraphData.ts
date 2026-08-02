import type { WorkbenchSimulationWorldSnapshot, WorkbenchStorage } from "@/workbench-sdk";

import { buildKnowledgeGraphFromStorage, type KnowledgeGraphSnapshot } from "../knowledgeGraph";

/**
 * 世界图谱数据投影：把 MyAgents 的知识图谱（实体/设定/空间/词条/事实/引用）
 * 与世界推演快照（行动主体/地点/已发生事件）统一投影为上游 MiroFish
 * GraphPanel.vue 期望的 graphData 格式。纯函数，便于单元测试。
 */

export interface WorldGraphNode {
  readonly uuid: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly summary: string;
}

export interface WorldGraphEdge {
  readonly uuid: string;
  /** GraphPanel.vue 读取的字段名（上游契约），不是 source/target。 */
  readonly source_node_uuid: string;
  readonly target_node_uuid: string;
  readonly name: string;
  readonly fact_type: string;
  readonly fact: string;
}

export interface WorldGraphPanelData {
  readonly nodes: readonly WorldGraphNode[];
  readonly edges: readonly WorldGraphEdge[];
}

const KNOWLEDGE_KIND_LABELS: Readonly<Record<string, string>> = {
  entity: "实体",
  setting: "设定",
  entry: "词条",
  heading: "章节",
  fact: "事实",
};

const KNOWLEDGE_EDGE_LABELS: Readonly<Record<string, string>> = {
  contains: "包含",
  "uses-template": "使用模板",
  parent: "包含",
  "defined-in": "属于",
  mentions: "提及",
  relation: "相关",
};

function knowledgeAttributes(node: { aliases: readonly string[]; sourceRefs: readonly { path: string; line?: number; jsonPointer?: string }[] }): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (node.aliases.length) attributes["别名"] = node.aliases.join("、");
  const source = node.sourceRefs[0];
  if (source) attributes["来源"] = source.line ? `${source.path}:${source.line}` : source.path;
  return attributes;
}

/**
 * 融合投影：知识图谱 + 世界推演快照（可选）。
 * maxNodes 上限用于防止 d3 力导向图在超大项目上卡顿；优先保留有连边的节点。
 */
export function projectWorldGraph(
  knowledge: KnowledgeGraphSnapshot,
  simulation: WorkbenchSimulationWorldSnapshot | null,
  maxNodes = 250,
): WorldGraphPanelData {
  const nodes = new Map<string, WorldGraphNode>();
  const edges = new Map<string, WorldGraphEdge>();

  const addNode = (node: WorldGraphNode): void => {
    if (!nodes.has(node.uuid)) nodes.set(node.uuid, node);
  };

  for (const node of knowledge.nodes) {
    const labels: string[] = [];
    const kindLabel = KNOWLEDGE_KIND_LABELS[node.kind] ?? node.kind;
    if (kindLabel) labels.push(kindLabel);
    addNode({
      uuid: node.id,
      name: node.label,
      labels,
      attributes: knowledgeAttributes(node),
      summary: node.description || "",
    });
  }

  for (const edge of knowledge.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    edges.set(edge.id, {
      uuid: edge.id,
      source_node_uuid: edge.from,
      target_node_uuid: edge.to,
      name: edge.label || (KNOWLEDGE_EDGE_LABELS[edge.kind] ?? "相关"),
      fact_type: edge.kind,
      fact: "",
    });
  }

  if (simulation) {
    for (const actor of simulation.actors) {
      const kindLabel = actor.kind === "faction" ? "势力" : actor.kind === "group" ? "群体" : "人物";
      addNode({
        uuid: `actor:${actor.id}`,
        name: actor.name,
        labels: [kindLabel],
        attributes: actor.goals.length ? { 目标: actor.goals.join("；") } : {},
        summary: actor.summary || "",
      });
    }
    for (const location of simulation.locations) {
      addNode({
        uuid: `location:${location.id}`,
        name: location.name,
        labels: ["地点"],
        attributes: {},
        summary: location.summary || "",
      });
    }
    for (const event of simulation.timelineEvents) {
      addNode({
        uuid: `event:${event.id}`,
        name: event.title,
        labels: ["事件"],
        attributes: event.timeLabel ? { 时间: event.timeLabel } : {},
        summary: event.summary || "",
      });
    }
    for (const event of simulation.timelineEvents) {
      for (const actorId of event.actorIds) {
        if (nodes.has(`actor:${actorId}`)) {
          edges.set(`event-actor:${event.id}:${actorId}`, {
            uuid: `event-actor:${event.id}:${actorId}`,
            source_node_uuid: `actor:${actorId}`,
            target_node_uuid: `event:${event.id}`,
            name: "参与",
            fact_type: "参与",
            fact: "",
          });
        }
      }
      for (const locationId of event.locationIds) {
        if (nodes.has(`location:${locationId}`)) {
          edges.set(`event-location:${event.id}:${locationId}`, {
            uuid: `event-location:${event.id}:${locationId}`,
            source_node_uuid: `location:${locationId}`,
            target_node_uuid: `event:${event.id}`,
            name: "发生地",
            fact_type: "发生地",
            fact: "",
          });
        }
      }
      for (const causeEventId of event.causeEventIds ?? []) {
        if (nodes.has(`event:${causeEventId}`)) {
          edges.set(`event-cause:${causeEventId}:${event.id}`, {
            uuid: `event-cause:${causeEventId}:${event.id}`,
            source_node_uuid: `event:${causeEventId}`,
            target_node_uuid: `event:${event.id}`,
            name: "导致",
            fact_type: "causes",
            fact: "时间线显式因果关系",
          });
        }
      }
    }
  }

  // 关联度排序：有边的节点优先保留；其余按名称补齐到上限。
  const connected = new Set<string>();
  for (const edge of edges.values()) {
    connected.add(edge.source_node_uuid);
    connected.add(edge.target_node_uuid);
  }
  const prioritized = [...nodes.values()].sort((left, right) => {
    const leftConnected = connected.has(left.uuid) ? 1 : 0;
    const rightConnected = connected.has(right.uuid) ? 1 : 0;
    return rightConnected - leftConnected || left.name.localeCompare(right.name, "zh-CN");
  });
  const kept = new Set(prioritized.slice(0, maxNodes).map((node) => node.uuid));
  const keptNodes = prioritized.filter((node) => kept.has(node.uuid));
  const keptEdges = [...edges.values()].filter(
    (edge) => kept.has(edge.source_node_uuid) && kept.has(edge.target_node_uuid),
  );

  return Object.freeze({
    nodes: Object.freeze(keptNodes),
    edges: Object.freeze(keptEdges),
  });
}

export async function buildWorldGraphData(
  storage: WorkbenchStorage,
  simulation?: WorkbenchSimulationWorldSnapshot | null,
): Promise<WorldGraphPanelData> {
  const knowledge = await buildKnowledgeGraphFromStorage(storage);
  return projectWorldGraph(knowledge, simulation ?? null);
}
