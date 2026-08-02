import type { WorkbenchStorage } from "@/workbench-sdk";

export type KnowledgeNodeKind =
  | "entity"
  | "setting"
  | "entry"
  | "heading"
  | "fact";

/** 节点类型中文标签（列表/图谱/百科共用）。 */
export const KIND_LABELS: Readonly<Record<KnowledgeNodeKind, string>> =
  Object.freeze({
    entity: "实体",
    setting: "设定",
    entry: "词条",
    heading: "正文标题",
    fact: "事实",
  });

export type KnowledgeEdgeKind =
  | "contains"
  | "uses-template"
  | "parent"
  | "defined-in"
  | "mentions"
  | "relation";

export interface KnowledgeSourceRef {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly jsonPointer?: string;
  readonly anchor?: string;
}

export interface KnowledgeNode {
  readonly id: string;
  readonly label: string;
  readonly kind: KnowledgeNodeKind;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly sourceRefs: readonly KnowledgeSourceRef[];
}

export interface KnowledgeEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind: KnowledgeEdgeKind;
  readonly sourceRefs: readonly KnowledgeSourceRef[];
}

export interface KnowledgeDocument {
  readonly path: string;
  readonly content: string;
  readonly lineCount: number;
}

export interface KnowledgeGraphSnapshot {
  readonly builtAt: string;
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
  readonly documents: readonly KnowledgeDocument[];
}

export interface KnowledgeSearchResult {
  readonly node: KnowledgeNode;
  readonly score: number;
  readonly snippet: string;
  readonly matchedBy: readonly ("名称" | "别名" | "内容" | "来源")[];
}

const INDEXABLE_EXTENSIONS = new Set([".md", ".json"]);
const IGNORED_PREFIXES = [
  ".git/",
  "prompts/",
  "world/setting-library/proposals/",
];

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function safeJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!asRecord(item))
    : [];
}

function pointerFor(index: number, key = "items"): string {
  return `/${key}/${index}`;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function sourceSnippet(document: KnowledgeDocument, source: KnowledgeSourceRef, fallback: string): string {
  if (!source.line) return fallback;
  const lines = document.content.split("\n");
  return lines.slice(Math.max(0, source.line - 1), source.endLine ?? source.line + 1).join(" ").trim() || fallback;
}

async function listFiles(storage: WorkbenchStorage, directory = ""): Promise<readonly string[]> {
  const entries = await storage.list(directory);
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      paths.push(...(await listFiles(storage, entry.path)));
      continue;
    }
    const lower = entry.path.toLocaleLowerCase("en-US");
    const extension = lower.slice(lower.lastIndexOf("."));
    if (!INDEXABLE_EXTENSIONS.has(extension)) continue;
    if (IGNORED_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    paths.push(entry.path);
  }
  return paths;
}

export async function readKnowledgeDocuments(
  storage: WorkbenchStorage,
): Promise<readonly KnowledgeDocument[]> {
  const paths = await listFiles(storage);
  const documents: KnowledgeDocument[] = [];
  for (const path of paths) {
    try {
      const file = await storage.readText(path);
      documents.push(Object.freeze({
        path,
        content: file.content,
        lineCount: file.content.split("\n").length,
      }));
    } catch {
      // A file can disappear between list and read; the next build will retry it.
    }
  }
  return Object.freeze(documents);
}

