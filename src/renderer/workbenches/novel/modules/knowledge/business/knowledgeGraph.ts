import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  isKnowledgeSourcePath,
  normalizeKnowledgePath,
} from "../../../../../../shared/workbenches/novel/knowledgeScope";
import { TIMELINE_INDEX_PATH } from "../../../../../../shared/workbenches/novel/timelineStorage";
import { FACTION_INDEX_PATH } from "../../../../../../shared/workbenches/novel/factionStorage";
import { LOCATION_INDEX_PATH } from "../../../../../../shared/workbenches/novel/locationStorage";
import {
  KNOWLEDGE_COLLECTIONS,
  KNOWLEDGE_DIRECTORY,
  KNOWLEDGE_LEGACY_PATHS,
  knowledgeIndexPath,
  loadKnowledgeFiles,
  type KnowledgeCollection,
} from "../../../../../../shared/workbenches/novel/knowledgeStorage";
import {
  buildDomainIndex,
  type DomainEntityRef,
} from "../../../shared/business/domainIndex";

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
  /** 派生快照对应的事实源哈希，仅用于缓存失效判断。 */
  readonly sourceHash?: string;
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
  readonly documents: readonly KnowledgeDocument[];
  readonly diagnostics: readonly KnowledgeDiagnostic[];
}

export type KnowledgeDiagnosticKind =
  | "invalid-json"
  | "dangling-reference"
  | "ambiguous-label"
  | "source-read";

export interface KnowledgeDiagnostic {
  readonly kind: KnowledgeDiagnosticKind;
  readonly message: string;
  readonly source?: KnowledgeSourceRef;
}

export interface KnowledgeSearchResult {
  readonly node: KnowledgeNode;
  readonly score: number;
  readonly snippet: string;
  readonly matchedBy: readonly ("名称" | "别名" | "内容" | "来源")[];
}

const TIMELINE_RECORD_PATH_PATTERN =
  /^timeline\/(?:calendars|periods|views|branches|events)\/records\/[a-z0-9][a-z0-9-]*\.json$/u;
const FACTION_RECORD_PATH_PATTERN =
  /^world\/factions\/records\/[a-z0-9][a-z0-9-]*\.json$/u;
const LOCATION_RECORD_PATH_PATTERN =
  /^world\/locations\/records\/[a-z0-9][a-z0-9-]*\.json$/u;
const KNOWLEDGE_RECORD_PATH_PATTERN =
  /^knowledge\/(entities|relations|facts)\/records\/([a-z0-9][a-z0-9-]*)\.json$/u;
const DOMAIN_MANIFEST_PATHS = new Set([
  "characters/index.json",
  "world/items/index.json",
  "world/locations/index.json",
  "world/factions/index.json",
  "timeline/index.json",
  "narrative/index.json",
  "inspiration/index.json",
  "world/maps/index.json",
  "world/cultivation/index.json",
  "manuscript/index.json",
]);

function domainNodeId(entity: DomainEntityRef): string {
  const legacyPaths: Readonly<Record<string, string>> = {
    character: "characters/index.json",
    item: "world/items/index.json",
    location: LOCATION_INDEX_PATH,
    faction: FACTION_INDEX_PATH,
    event: TIMELINE_INDEX_PATH,
  };
  const legacyPath = legacyPaths[entity.kind];
  return legacyPath
    ? `entity:${legacyPath}:${entity.id}`
    : `domain:${entity.kind}:${entity.id}`;
}

function knowledgeRecordDescriptor(
  path: string,
): { readonly collection: KnowledgeCollection; readonly id: string } | null {
  const match = KNOWLEDGE_RECORD_PATH_PATTERN.exec(path);
  if (!match) return null;
  return {
    collection: match[1] as KnowledgeCollection,
    id: match[2],
  };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function knowledgeSourceHash(documents: readonly KnowledgeDocument[]): string {
  let hash = 0x811c9dc5;
  const source = documents
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((document) => `${document.path}\u0000${document.content}`)
    .join("\u0001");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function sourceSnippet(
  document: KnowledgeDocument,
  source: KnowledgeSourceRef,
  fallback: string,
): string {
  if (!source.line) return fallback;
  const lines = document.content.split("\n");
  return (
    lines
      .slice(Math.max(0, source.line - 1), source.endLine ?? source.line + 1)
      .join(" ")
      .trim() || fallback
  );
}

async function listFiles(
  storage: WorkbenchStorage,
  directory = "",
): Promise<readonly string[]> {
  const entries = await storage.list(directory);
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory") {
      paths.push(...(await listFiles(storage, entry.path)));
      continue;
    }
    if (isKnowledgeSourcePath(entry.path)) paths.push(normalizeKnowledgePath(entry.path));
  }
  return paths;
}

