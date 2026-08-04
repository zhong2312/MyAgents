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
      if (path.startsWith("world/setting-library/pages/")) return 6;
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
    const headingPattern = /^(#{1,6})\s+(.+)$/gmu;
    const headingMatches: readonly {
      readonly level: number;
      readonly index: number;
      readonly line: number;
      readonly label: string;
    }[] = (() => {
      const collected: { level: number; index: number; line: number; label: string }[] = [];
      let match: RegExpExecArray | null;
      while ((match = headingPattern.exec(document.content))) {
        collected.push({
          level: match[1].length,
          index: match.index,
          line: lineAt(document.content, match.index),
          label: match[2].trim(),
        });
      }
      return collected;
    })();

    // 标题节点 + 标题层级树 + 小节正文摘要（设定页 Markdown 正文由此进入图谱）
    const headingStack: { level: number; id: string }[] = [];
    for (let index = 0; index < headingMatches.length; index += 1) {
      const heading = headingMatches[index];
      const id = addHeading(
        document.path,
        document.content,
        heading.label,
        heading.index,
      );
      idByLabel.set(normalize(heading.label), id);
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1].level >= heading.level
      ) {
        headingStack.pop();
      }
      if (headingStack.length) {
        addEdge({
          id: `parent:${headingStack[headingStack.length - 1].id}:${id}`,
          from: headingStack[headingStack.length - 1].id,
          to: id,
          label: "包含",
          kind: "parent",
          sourceRefs: [{ path: document.path }],
        });
      }
      headingStack.push({ level: heading.level, id });
      const lineEnd = document.content.indexOf("\n", heading.index);
      const sectionStart = lineEnd === -1 ? document.content.length : lineEnd + 1;
      const nextIndex =
        index + 1 < headingMatches.length
          ? headingMatches[index + 1].index
          : document.content.length;
      const section = document.content.slice(sectionStart, nextIndex).trim();
      if (section) {
        const existing = nodes.get(id);
        if (existing) {
          nodes.set(
            id,
            Object.freeze({ ...existing, description: section.slice(0, 200) }),
          );
        }
      }
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

  // 设定页 Markdown 与设定索引打通：settings.json 的 pagePath -> 页面首个标题节点
  for (const document of orderedDocuments) {
    if (document.path !== "world/setting-library/settings.json") continue;
    const root = asRecord(safeJson(document.content));
    for (const item of asRecords(root?.settings)) {
      const idValue = recordValue(item, ["id"]);
      const pagePath = recordValue(item, ["pagePath"]);
      if (!idValue || !pagePath) continue;
      const settingId = resolveId(`setting:${idValue}`);
      if (!settingId) continue;
      const firstHeading = [...nodes.values()]
        .filter(
          (node) =>
            node.kind === "heading" &&
            node.sourceRefs.some((source) => source.path === pagePath),
        )
        .sort(
          (left, right) =>
            (left.sourceRefs[0]?.line ?? 1) - (right.sourceRefs[0]?.line ?? 1),
        )[0];
      if (firstHeading) {
        addEdge({
          id: `contains:${settingId}:${firstHeading.id}`,
          from: settingId,
          to: firstHeading.id,
          label: "包含章节",
          kind: "contains",
          sourceRefs: [{ path: document.path }],
        });
      }
    }
  }

  // 全文档 Markdown 链接提取：稳定链接 [[kind:id|名称]] 与旧式 [[名称]]
  const stableLinkPattern = /\[\[([a-zA-Z]+):([a-zA-Z0-9-]+)(?:\|([^\]]+))?\]\]/gu;
  const legacyLinkPattern = /\[\[([^[\]|:]+)\]\]/gu;
  const stableKindPaths: Readonly<Record<string, string>> = Object.freeze({
    character: "characters/index.json",
    location: "world/locations/index.json",
    faction: "world/factions/index.json",
    item: "world/items/index.json",
    event: "timeline/index.json",
  });
  const resolveStableTarget = (
    kind: string,
    id: string,
    label: string,
  ): string | undefined => {
    const kindPath = stableKindPaths[kind];
    if (kindPath) {
      const viaPath = resolveId(`entity:${kindPath}:${id}`);
      if (viaPath) return viaPath;
    }
    if (kind === "setting") {
      const viaSetting = resolveId(`setting:${id}`);
      if (viaSetting) return viaSetting;
    }
    if (kind === "space") {
      const viaSpace = resolveId(`space:${id}`);
      if (viaSpace) return viaSpace;
    }
    return resolveId(label);
  };
  for (const document of orderedDocuments) {
    if (!document.path.endsWith(".md")) continue;
    const headingLines = [...nodes.values()]
      .filter(
        (node) =>
          node.kind === "heading" &&
          node.sourceRefs.some((source) => source.path === document.path),
      )
      .map((node) => ({
        node,
        line: node.sourceRefs.find((source) => source.path === document.path)
          ?.line ?? 1,
      }))
      .sort((left, right) => left.line - right.line);
    if (headingLines.length === 0) continue;
    const lines = document.content.split("\n");
    let ownerIndex = -1;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.includes("[[")) continue;
      const lineNumber = lineIndex + 1;
      while (
        ownerIndex + 1 < headingLines.length &&
        headingLines[ownerIndex + 1].line <= lineNumber
      ) {
        ownerIndex += 1;
      }
      const owner =
        ownerIndex >= 0 ? headingLines[ownerIndex].node : undefined;
      if (!owner) continue;
      stableLinkPattern.lastIndex = 0;
      let stable: RegExpExecArray | null;
      while ((stable = stableLinkPattern.exec(line))) {
        const label = stable[3]?.trim() || stable[2];
        const target =
          resolveStableTarget(stable[1], stable[2], label) ??
          addNode({
            id: `entity:term:${normalize(label)}`,
            label,
            kind: "entity",
            description: "Markdown 显式引用",
            aliases: [],
            sourceRefs: [{ path: document.path, line: lineNumber }],
          });
        addEdge({
          id: `mentions:${owner.id}:${target}`,
          from: owner.id,
          to: target,
          label: "提及",
          kind: "mentions",
          sourceRefs: [{ path: document.path, line: lineNumber }],
        });
      }
      legacyLinkPattern.lastIndex = 0;
      let legacy: RegExpExecArray | null;
      while ((legacy = legacyLinkPattern.exec(line))) {
        const label = legacy[1].trim();
        if (!label) continue;
        const target =
          resolveId(label) ??
          addNode({
            id: `entity:term:${normalize(label)}`,
            label,
            kind: "entity",
            description: "Markdown 显式引用",
            aliases: [],
            sourceRefs: [{ path: document.path, line: lineNumber }],
          });
        addEdge({
          id: `mentions:${owner.id}:${target}`,
          from: owner.id,
          to: target,
          label: "提及",
          kind: "mentions",
          sourceRefs: [{ path: document.path, line: lineNumber }],
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