export function buildKnowledgeGraph(
  documents: readonly KnowledgeDocument[],
): KnowledgeGraphSnapshot {
  const nodes = new Map<string, KnowledgeNode>();
  const edges = new Map<string, KnowledgeEdge>();
  const idByLabel = new Map<string, string>();
  const idAliases = new Map<string, string>();
  const orderedDocuments = [...documents].sort((left, right) => {
    const priority = (path: string): number => {
      if (path === "knowledge/entities.json") return 0;
      if (path === "world/setting-library/spatial-tree.json") return 1;
      if (path === "world/setting-library/settings.json") return 2;
      if (path.startsWith("world/setting-library/entries/")) return 3;
      if (path === "knowledge/facts.json") return 4;
      if (path === "knowledge/relations.json") return 5;
      return 10;
    };
    return priority(left.path) - priority(right.path) || left.path.localeCompare(right.path);
  });

  const addNode = (node: KnowledgeNode): string => {
    const existing = nodes.get(node.id);
    if (existing) {
      const aliases = [...new Set([...existing.aliases, ...node.aliases])];
      const sourceRefs = [...existing.sourceRefs, ...node.sourceRefs].filter(
        (source, index, refs) => refs.findIndex((item) => JSON.stringify(item) === JSON.stringify(source)) === index,
      );
      nodes.set(node.id, Object.freeze({
        ...existing,
        description: existing.description || node.description,
        aliases: Object.freeze(aliases),
        sourceRefs: Object.freeze(sourceRefs),
      }));
      return node.id;
    }
    nodes.set(node.id, Object.freeze({
      ...node,
      aliases: Object.freeze([...new Set(node.aliases)]),
      sourceRefs: Object.freeze(node.sourceRefs),
    }));
    idByLabel.set(normalize(node.label), node.id);
    for (const alias of node.aliases) idAliases.set(normalize(alias), node.id);
    return node.id;
  };

  const resolveId = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    return nodes.has(value) ? value : idByLabel.get(normalize(value)) ?? idAliases.get(normalize(value));
  };

  const addEdge = (edge: KnowledgeEdge): void => {
    if (edge.from === edge.to || !nodes.has(edge.from) || !nodes.has(edge.to)) return;
    const existing = edges.get(edge.id);
    if (existing) {
      edges.set(edge.id, Object.freeze({
        ...existing,
        sourceRefs: Object.freeze([...existing.sourceRefs, ...edge.sourceRefs]),
      }));
      return;
    }
    edges.set(edge.id, Object.freeze(edge));
  };

  const addHeading = (
    path: string,
    content: string,
    label: string,
    index: number,
  ): string => {
    const line = lineAt(content, index);
    const id = `heading:${path}:${line}`;
    return addNode({
      id,
      label,
      kind: "heading",
      description: label,
      aliases: [],
      sourceRefs: [{ path, line, anchor: `heading-${line}` }],
    });
  };

  for (const document of orderedDocuments) {
    const headingPattern = /^#{1,6}\s+(.+)$/gmu;
    let heading: RegExpExecArray | null;
    while ((heading = headingPattern.exec(document.content))) {
      const id = addHeading(
        document.path,
        document.content,
        heading[1].trim(),
        heading.index,
      );
      idByLabel.set(normalize(heading[1]), id);
    }

    const parsed = document.path.endsWith(".json") ? safeJson(document.content) : undefined;
    const root = asRecord(parsed);
    if (!root) continue;

    if (document.path === "world/setting-library/spatial-tree.json") {
      for (const [index, item] of asRecords(root.nodes).entries()) {
        const idValue = recordValue(item, ["id"]);
        const name = recordValue(item, ["name", "title"]) ?? idValue;
        if (!idValue || !name) continue;
        addNode({
          id: `space:${idValue}`,
          label: name,
          kind: "entity",
          description: recordValue(item, ["typeId"]) ?? "空间节点",
          aliases: [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "nodes") }],
        });
      }
      for (const item of asRecords(root.nodes)) {
        const child = resolveId(`space:${recordValue(item, ["id"])}`);
        const parentValue = recordValue(item, ["parentId"]);
        const parent = parentValue ? resolveId(`space:${parentValue}`) : undefined;
        if (child && parent) addEdge({
          id: `parent:${parent}:${child}`,
          from: parent,
          to: child,
          label: "包含",
          kind: "parent",
          sourceRefs: [{ path: document.path }],
        });
      }
    }

    if (document.path === "world/setting-library/settings.json") {
      for (const [index, item] of asRecords(root.settings).entries()) {
        const idValue = recordValue(item, ["id"]);
        const name = recordValue(item, ["name", "title"]) ?? idValue;
        if (!idValue || !name) continue;
        addNode({
          id: `setting:${idValue}`,
          label: name,
          kind: "setting",
          description: recordValue(item, ["group", "status"]) ?? "设定页面",
          aliases: [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "settings") }],
        });
        const space = resolveId(`space:${recordValue(item, ["nodeId"])}`);
        if (space) addEdge({
          id: `contains:${space}:setting:${idValue}`,
          from: space,
          to: `setting:${idValue}`,
          label: "包含设定",
          kind: "contains",
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "settings") }],
        });
      }
    }

    if (document.path.startsWith("world/setting-library/entries/") && document.path.endsWith(".json")) {
      const settingId = document.path.split("/").at(-1)?.replace(/\.json$/u, "");
      const setting = settingId ? resolveId(`setting:${settingId}`) : undefined;
      for (const [index, item] of asRecords(root.entries).entries()) {
        const idValue = recordValue(item, ["id"]) ?? `${settingId ?? "entry"}-${index}`;
        const name = recordValue(item, ["name", "title"]) ?? idValue;
        const definition = recordValue(item, ["definition", "description"]) ?? "设定词条";
        const nodeId = addNode({
          id: `entry:${document.path}:${idValue}`,
          label: name,
          kind: "entry",
          description: definition,
          aliases: Array.isArray(item.aliases) ? item.aliases.filter((value): value is string => typeof value === "string") : [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "entries") }],
        });
        if (setting) addEdge({
          id: `defined-in:${nodeId}:${setting}`,
          from: nodeId,
          to: setting,
          label: "属于设定",
          kind: "defined-in",
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "entries") }],
        });
      }
    }

    if (document.path === "knowledge/relations.json") {
      for (const [index, item] of asRecords(root.relations).entries()) {
        const from = resolveId(recordValue(item, ["from", "fromId", "source", "sourceId"]));
        const to = resolveId(recordValue(item, ["to", "toId", "target", "targetId"]));
        if (!from || !to) continue;
        addEdge({
          id: `relation:${from}:${to}:${index}`,
          from,
          to,
          label: recordValue(item, ["type", "label", "relation"]) ?? "相关",
          kind: "relation",
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "relations") }],
        });
      }
    }

    if (document.path === "knowledge/entities.json") {
      for (const [index, item] of asRecords(root.entities).entries()) {
        const idValue = recordValue(item, ["id", "key"]) ?? `entity-${index}`;
        const label = recordValue(item, ["name", "title", "label"]) ?? idValue;
        const nodeId = addNode({
          id: `entity:${idValue}`,
          label,
          kind: "entity",
          description: recordValue(item, ["description", "definition", "summary"]) ?? "知识实体",
          aliases: Array.isArray(item.aliases) ? item.aliases.filter((value): value is string => typeof value === "string") : [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "entities") }],
        });
        idByLabel.set(normalize(idValue), nodeId);
      }
    }

    if (document.path === "knowledge/facts.json") {
      for (const [index, item] of asRecords(root.facts).entries()) {
        const idValue = recordValue(item, ["id"]) ?? `fact-${index}`;
        const label = recordValue(item, ["name", "title", "subject"]) ?? idValue;
        addNode({
          id: `fact:${idValue}`,
          label,
          kind: "fact",
          description: recordValue(item, ["content", "definition", "description"]) ?? "知识事实",
          aliases: [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "facts") }],
        });
      }
    }

    if (document.path !== "world/setting-library/settings.json" && document.path !== "world/setting-library/spatial-tree.json" && !document.path.startsWith("world/setting-library/entries/") && !document.path.startsWith("knowledge/")) {
      for (const [key, value] of Object.entries(root)) {
        for (const [index, item] of asRecords(value).entries()) {
          const idValue = recordValue(item, ["id", "slug", "key"]);
          const label = recordValue(item, ["name", "title", "label"]) ?? idValue;
          if (!idValue || !label) continue;
          addNode({
            id: `entity:${document.path}:${idValue}`,
            label,
            kind: "entity",
            description: recordValue(item, ["description", "definition", "summary"]) ?? key,
            aliases: Array.isArray(item.aliases) ? item.aliases.filter((value): value is string => typeof value === "string") : [],
            sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, key) }],
          });
          idByLabel.set(normalize(idValue), `entity:${document.path}:${idValue}`);
        }
      }
    }
  }

  for (const document of orderedDocuments) {
    const headingNodes = [...nodes.values()].filter((node) => node.sourceRefs.some((source) => source.path === document.path && node.kind === "heading"));
    for (const heading of headingNodes) {
      const source = heading.sourceRefs.find((item) => item.path === document.path);
      if (!source) continue;
      const line = source.line ?? 1;
      const headingContent = document.content.split("\n").slice(line - 1, line + 8).join("\n");
      const linkPattern = /\[\[([^\]]+)\]\]/gu;
      let link: RegExpExecArray | null;
      while ((link = linkPattern.exec(headingContent))) {
        const label = link[1].trim();
        const target = resolveId(label) ?? addNode({
          id: `entity:term:${normalize(label)}`,
          label,
          kind: "entity",
          description: "Markdown 显式引用",
          aliases: [],
          sourceRefs: [{ path: document.path, line: line + lineAt(headingContent, link.index) - 1 }],
        });
        addEdge({
          id: `mentions:${heading.id}:${target}`,
          from: heading.id,
          to: target,
          label: "提及",
          kind: "mentions",
          sourceRefs: [{ path: document.path, line }],
        });
      }
    }
  }

  return Object.freeze({
    builtAt: new Date().toISOString(),
    nodes: Object.freeze([...nodes.values()]),
    edges: Object.freeze([...edges.values()]),
    documents: Object.freeze([...documents]),
  });
}