export async function readKnowledgeDocuments(
  storage: WorkbenchStorage,
): Promise<readonly KnowledgeDocument[]> {
  const paths = await listFiles(storage);
  const documents: KnowledgeDocument[] = [];
  const pathSet = new Set(paths);
  const legacyPath = KNOWLEDGE_LEGACY_PATHS.find((path) => pathSet.has(path));
  if (legacyPath) {
    throw new Error(
      `${legacyPath} 是旧单文件知识库；当前目录协议不兼容且不迁移`,
    );
  }
  const knowledgePaths = paths.filter((path) =>
    path.startsWith(`${KNOWLEDGE_DIRECTORY}/`),
  );
  if (knowledgePaths.length) {
    const missingIndexes = KNOWLEDGE_COLLECTIONS.map(knowledgeIndexPath).filter(
      (path) => !pathSet.has(path),
    );
    if (missingIndexes.length) {
      throw new Error(`知识库缺少根索引：${missingIndexes.join("、")}`);
    }
    const loaded = await loadKnowledgeFiles(
      async (path) => (await storage.readText(path)).content,
    );
    for (const [path, content] of loaded.files) {
      documents.push(
        Object.freeze({
          path,
          content,
          lineCount: content.split("\n").length,
        }),
      );
    }
  }
  for (const path of paths.filter(
    (path) => !path.startsWith(`${KNOWLEDGE_DIRECTORY}/`),
  )) {
    try {
      const file = await storage.readText(path);
      documents.push(
        Object.freeze({
          path,
          content: file.content,
          lineCount: file.content.split("\n").length,
        }),
      );
    } catch {
      // A file can disappear between list and read; the next build will retry it.
    }
  }
  return Object.freeze(documents);
}

