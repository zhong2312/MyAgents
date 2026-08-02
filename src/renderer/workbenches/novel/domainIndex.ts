import type { WorkbenchStorage } from "@/workbench-sdk";

import { parseCharacterLibraryIndex } from "./characterLibrarySchema";
import { parseFactionLibrary } from "./factionLibrarySchema";
import { parseItemLibraryIndex } from "./itemLibrarySchema";
import { parseLocationLibraryIndex } from "./locationLibrarySchema";
import { parseNovelChapterIndex } from "./projectSchema";
import { parseNarrativeEngineering } from "./narrativeEngineeringSchema";
import { parseInspirationLibrary } from "./inspirationSchema";
import { parseTimelineLibrary } from "./timelineLibrarySchema";
import { parseSettingLibrarySpatialTree } from "./settingLibrarySchema";

/** 实体种类（对应可定位的领域对象）。 */
export type DomainEntityKind =
  | "character"
  | "faction"
  | "item"
  | "location"
  | "setting"
  | "event"
  | "narrativeChapter"
  | "chapter"
  | "inspiration"
  | "research";

export const DOMAIN_ENTITY_KIND_LABELS: Readonly<
  Record<DomainEntityKind, string>
> = Object.freeze({
  character: "人物",
  faction: "势力",
  item: "物品",
  location: "地点",
  setting: "设定",
  event: "事件",
  narrativeChapter: "剧情规划",
  chapter: "正文章节",
  inspiration: "灵感",
  research: "资料",
});

/**
 * 领域实体投影：不复制正文/概要之外的派生数据，
 * 只保留用于检索、展示与定位的最小字段。
 */
export interface DomainEntityRef {
  readonly kind: DomainEntityKind;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  /** 工作区相对来源路径（定位来源文件用）。 */
  readonly sourcePath: string;
  /** 定位到具体实体的 route 与聚焦参数（T3 消费）。 */
  readonly route: string;
  readonly focus: Readonly<Record<string, string>>;
}

export interface DomainIndex {
  readonly entities: readonly DomainEntityRef[];
  readonly builtAt: string;
}

function clip(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

async function loadOptional(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) return null;
  return (await storage.readText(path)).content;
}