export async function buildKnowledgeGraphFromStorage(
  storage: WorkbenchStorage,
): Promise<KnowledgeGraphSnapshot> {
  return buildKnowledgeGraph(await readKnowledgeDocuments(storage));
}

function scoreNode(node: KnowledgeNode, query: string): { score: number; matchedBy: KnowledgeSearchResult["matchedBy"] } {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return { score: 0, matchedBy: [] };
  const matchedBy: ("名称" | "别名" | "内容" | "来源")[] = [];
  let score = 0;
  if (normalize(node.label).includes(normalizedQuery)) {
    score += normalize(node.label) === normalizedQuery ? 100 : 80;
    matchedBy.push("名称");
  }
  if (node.aliases.some((alias) => normalize(alias).includes(normalizedQuery))) {
    score = Math.max(score, 70);
    matchedBy.push("别名");
  }
  if (normalize(node.description).includes(normalizedQuery)) {
    score = Math.max(score, 45);
    matchedBy.push("内容");
  }
  if (node.sourceRefs.some((source) => normalize(source.path).includes(normalizedQuery))) {
    score = Math.max(score, 30);
    matchedBy.push("来源");
  }
  return { score, matchedBy: [...new Set(matchedBy)] };
}

export function searchKnowledgeGraph(
  snapshot: KnowledgeGraphSnapshot,
  query: string,
  kind?: KnowledgeNodeKind,
): readonly KnowledgeSearchResult[] {
  const documents = new Map(snapshot.documents.map((document) => [document.path, document]));
  return snapshot.nodes
    .filter((node) => !kind || node.kind === kind)
    .map((node) => {
      const result = scoreNode(node, query);
      const source = node.sourceRefs[0];
      const document = source ? documents.get(source.path) : undefined;
      return {
        node,
        score: result.score,
        matchedBy: result.matchedBy,
        snippet: document && source ? sourceSnippet(document, source, node.description) : node.description,
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label, "zh-CN"));
}

export function getKnowledgeNeighbors(
  snapshot: KnowledgeGraphSnapshot,
  nodeId: string,
): readonly { edge: KnowledgeEdge; node: KnowledgeNode }[] {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return snapshot.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => ({ edge, node: nodes.get(edge.from === nodeId ? edge.to : edge.from) }))
    .filter((item): item is { edge: KnowledgeEdge; node: KnowledgeNode } => !!item.node);
}