export function buildKnowledgeGraph(
  documents: readonly KnowledgeDocument[],
  domainEntities: readonly DomainEntityRef[] = [],
): KnowledgeGraphSnapshot {
  const nodes = new Map<string, KnowledgeNode>();
  const edges = new Map<string, KnowledgeEdge>();
  const diagnostics: KnowledgeDiagnostic[] = [];
  const ambiguityKeys = new Set<string>();
  const idByLabel = new Map<string, string>();
  const idAliases = new Map<string, string>();
  const orderedDocuments = [...documents].sort((left, right) => {
    const priority = (path: string): number => {
      const knowledgeRecord = knowledgeRecordDescriptor(path);
      if (knowledgeRecord?.collection === "entities") return 0;
      if (path === "world/setting-library/spatial-tree.json") return 1;
      if (path === "world/setting-library/settings.json") return 2;
      if (path.startsWith("world/setting-library/entries/")) return 3;
      if (path.startsWith("world/setting-library/pages/")) return 6;
      if (knowledgeRecord?.collection === "facts") return 4;
      if (knowledgeRecord?.collection === "relations") return 5;
      return 10;
    };
    return (
      priority(left.path) - priority(right.path) ||
      left.path.localeCompare(right.path)
    );
  });

  const addNode = (node: KnowledgeNode): string => {
    const existing = nodes.get(node.id);
    if (existing) {
      const aliases = [...new Set([...existing.aliases, ...node.aliases])];
      const sourceRefs = [...existing.sourceRefs, ...node.sourceRefs].filter(
        (source, index, refs) =>
          refs.findIndex(
            (item) => JSON.stringify(item) === JSON.stringify(source),
          ) === index,
      );
      nodes.set(
        node.id,
        Object.freeze({
          ...existing,
          description: existing.description || node.description,
          aliases: Object.freeze(aliases),
          sourceRefs: Object.freeze(sourceRefs),
        }),
      );
      return node.id;
    }
    nodes.set(
      node.id,
      Object.freeze({
        ...node,
        aliases: Object.freeze([...new Set(node.aliases)]),
        sourceRefs: Object.freeze(node.sourceRefs),
      }),
    );
    const normalizedLabel = normalize(node.label);
    const previous = idByLabel.get(normalizedLabel);
    if (previous && previous !== node.id) {
      const key = `${normalizedLabel}:${previous}:${node.id}`;
      if (!ambiguityKeys.has(key)) {
        ambiguityKeys.add(key);
        diagnostics.push({
          kind: "ambiguous-label",
          message: `标签“${node.label}”对应多个实体`,
          source: node.sourceRefs[0],
        });
      }
    } else {
      idByLabel.set(normalizedLabel, node.id);
    }
    for (const alias of node.aliases) idAliases.set(normalize(alias), node.id);
    return node.id;
  };

  const resolveId = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    return nodes.has(value)
      ? value
      : (idByLabel.get(normalize(value)) ?? idAliases.get(normalize(value)));
  };

  const addEdge = (edge: KnowledgeEdge): void => {
    if (edge.from === edge.to) return;
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      diagnostics.push({
        kind: "dangling-reference",
        message: `关系“${edge.label}”引用了不存在的节点`,
        source: edge.sourceRefs[0],
      });
      return;
    }
    const existing = edges.get(edge.id);
    if (existing) {
      edges.set(
        edge.id,
        Object.freeze({
          ...existing,
          sourceRefs: Object.freeze([
            ...existing.sourceRefs,
            ...edge.sourceRefs,
          ]),
        }),
      );
      return;
    }
    edges.set(edge.id, Object.freeze(edge));
  };

  // 领域库已经有各自的 Schema/Repository，这里只消费它们的最小投影，
  // 避免用通用 JSON 数组猜测实体并产生重复节点。
  for (const entity of domainEntities) {
    const nodeId = domainNodeId(entity);
    addNode({
      id: nodeId,
      label: entity.name,
      kind: "entity",
      description: entity.summary,
      aliases: entity.aliases,
      sourceRefs: [{ path: entity.sourcePath }],
    });
    idByLabel.set(normalize(entity.id), nodeId);
  }

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
      const collected: {
        level: number;
        index: number;
        line: number;
        label: string;
      }[] = [];
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
      const sectionStart =
        lineEnd === -1 ? document.content.length : lineEnd + 1;
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

    const parsed = document.path.endsWith(".json")
      ? safeJson(document.content)
      : undefined;
    if (document.path.endsWith(".json") && parsed === undefined) {
      diagnostics.push({
        kind: "invalid-json",
        message: `无法解析 JSON：${document.path}`,
        source: { path: document.path },
      });
    }
    const root = asRecord(parsed);
    if (!root) continue;
    const isTimelineRecord = TIMELINE_RECORD_PATH_PATTERN.test(document.path);
    const isFactionRecord = FACTION_RECORD_PATH_PATTERN.test(document.path);
    const isLocationRecord = LOCATION_RECORD_PATH_PATTERN.test(document.path);

    // 纯函数构建入口没有 storage/domainIndex 参数时，仍需兼容旧的
    // characters/index.json 稳定实体契约；从 storage 构建时会由 domainIndex
    // 提供同一节点并在 addNode 中合并来源引用。
    if (document.path === "characters/index.json") {
      for (const [index, item] of asRecords(root.characters).entries()) {
        const idValue = recordValue(item, ["id"]);
        const label = recordValue(item, ["name", "title", "label"]) ?? idValue;
        if (!idValue || !label) continue;
        const nodeId = addNode({
          id: `entity:characters/index.json:${idValue}`,
          label,
          kind: "entity",
          description: recordValue(item, ["summary", "description"]) ?? "人物记录",
          aliases: Array.isArray(item.aliases)
            ? item.aliases.filter((value): value is string => typeof value === "string")
            : [],
          sourceRefs: [{ path: document.path, jsonPointer: pointerFor(index, "characters") }],
        });
        idByLabel.set(normalize(idValue), nodeId);
      }
    }

    if (isTimelineRecord) {
      const idValue = recordValue(root, ["id"]);
      const label = recordValue(root, ["name", "title", "label"]) ?? idValue;
      if (idValue && label) {
        const nodeId = addNode({
          id: `entity:${TIMELINE_INDEX_PATH}:${idValue}`,
          label,
          kind: "entity",
          description:
            recordValue(root, ["description", "summary", "definition"]) ??
            "时间线记录",
          aliases: Array.isArray(root.aliases)
            ? root.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          sourceRefs: [{ path: document.path }],
        });
        idByLabel.set(normalize(idValue), nodeId);
      }
    }

    if (isFactionRecord) {
      const idValue = recordValue(root, ["id"]);
      const label = recordValue(root, ["name", "title", "label"]) ?? idValue;
      if (idValue && label) {
        const nodeId = addNode({
          id: `entity:${FACTION_INDEX_PATH}:${idValue}`,
          label,
          kind: "entity",
          description:
            recordValue(root, ["description", "summary", "definition"]) ??
            "势力记录",
          aliases: Array.isArray(root.aliases)
            ? root.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          sourceRefs: [{ path: document.path }],
        });
        idByLabel.set(normalize(idValue), nodeId);
      }
    }

    if (isLocationRecord) {
      const idValue = recordValue(root, ["id"]);
      const label = recordValue(root, ["name", "title", "label"]) ?? idValue;
      if (idValue && label) {
        const nodeId = addNode({
          id: `entity:${LOCATION_INDEX_PATH}:${idValue}`,
          label,
          kind: "entity",
          description:
            recordValue(root, ["description", "summary", "definition"]) ??
            "地点记录",
          aliases: Array.isArray(root.aliases)
            ? root.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          sourceRefs: [{ path: document.path }],
        });
        idByLabel.set(normalize(idValue), nodeId);
      }
    }

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
          sourceRefs: [
            { path: document.path, jsonPointer: pointerFor(index, "nodes") },
          ],
        });
      }
      for (const item of asRecords(root.nodes)) {
        const child = resolveId(`space:${recordValue(item, ["id"])}`);
        const parentValue = recordValue(item, ["parentId"]);
        const parent = parentValue
          ? resolveId(`space:${parentValue}`)
          : undefined;
        if (child && parent)
          addEdge({
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
          sourceRefs: [
            { path: document.path, jsonPointer: pointerFor(index, "settings") },
          ],
        });
        const space = resolveId(`space:${recordValue(item, ["nodeId"])}`);
        if (space)
          addEdge({
            id: `contains:${space}:setting:${idValue}`,
            from: space,
            to: `setting:${idValue}`,
            label: "包含设定",
            kind: "contains",
            sourceRefs: [
              {
                path: document.path,
                jsonPointer: pointerFor(index, "settings"),
              },
            ],
          });
      }
    }

    if (
      document.path.startsWith("world/setting-library/entries/") &&
      document.path.endsWith(".json")
    ) {
      const settingId = document.path
        .split("/")
        .at(-1)
        ?.replace(/\.json$/u, "");
      const setting = settingId ? resolveId(`setting:${settingId}`) : undefined;
      for (const [index, item] of asRecords(root.entries).entries()) {
        const idValue =
          recordValue(item, ["id"]) ?? `${settingId ?? "entry"}-${index}`;
        const name = recordValue(item, ["name", "title"]) ?? idValue;
        const definition =
          recordValue(item, ["definition", "description"]) ?? "设定词条";
        const nodeId = addNode({
          id: `entry:${document.path}:${idValue}`,
          label: name,
          kind: "entry",
          description: definition,
          aliases: Array.isArray(item.aliases)
            ? item.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
          sourceRefs: [
            { path: document.path, jsonPointer: pointerFor(index, "entries") },
          ],
        });
        if (setting)
          addEdge({
            id: `defined-in:${nodeId}:${setting}`,
            from: nodeId,
            to: setting,
            label: "属于设定",
            kind: "defined-in",
            sourceRefs: [
              {
                path: document.path,
                jsonPointer: pointerFor(index, "entries"),
              },
            ],
          });
      }
    }

    const knowledgeRecord = knowledgeRecordDescriptor(document.path);
    if (knowledgeRecord?.collection === "relations") {
      const from = resolveId(
        recordValue(root, ["from", "fromId", "source", "sourceId"]),
      );
      const to = resolveId(
        recordValue(root, ["to", "toId", "target", "targetId"]),
      );
      if (from && to) {
        addEdge({
          id: `relation:${knowledgeRecord.id}`,
          from,
          to,
          label: recordValue(root, ["type", "label", "relation"]) ?? "相关",
          kind: "relation",
          sourceRefs: [{ path: document.path }],
        });
      }
    }

    if (knowledgeRecord?.collection === "entities") {
      const idValue = recordValue(root, ["id", "key"]) ?? knowledgeRecord.id;
      const label = recordValue(root, ["name", "title", "label"]) ?? idValue;
      const nodeId = addNode({
        id: `entity:${idValue}`,
        label,
        kind: "entity",
        description:
          recordValue(root, ["description", "definition", "summary"]) ??
          "知识实体",
        aliases: Array.isArray(root.aliases)
          ? root.aliases.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        sourceRefs: [{ path: document.path }],
      });
      idByLabel.set(normalize(idValue), nodeId);
    }

    if (knowledgeRecord?.collection === "facts") {
      const idValue = recordValue(root, ["id"]) ?? knowledgeRecord.id;
      const label = recordValue(root, ["name", "title", "subject"]) ?? idValue;
      addNode({
        id: `fact:${idValue}`,
        label,
        kind: "fact",
        description:
          recordValue(root, ["content", "definition", "description"]) ??
          "知识事实",
        aliases: [],
        sourceRefs: [{ path: document.path }],
      });
    }

    if (
      document.path !== TIMELINE_INDEX_PATH &&
      !isTimelineRecord &&
      document.path !== FACTION_INDEX_PATH &&
      !isFactionRecord &&
      document.path !== LOCATION_INDEX_PATH &&
      !isLocationRecord &&
      document.path !== "world/setting-library/settings.json" &&
      document.path !== "world/setting-library/spatial-tree.json" &&
      !document.path.startsWith("world/setting-library/entries/") &&
      !document.path.startsWith("knowledge/") &&
      !DOMAIN_MANIFEST_PATHS.has(document.path)
    ) {
      for (const [key, value] of Object.entries(root)) {
        for (const [index, item] of asRecords(value).entries()) {
          const idValue = recordValue(item, ["id", "slug", "key"]);
          const label =
            recordValue(item, ["name", "title", "label"]) ?? idValue;
          if (!idValue || !label) continue;
          addNode({
            id: `entity:${document.path}:${idValue}`,
            label,
            kind: "entity",
            description:
              recordValue(item, ["description", "definition", "summary"]) ??
              key,
            aliases: Array.isArray(item.aliases)
              ? item.aliases.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
            sourceRefs: [
              { path: document.path, jsonPointer: pointerFor(index, key) },
            ],
          });
          idByLabel.set(
            normalize(idValue),
            `entity:${document.path}:${idValue}`,
          );
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
  const stableLinkPattern =
    /\[\[([a-zA-Z]+):([a-zA-Z0-9-]+)(?:\|([^\]]+))?\]\]/gu;
  const legacyLinkPattern = /\[\[([^[\]|:]+)\]\]/gu;
  const resolveStableTarget = (
    kind: string,
    id: string,
    label: string,
  ): string | undefined => {
    const viaDomain = resolveId(`domain:${kind}:${id}`);
    if (viaDomain) return viaDomain;
    const legacyKindPaths: Readonly<Record<string, string>> = {
      character: "characters/index.json",
      location: LOCATION_INDEX_PATH,
      faction: FACTION_INDEX_PATH,
      item: "world/items/index.json",
      event: TIMELINE_INDEX_PATH,
    };
    const kindPath = legacyKindPaths[kind];
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

  const referenceFields: Readonly<
    Record<string, { readonly kind: string; readonly label: string }>
  > = Object.freeze({
    characterId: { kind: "character", label: "关联人物" },
    characterIds: { kind: "character", label: "关联人物" },
    factionId: { kind: "faction", label: "关联势力" },
    factionIds: { kind: "faction", label: "关联势力" },
    itemId: { kind: "item", label: "关联物品" },
    itemIds: { kind: "item", label: "关联物品" },
    locationId: { kind: "location", label: "关联地点" },
    locationIds: { kind: "location", label: "关联地点" },
    eventId: { kind: "event", label: "关联事件" },
    eventIds: { kind: "event", label: "关联事件" },
    causeEventIds: { kind: "event", label: "前因事件" },
    chapterId: { kind: "chapter", label: "关联章节" },
    chapterIds: { kind: "chapter", label: "关联章节" },
    narrativeChapterId: { kind: "narrativeChapter", label: "关联剧情章节" },
    narrativeDirectoryId: { kind: "narrativeDirectory", label: "关联剧情目录" },
    protagonistCharacterId: { kind: "character", label: "主角" },
    povCharacterId: { kind: "character", label: "场景视角" },
    worldNodeId: { kind: "space", label: "所属空间" },
    lineId: { kind: "plotLine", label: "关联剧情线" },
    arcId: { kind: "storyArc", label: "关联故事弧" },
  });

  const pointerSegment = (value: string): string =>
    value.replaceAll("~", "~0").replaceAll("/", "~1");

  const addStructuredReferences = (
    document: KnowledgeDocument,
    value: unknown,
    ownerId: string | undefined,
    pointer: string,
  ): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        addStructuredReferences(document, item, ownerId, `${pointer}/${index}`),
      );
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const recordId = recordValue(record, ["id", "key"]);
    const nextOwner = recordId ? resolveId(recordId) ?? ownerId : ownerId;
    for (const [key, child] of Object.entries(record)) {
      const field = referenceFields[key];
      if (field) {
        const values = Array.isArray(child) ? child : [child];
        values.forEach((candidate, index) => {
          if (typeof candidate !== "string" || !candidate.trim()) return;
          const source = {
            path: document.path,
            jsonPointer: `${pointer}/${pointerSegment(key)}${
              Array.isArray(child) ? `/${index}` : ""
            }`,
          };
          const target = resolveStableTarget(
            field.kind,
            candidate.trim(),
            candidate.trim(),
          );
          if (!target) {
            diagnostics.push({
              kind: "dangling-reference",
              message: `${document.path} 的 ${key} 引用了不存在的 ID：${candidate}`,
              source,
            });
            return;
          }
          if (!nextOwner) return;
          addEdge({
            id: `structured:${document.path}:${nextOwner}:${key}:${target}`,
            from: nextOwner,
            to: target,
            label: field.label,
            kind: "relation",
            sourceRefs: [source],
          });
        });
      }
      if (child && typeof child === "object") {
        addStructuredReferences(
          document,
          child,
          nextOwner,
          `${pointer}/${pointerSegment(key)}`,
        );
      }
    }
  };

  // 第二遍解析结构化引用，确保跨域关系不受文件排序影响。
  for (const document of orderedDocuments) {
    if (document.path.endsWith(".json")) {
      addStructuredReferences(document, safeJson(document.content), undefined, "");
    }
  }

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
        line:
          node.sourceRefs.find((source) => source.path === document.path)
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
      const owner = ownerIndex >= 0 ? headingLines[ownerIndex].node : undefined;
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
    sourceHash: knowledgeSourceHash(documents),
    nodes: Object.freeze([...nodes.values()]),
    edges: Object.freeze([...edges.values()]),
    documents: Object.freeze([...documents]),
    diagnostics: Object.freeze(diagnostics),
  });
}