/** 从各库 JSON 投影实体索引（内存构建，不写盘）。 */
export async function buildDomainIndex(
  storage: WorkbenchStorage,
): Promise<DomainIndex> {
  const entities: DomainEntityRef[] = [];

  const characters = await loadOptional(storage, "characters/index.json");
  if (characters) {
    for (const character of parseCharacterLibraryIndex(characters).characters) {
      entities.push({
        kind: "character",
        id: character.id,
        name: character.name,
        aliases: [
          character.alias,
          ...character.identities.filter(Boolean),
        ].filter(Boolean),
        summary: clip(character.summary),
        sourcePath: "characters/index.json",
        route: "characters",
        focus: { characterId: character.id },
      });
    }
  }

  const factions = await loadOptional(storage, "world/factions/index.json");
  if (factions) {
    for (const faction of parseFactionLibrary(factions).factions) {
      entities.push({
        kind: "faction",
        id: faction.id,
        name: faction.name,
        aliases: [],
        summary: clip(faction.summary),
        sourcePath: "world/factions/index.json",
        route: "factions",
        focus: { factionId: faction.id },
      });
    }
  }

  const items = await loadOptional(storage, "world/items/index.json");
  if (items) {
    for (const item of parseItemLibraryIndex(items).items) {
      entities.push({
        kind: "item",
        id: item.id,
        name: item.name,
        aliases: [],
        summary: clip(item.summary),
        sourcePath: "world/items/index.json",
        route: "items",
        focus: { itemId: item.id },
      });
    }
  }

  const locations = await loadOptional(storage, "world/locations/index.json");
  if (locations) {
    for (const location of parseLocationLibraryIndex(locations).locations) {
      entities.push({
        kind: "location",
        id: location.id,
        name: location.name,
        aliases: [...location.aliases],
        summary: clip(location.summary),
        sourcePath: "world/locations/index.json",
        route: "lore",
        focus: { locationId: location.id },
      });
    }
  }

  const spatial = await loadOptional(
    storage,
    "world/setting-library/spatial-tree.json",
  );
  if (spatial) {
    for (const node of parseSettingLibrarySpatialTree(spatial).nodes) {
      entities.push({
        kind: "setting",
        id: node.id,
        name: node.name,
        aliases: [],
        summary: "",
        sourcePath: "world/setting-library/spatial-tree.json",
        route: "lore",
        focus: { nodeId: node.id },
      });
    }
  }

  const narrative = await loadOptional(storage, "narrative/index.json");
  if (narrative) {
    for (const plan of parseNarrativeEngineering(narrative).chapters) {
      entities.push({
        kind: "narrativeChapter",
        id: plan.id,
        name: plan.title,
        aliases: [],
        summary: clip(plan.description),
        sourcePath: "narrative/index.json",
        route: "narrative",
        focus: { narrativeChapterId: plan.id },
      });
    }
  }

  const manuscript = await loadOptional(storage, "manuscript/index.json");
  if (manuscript) {
    for (const chapter of parseNovelChapterIndex(manuscript).chapters) {
      entities.push({
        kind: "chapter",
        id: chapter.id,
        name: chapter.title,
        aliases: [],
        summary: "",
        sourcePath: "manuscript/index.json",
        route: "manuscript",
        focus: { chapterId: chapter.id },
      });
    }
  }

  const timeline = await loadOptional(storage, "timeline/index.json");
  if (timeline) {
    for (const event of parseTimelineLibrary(timeline).events) {
      entities.push({
        kind: "event",
        id: event.id,
        name: event.title,
        aliases: [],
        summary: clip(event.summary),
        sourcePath: "timeline/index.json",
        route: "timeline",
        focus: { eventId: event.id },
      });
    }
  }

  const inspiration = await loadOptional(storage, "inspiration/index.json");
  if (inspiration) {
    for (const item of parseInspirationLibrary(inspiration).items) {
      entities.push({
        kind: "inspiration",
        id: item.id,
        name: item.title,
        aliases: [],
        summary: clip(item.body),
        sourcePath: "inspiration/index.json",
        route: "inspiration",
        focus: { inspirationId: item.id },
      });
    }
  }

  // research/ 目录下的 Markdown 资料（以文件名为实体名）
  const researchEntries = await storage
    .list("research")
    .catch(() => [] as Awaited<ReturnType<WorkbenchStorage["list"]>>);
  for (const entry of researchEntries) {
    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const name = entry.name.replace(/\.md$/i, "");
    entities.push({
      kind: "research",
      id: entry.path,
      name,
      aliases: [],
      summary: "",
      sourcePath: entry.path,
      route: "research",
      focus: { researchPath: entry.path },
    });
  }

  return {
    entities: Object.freeze(entities),
    builtAt: new Date().toISOString(),
  };
}

/** 按关键词与类型过滤实体（名称/别名/摘要匹配）。 */
export function searchDomainIndex(
  index: DomainIndex,
  query: string,
  kinds?: readonly DomainEntityKind[],
  limit = 50,
): readonly DomainEntityRef[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const kindSet = kinds ? new Set(kinds) : null;
  const scored: { ref: DomainEntityRef; score: number }[] = [];
  for (const ref of index.entities) {
    if (kindSet && !kindSet.has(ref.kind)) continue;
    if (!needle) {
      scored.push({ ref, score: 0 });
      continue;
    }
    const name = ref.name.toLocaleLowerCase("zh-CN");
    const aliases = ref.aliases
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    const summary = ref.summary.toLocaleLowerCase("zh-CN");
    let score = 0;
    if (name === needle) score = 100;
    else if (name.includes(needle)) score = 80;
    else if (aliases.includes(needle)) score = 60;
    else if (summary.includes(needle)) score = 30;
    else continue;
    scored.push({ ref, score });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || left.ref.name.localeCompare(right.ref.name),
  );
  return Object.freeze(
    scored.slice(0, limit).map(({ ref }) => ref),
  );
}