const memorySnapshots = new WeakMap<
  WorkbenchStorage,
  { readonly sourceHash: string; readonly snapshot: KnowledgeGraphSnapshot }
>();

export async function buildKnowledgeGraphFromStorage(
  storage: WorkbenchStorage,
): Promise<KnowledgeGraphSnapshot> {
  const documents = await readKnowledgeDocuments(storage);
  const sourceHash = knowledgeSourceHash(documents);
  const cached = memorySnapshots.get(storage);
  if (cached?.sourceHash === sourceHash) {
    return cached.snapshot;
  }

  const domainIndex = await buildDomainIndex(storage).catch(() => null);
  const snapshot = buildKnowledgeGraph(documents, domainIndex?.entities ?? []);
  const result = Object.freeze({ ...snapshot, sourceHash });
  memorySnapshots.set(storage, { sourceHash, snapshot: result });
  return result;
}

function scoreNode(
  node: KnowledgeNode,
  query: string,
): { score: number; matchedBy: KnowledgeSearchResult["matchedBy"] } {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return { score: 0, matchedBy: [] };
  const matchedBy: ("名称" | "别名" | "内容" | "来源")[] = [];
  let score = 0;
  if (normalize(node.label).includes(normalizedQuery)) {
    score += normalize(node.label) === normalizedQuery ? 100 : 80;
    matchedBy.push("名称");
  }
  if (
    node.aliases.some((alias) => normalize(alias).includes(normalizedQuery))
  ) {
    score = Math.max(score, 70);
    matchedBy.push("别名");
  }
  if (normalize(node.description).includes(normalizedQuery)) {
    score = Math.max(score, 45);
    matchedBy.push("内容");
  }
  if (
    node.sourceRefs.some((source) =>
      normalize(source.path).includes(normalizedQuery),
    )
  ) {
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
  const documents = new Map(
    snapshot.documents.map((document) => [document.path, document]),
  );
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
        snippet:
          document && source
            ? sourceSnippet(document, source, node.description)
            : node.description,
      };
    })
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.node.label.localeCompare(right.node.label, "zh-CN"),
    );
}

export function getKnowledgeNeighbors(
  snapshot: KnowledgeGraphSnapshot,
  nodeId: string,
): readonly { edge: KnowledgeEdge; node: KnowledgeNode }[] {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return snapshot.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .map((edge) => ({
      edge,
      node: nodes.get(edge.from === nodeId ? edge.to : edge.from),
    }))
    .filter(
      (item): item is { edge: KnowledgeEdge; node: KnowledgeNode } =>
        !!item.node,
    );
}
