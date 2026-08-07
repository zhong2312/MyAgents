import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./characterLibraryRepository";
import { createCultivationEcologyRepository } from "./cultivationEcologyRepository";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import {
  ITEM_LIBRARY_PATHS,
  createNovelItemLibraryRepository,
} from "./itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "./locationLibraryRepository";
import { MAP_LIBRARY_PATH, mapRecordPath } from "./mapSchema";
import { createNovelMapRepository } from "./mapRepository";
import { createNovelRepository } from "./repository";
import {
  SETTING_LIBRARY_PATHS,
  createNovelSettingLibraryRepository,
} from "./settingLibraryRepository";
import { parseSettingEntriesFile } from "./settingLibrarySchema";
import {
  MAIN_TIMELINE_BRANCH_ID,
  getTimelineBranchEvents,
  type TimelineEvent,
} from "./timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import { createWorldInstant } from "./worldSimulationTime";
import { resolveWorldSimulationRegionScope } from "./worldSimulationScope";
import {
  WORLD_SIMULATION_SCHEMA_VERSION,
  type CharacterProjection,
  type ChapterProjection,
  type CultivationSystemProjection,
  type FactionProjection,
  type ItemProjection,
  type NarrativeConstraintProjection,
  type RegionProjection,
  type RuleProjection,
  type SimulationAuthority,
  type SimulationDiagnostic,
  type SimulationSourceRef,
  type SpatialConnection,
  type TimelineEventProjection,
  type WorldSimulationBaseline,
  type WorldSimulationScenario,
} from "./worldSimulationV2Schema";

const CLIP_LENGTH = 4_000;

function compactText(value: string): string[] {
  return value
    .split(/[\r\n；;]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clip(value: string, length = CLIP_LENGTH): string {
  const text = value.trim();
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

function numericText(value: string): number | null {
  const match = value.replaceAll(",", "").match(/-?\d+(?:\.\d+)?/u);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function fallbackHash(content: string): string {
  let hash = 0x811c9dc5;
  for (const value of new TextEncoder().encode(content)) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

export async function hashSimulationSource(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return fallbackHash(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return `sha256:${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function ref(
  path: string,
  sourceHash: string,
  authority: SimulationAuthority,
  entityId?: string,
  excerpt?: string,
): SimulationSourceRef {
  return {
    path,
    sourceHash,
    authority,
    ...(entityId ? { entityId } : {}),
    ...(excerpt ? { excerpt: clip(excerpt, 320) } : {}),
  };
}

function dedupeRefs(refs: readonly SimulationSourceRef[]): SimulationSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((item) => {
    const key = `${item.path}:${item.entityId ?? ""}:${item.authority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function uniqueIds(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function settingEntriesText(
  entries: readonly {
    readonly name: string;
    readonly category: string;
    readonly aliases: readonly string[];
    readonly definition: string;
  }[],
): string {
  return entries
    .map((entry) => {
      const aliases = entry.aliases.length ? `（${entry.aliases.join("、")}）` : "";
      return `${entry.category}：${entry.name}${aliases}\n${entry.definition}`;
    })
    .join("\n");
}

function timelineProjection(
  event: TimelineEvent,
  authority: "actual" | "planned",
  sourceHash: string,
  calendar: WorldSimulationScenario["calendar"],
): TimelineEventProjection {
  return {
    id: event.id,
    title: event.title,
    summary: event.summary || event.description,
    time: createWorldInstant(event.worldSortKey ?? String(Math.trunc(event.sortKey)), calendar, event.timePrecision === "unknown" ? "approximate" : event.timePrecision === "range" ? "approximate" : event.timePrecision),
    authority,
    characterIds: [...event.characterIds],
    factionIds: [...event.factionIds],
    locationIds: [...event.locationIds],
    itemIds: [...event.itemIds],
    chapterIds: [...event.chapterIds],
    causeEventIds: [...event.causeEventIds],
    stateChanges: event.stateChanges.map((change) => ({
      entityType: change.entityType,
      entityId: change.entityId,
      before: change.before,
      after: change.after,
      note: change.note,
    })),
    sourceRefs: [ref("timeline/index.json", sourceHash, authority, event.id, event.summary)],
  };
}

function inferLocationId(
  name: string,
  available: readonly { readonly id: string; readonly name: string }[],
): string | null {
  const normalized = name.trim();
  if (!normalized) return null;
  return available.find((item) => normalized.includes(item.name) || item.name.includes(normalized))?.id ?? null;
}

function selected<T extends { readonly id: string }>(
  values: readonly T[],
  ids: readonly string[],
): readonly T[] {
  if (ids.length === 0) return values;
  const selectedIds = new Set(ids);
  return values.filter((item) => selectedIds.has(item.id));
}

function isDraftOrArchivedStatus(status: string): boolean {
  return /(draft|archived|草稿|归档)/iu.test(status.trim());
}

export async function buildWorldSimulationBaseline(
  storage: WorkbenchStorage,
  scenario: WorldSimulationScenario,
): Promise<WorldSimulationBaseline> {
  if (!storage.isAvailable) throw new Error("世界推演仅在 MyAgents 桌面端可用");

  const novelRepository = createNovelRepository(storage);
  const characterRepository = createNovelCharacterLibraryRepository(storage);
  const factionRepository = createNovelFactionLibraryRepository(storage);
  const timelineRepository = createNovelTimelineLibraryRepository(storage);
  const cultivationRepository = createCultivationEcologyRepository(storage);
  const itemRepository = createNovelItemLibraryRepository(storage);
  const locationRepository = createNovelLocationLibraryRepository(storage);
  const mapRepository = createNovelMapRepository(storage);

  const project = await novelRepository.load();
  const settingRepository = createNovelSettingLibraryRepository(storage);
  const [characters, factions, timeline, cultivation, items, locations, maps, settings] = await Promise.all([
    characterRepository.load(),
    factionRepository.load(),
    timelineRepository.load(),
    cultivationRepository.load(),
    itemRepository.load(),
    locationRepository.load(),
    mapRepository.loadIndex(),
    settingRepository.load(project.metadata.title),
  ]);
  const characterRecords = await loadCharacterRecords(
    characterRepository,
    characters,
  );

  const diagnostics: SimulationDiagnostic[] = [];
  const metadataHash = await hashSimulationSource(project.metadataContent);
  const chapterIndexHash = await hashSimulationSource(project.chapterIndexContent);
  const characterHash = await hashSimulationSource(characters.indexContent);
  const factionHash = await hashSimulationSource(factions.content);
  const timelineHash = await hashSimulationSource(timeline.content);
  const locationHash = await hashSimulationSource(locations.content);
  const spatialTreeHash = await hashSimulationSource(settings.spatialTreeContent);
  const settingMetaHash = await hashSimulationSource(settings.metaContent);
  const settingsIndexHash = await hashSimulationSource(settings.settingsIndexContent);
  const narrativeHash = await hashSimulationSource(project.narrative.content);
  const cultivationHash = cultivation ? await hashSimulationSource(cultivation.content) : "missing";
  const itemMetaHash = await hashSimulationSource(items.metaContent);
  const itemIndexHash = await hashSimulationSource(items.indexContent);
  const mapIndexHash = await hashSimulationSource(maps.content);

  const mainTimeline = getTimelineBranchEvents(timeline.library, MAIN_TIMELINE_BRANCH_ID).map((entry) => entry.event);
  const factsThroughIndex = timeline.library.factsThroughEventId
    ? mainTimeline.findIndex((event) => event.id === timeline.library.factsThroughEventId)
    : -1;
  if (factsThroughIndex < 0) {
    diagnostics.push({
      id: "timeline-facts-anchor-missing",
      severity: scenario.start.mode === "facts-anchor" ? "blocking" : "warning",
      title: "尚未设置事实截止点",
      detail: scenario.start.mode === "facts-anchor"
        ? "当前方案要求从事实终点开始，但时间线未设置 factsThroughEventId。请先锁定已发生事实，或改用自定义起点。"
        : "时间线事件不会自动成为事实。当前使用自定义起点，推演不会把任何时间线事件当作既成事实。",
      sourceRefs: [ref("timeline/index.json", timelineHash, "planned")],
    });
  }

  const selectedChapter = scenario.chapterContext.chapterId
    ? project.chapters.find((chapter) => chapter.id === scenario.chapterContext.chapterId) ?? null
    : null;
  const chapterEvents = selectedChapter
    ? mainTimeline.filter((event) => event.chapterIds.includes(selectedChapter.id))
    : [];
  const chapterActualEvents = chapterEvents.filter((event) => {
    const index = mainTimeline.findIndex((candidate) => candidate.id === event.id);
    return index >= 0 && index <= factsThroughIndex;
  });

  let effectiveFactsThroughIndex = factsThroughIndex;
  let anchorSortKey = factsThroughIndex >= 0 ? mainTimeline[factsThroughIndex]!.worldSortKey ?? String(Math.trunc(mainTimeline[factsThroughIndex]!.sortKey)) : "0";
  if (scenario.chapterContext.mode !== "none") {
    if (!selectedChapter) {
      diagnostics.push({
        id: "chapter-context-missing",
        severity: "blocking",
        title: "章节上下文缺失",
        detail: "当前方案启用了章节推演，但没有选择有效章节。",
        sourceRefs: [],
      });
    } else if (chapterActualEvents.length === 0) {
      diagnostics.push({
        id: "chapter-timeline-unlinked",
        severity: "blocking",
        title: "章节没有已发生时间锚点",
        detail: "章节上下文只能建立在已发生时间线事件上。请把章节关联到事实时间线，或关闭章节上下文后重新运行。",
        sourceRefs: [ref(selectedChapter.path, await hashSimulationSource(selectedChapter.content), "planned", selectedChapter.id)],
      });
    } else {
      const first = chapterActualEvents[0]!;
      const last = chapterActualEvents[chapterActualEvents.length - 1]!;
      const firstIndex = mainTimeline.findIndex((event) => event.id === first.id);
      const lastIndex = mainTimeline.findIndex((event) => event.id === last.id);
      if (
        scenario.chapterContext.mode === "before" ||
        scenario.chapterContext.mode === "branch"
      ) {
        // 重演与分支都必须固定章节开始前的世界状态；目标章节本身只能
        // 作为观察项或替代路径，不能被预先混入基线。
        effectiveFactsThroughIndex = Math.max(-1, firstIndex - 1);
        anchorSortKey = (BigInt(first.worldSortKey ?? Math.trunc(first.sortKey)) - 1n).toString();
      } else {
        // 从章节后继续时，章节后的正式事实仍是未来资料，绝不能因为
        // 全局事实截止点更晚而泄漏到较早章节的沙盒状态中。
        effectiveFactsThroughIndex = lastIndex;
        anchorSortKey = last.worldSortKey ?? String(Math.trunc(last.sortKey));
      }
    }
  }
  if (scenario.start.mode === "custom") {
    anchorSortKey = scenario.start.sortKey;
    const customSortKey = BigInt(scenario.start.sortKey);
    while (
      effectiveFactsThroughIndex >= 0 &&
      BigInt(mainTimeline[effectiveFactsThroughIndex]!.worldSortKey ?? Math.trunc(mainTimeline[effectiveFactsThroughIndex]!.sortKey)) > customSortKey
    ) {
      effectiveFactsThroughIndex -= 1;
    }
  }

  const actualTimelineEvents = mainTimeline.slice(0, Math.max(0, effectiveFactsThroughIndex + 1));
  const plannedTimelineEvents = mainTimeline.slice(Math.max(0, effectiveFactsThroughIndex + 1));
  const timelineFacts = actualTimelineEvents.map((event) => timelineProjection(event, "actual", timelineHash, scenario.calendar));
  const timelinePlans = plannedTimelineEvents.map((event) => timelineProjection(event, "planned", timelineHash, scenario.calendar));

  const regionNodes = settings.spatialTree.nodes;
  const locationByNodeId = new Map(locations.index.locations.map((location) => [location.nodeId, location]));
  const settingContents = await Promise.all(
    settings.settingsIndex.settings.map(async (setting) => {
      const [page, entries] = await Promise.all([
        storage
          .readText(setting.pagePath)
          .then((file) => ({
            content: file.content,
            error: null,
            readable: true,
          }))
          .catch((cause) => ({
            content: "",
            error: errorDetail(cause),
            readable: false,
          })),
        storage
          .readText(setting.entriesPath)
          .then((file) => ({
            content: file.content,
            error: null,
            readable: true,
          }))
          .catch((cause) => ({
            content: "",
            error: errorDetail(cause),
            readable: false,
          })),
      ]);
      let parsedEntries: readonly {
        readonly name: string;
        readonly category: string;
        readonly aliases: readonly string[];
        readonly definition: string;
      }[] = [];
      let entriesError = entries.error;
      if (!entriesError) {
        try {
          parsedEntries = parseSettingEntriesFile(entries.content).entries;
        } catch (cause) {
          entriesError = `格式错误：${errorDetail(cause)}`;
        }
      }
      return {
        setting,
        pageContent: page.content,
        entriesContent: entries.content,
        pageError: page.error,
        entriesError,
        entriesReadable: entries.readable,
        entriesText: settingEntriesText(parsedEntries),
        pageHash: await hashSimulationSource(
          page.readable
            ? page.content
            : `unavailable:${setting.pagePath}:${page.error}`,
        ),
        entriesHash: await hashSimulationSource(
          entries.readable
            ? entries.content
            : `unavailable:${setting.entriesPath}:${entries.error}`,
        ),
      };
    }),
  );
  settingContents.forEach((entry) => {
    if (entry.pageError) {
      diagnostics.push({
        id: `setting-page-unavailable-${entry.setting.id}`,
        severity: "warning",
        title: `设定页面无法载入：${entry.setting.name}`,
        detail: `已跳过设定正文，地域摘要和规则投影可能不完整。${entry.pageError}`,
        sourceRefs: [
          ref(
            entry.setting.pagePath,
            entry.pageHash,
            "canon",
            entry.setting.id,
          ),
        ],
      });
    }
    if (entry.entriesError) {
      diagnostics.push({
        id: `setting-entries-unavailable-${entry.setting.id}`,
        severity: "warning",
        title: `${entry.entriesReadable ? "设定词条格式错误" : "设定词条无法载入"}：${entry.setting.name}`,
        detail: `已跳过设定词条，投影会继续使用可读取的资料。${entry.entriesError}`,
        sourceRefs: [
          ref(
            entry.setting.entriesPath,
            entry.entriesHash,
            "canon",
            entry.setting.id,
          ),
        ],
      });
    }
  });

  const mapDocuments = await Promise.all(
    maps.index.maps.map(async (entry) => {
      try {
        const loaded = await mapRepository.loadMap(entry.id);
        return {
          entry,
          loaded,
          sourceHash: await hashSimulationSource(loaded.content),
          error: null,
        };
      } catch (cause) {
        const error = errorDetail(cause);
        return {
          entry,
          loaded: null,
          sourceHash: await hashSimulationSource(
            `unavailable:${mapRecordPath(entry.id)}:${error}`,
          ),
          error,
        };
      }
    }),
  );
  mapDocuments.forEach(({ entry, sourceHash, error }) => {
    if (!error) return;
    diagnostics.push({
      id: `map-record-unavailable-${entry.id}`,
      severity: "warning",
      title: `地图记录无法载入：${entry.name}`,
      detail: `已跳过该地图的邻接关系推导。${error}`,
      sourceRefs: [ref(mapRecordPath(entry.id), sourceHash, "canon", entry.id)],
    });
  });
  const locationNodeById = new Map(locations.index.locations.map((location) => [location.id, location.nodeId]));
  const spatialConnections: SpatialConnection[] = [];
  regionNodes.forEach((node) => {
    if (!node.parentId) return;
    const sourceRefs = [ref("world/setting-library/spatial-tree.json", spatialTreeHash, "canon", node.id)];
    spatialConnections.push({
      id: `containment-${node.parentId}-${node.id}`,
      fromRegionId: node.parentId,
      toRegionId: node.id,
      kind: "containment",
      travelDays: "1",
      capacity: 100,
      attenuation: 0.05,
      bidirectional: true,
      sourceRefs,
    });
  });
  mapDocuments.forEach(({ loaded, sourceHash }) => {
    if (!loaded) return;
    const markers = loaded.map.features.flatMap((feature) => {
      if (!feature.entityRef || feature.entityRef.kind !== "location") return [];
      const regionId = locationNodeById.get(feature.entityRef.id);
      const point = feature.points[0];
      return regionId && point ? [{ regionId, point, featureId: feature.id }] : [];
    });
    markers.forEach((marker, index) => {
      const nearest = markers
        .filter((_, candidateIndex) => candidateIndex !== index)
        .map((candidate) => ({
          ...candidate,
          distance: Math.hypot(candidate.point.x - marker.point.x, candidate.point.y - marker.point.y),
        }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 2);
      nearest.forEach((candidate) => {
        const pair = [marker.regionId, candidate.regionId].sort();
        const id = `map-adjacent-${loaded.map.id}-${pair[0]}-${pair[1]}`;
        if (spatialConnections.some((connection) => connection.id === id)) return;
        spatialConnections.push({
          id,
          fromRegionId: pair[0]!,
          toRegionId: pair[1]!,
          kind: "adjacent",
          travelDays: String(Math.max(1, Math.round(candidate.distance / 80))),
          capacity: 60,
          attenuation: Math.min(0.8, candidate.distance / Math.hypot(loaded.map.canvas.width, loaded.map.canvas.height)),
          bidirectional: true,
          sourceRefs: [ref(mapRecordPath(loaded.map.id), sourceHash, "canon", candidate.featureId)],
        });
      });
    });
  });

  const factionTerritories = new Map<string, string[]>();
  factions.library.factions.forEach((faction) => {
    factionTerritories.set(faction.id, faction.territories.flatMap((territory) => territory.worldNodeId ? [territory.worldNodeId] : []));
  });
  const latestLocationByCharacter = new Map<string, string>();
  actualTimelineEvents.forEach((event) => {
    const locationId = event.locationIds[0];
    if (!locationId) return;
    const regionId = locationNodeById.get(locationId) ?? locationId;
    event.characterIds.forEach((characterId) => latestLocationByCharacter.set(characterId, regionId));
  });
  const factionIdsByCharacter = new Map<string, string[]>();
  factions.library.factions.forEach((faction) => faction.members.forEach((member) => {
    if (!member.characterId) return;
    factionIdsByCharacter.set(member.characterId, [...(factionIdsByCharacter.get(member.characterId) ?? []), faction.id]);
  }));

  const systems = cultivation?.ecology.systems ?? [];
  const levelById = new Map(systems.flatMap((system) => system.progressionTracks.flatMap((track) => track.levels.map((level) => [level.id, { level, track }] as const))));
  const knowledgeByCharacter = new Map<string, CharacterProjection["knowledge"]>();
  characterRecords.forEach((character) => {
    const knowledge = actualTimelineEvents.flatMap((event) => {
      if (event.knowledgeScope !== "public" && !event.characterIds.includes(character.id)) return [];
      return [{
        id: `knowledge-${event.id}`,
        statement: event.summary || event.title,
        authority: "fact" as const,
        confidence: event.knowledgeScope === "public" ? 0.9 : 1,
        sourceEventId: event.id,
      }];
    });
    knowledgeByCharacter.set(character.id, knowledge);
  });

  const characterProjections: CharacterProjection[] = characterRecords.map((character) => {
    const level = character.cultivationProfile.levelId ? levelById.get(character.cultivationProfile.levelId) : undefined;
    const locationId = latestLocationByCharacter.get(character.id) ?? inferLocationId(character.hometown, regionNodes) ?? null;
    return {
      id: character.id,
      name: character.name,
      summary: character.summary || character.background,
      status: character.status,
      locationId,
      factionIds: factionIdsByCharacter.get(character.id) ?? [],
      goals: compactText(character.goals),
      personality: compactText(character.personality),
      values: compactText(character.values),
      strengths: compactText(character.strengths),
      weaknesses: compactText(character.weaknesses),
      fears: compactText(character.fears),
      motivation: compactText(character.motivation),
      innerConflict: compactText(character.innerConflict),
      relations: character.relations.map((relation) => ({ ...relation })),
      cultivation: {
        systemId: character.cultivationProfile.systemId,
        trackId: character.cultivationProfile.trackId,
        levelId: character.cultivationProfile.levelId,
        levelName: level?.level.name ?? character.currentRealm,
        levelOrder: level?.level.order ?? 0,
        methodIds: [...character.cultivationProfile.methodIds],
        abilityIds: [...character.cultivationProfile.abilityIds],
        resourceBalances: Object.fromEntries(Object.entries(character.cultivationProfile.resourceBalances).map(([id, value]) => [id, value.quantity])),
        activeConstraintIds: [...character.cultivationProfile.activeConstraintIds],
      },
      ageYears: numericText(character.age),
      lifespanYears: numericText(character.baseLifespan),
      lifespanLossYears: numericText(character.lifespanLoss) ?? 0,
      inventoryItemIds: character.inventory.flatMap((item) => item.itemId ? [item.itemId] : []),
      knowledge: knowledgeByCharacter.get(character.id) ?? [],
      sourceRefs: [ref("characters/index.json", characterHash, "canon", character.id, character.summary)],
    };
  });

  const factionProjections: FactionProjection[] = factions.library.factions.map((faction) => {
    const memberById = new Map(faction.members.map((member) => [member.id, member]));
    const leaderCharacterIds = faction.organizationUnits.flatMap((unit) => {
      const member = unit.leaderMemberId ? memberById.get(unit.leaderMemberId) : undefined;
      return member?.characterId ? [member.characterId] : [];
    });
    return {
      id: faction.id,
      name: faction.name,
      type: faction.type,
      status: faction.status,
      summary: faction.summary,
      goals: compactText(`${faction.summary}\n${faction.state.governance}\n${faction.state.territorialIntegrity}`),
      territoryIds: factionTerritories.get(faction.id) ?? [],
      leaderCharacterIds: [...new Set(leaderCharacterIds)],
      memberCharacterIds: faction.members.flatMap((member) => member.characterId ? [member.characterId] : []),
      resources: faction.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        kind: resource.kind,
        control: resource.control,
        controlLevel: resource.controlLevel,
        regionId: resource.worldNodeId,
        itemId: resource.itemId,
        competingFactionIds: [...resource.competingFactionIds],
      })),
      relations: faction.relations.map((relation) => ({
        targetFactionId: relation.targetFactionId,
        kind: relation.kind,
        direction: relation.direction,
        status: relation.status,
        description: relation.description,
      })),
      stateText: { ...faction.state },
      sourceRefs: [ref("world/factions/index.json", factionHash, "canon", faction.id, faction.summary)],
    };
  });

  const loadedItems = await Promise.all(
    items.index.items.map(async (entry) => {
      try {
        const loaded = await itemRepository.loadItem(entry);
        return {
          entry,
          loaded,
          sourceHash: await hashSimulationSource(
            `${loaded.recordContent}\n${loaded.pageContent}`,
          ),
          error: null,
        };
      } catch (cause) {
        const error = errorDetail(cause);
        return {
          entry,
          loaded: null,
          sourceHash: await hashSimulationSource(
            `unavailable:${entry.recordPath}:${entry.pagePath}:${error}`,
          ),
          error,
        };
      }
    }),
  );
  loadedItems.forEach(({ entry, sourceHash, error }) => {
    if (!error) return;
    diagnostics.push({
      id: `item-record-unavailable-${entry.id}`,
      severity: "warning",
      title: `物品记录无法载入：${entry.name}`,
      detail: `已跳过该物品的能力、位置和归属投影。${error}`,
      sourceRefs: [ref(entry.recordPath, sourceHash, "canon", entry.id)],
    });
  });
  const characterOwnerByItem = new Map<string, string>();
  characterProjections.forEach((character) => character.inventoryItemIds.forEach((itemId) => characterOwnerByItem.set(itemId, character.id)));
  const factionOwnerByItem = new Map<string, string>();
  factionProjections.forEach((faction) => faction.resources.forEach((resource) => {
    if (resource.itemId) factionOwnerByItem.set(resource.itemId, faction.id);
  }));
  const itemProjections: ItemProjection[] = loadedItems.flatMap(
    ({ entry, loaded, sourceHash }) => {
    if (!loaded) return [];
    const fieldLabels = new Map([
      ...items.meta.fields.map((field) => [field.id, field.label] as const),
      ...loaded.record.itemFields.map((field) => [field.id, field.label] as const),
    ]);
    const values = Object.entries(loaded.record.values).flatMap(([id, value]) => value === null || value === "" ? [] : [`${fieldLabels.get(id) ?? id}：${Array.isArray(value) ? value.join("、") : String(value)}`]);
    const ownerCharacterId = characterOwnerByItem.get(entry.id) ?? null;
    const ownerFactionId = factionOwnerByItem.get(entry.id) ?? null;
    const locationId = Object.values(loaded.record.values).flatMap((value) => typeof value === "string" ? [value] : Array.isArray(value) ? value : []).find((value) => regionNodes.some((region) => region.id === value)) ?? null;
    return [{
      id: entry.id,
      name: entry.name,
      category: items.meta.categories.find((category) => category.id === entry.categoryId)?.name ?? entry.categoryId,
      status: entry.status,
      summary: entry.summary || loaded.record.summary,
      ownerType: ownerCharacterId ? "character" : ownerFactionId ? "faction" : null,
      ownerId: ownerCharacterId ?? ownerFactionId,
      locationId,
      capabilities: values,
      sourceRefs: [
        ref(entry.recordPath, sourceHash, "canon", entry.id, entry.summary),
      ],
    }];
    },
  );

  const cultivationSystems: CultivationSystemProjection[] = systems.map((system) => ({
    id: system.id,
    name: system.name,
    kind: system.kind,
    summary: system.summary,
    levels: system.progressionTracks.flatMap((track) => track.levels.map((level) => ({
      id: level.id,
      name: level.name,
      order: level.order,
      trackId: track.id,
      breakthroughConditions: [...level.breakthroughConditions],
      resourceIds: level.resourceRequirements.map((requirement) => requirement.resourceId),
    }))),
    transitions: [...system.transitions, ...system.progressionTracks.flatMap((track) => track.transitions)].map((transition) => ({
      id: transition.id,
      fromLevelId: transition.fromLevelId,
      toLevelId: transition.toLevelId,
      type: transition.transitionType,
      conditions: [...transition.conditions],
      result: transition.successResult,
    })),
    hardConstraints: [
      ...system.constraints.flatMap((constraint) => [
        constraint.summary,
        constraint.trigger ? `触发：${constraint.trigger}` : "",
        constraint.consequence ? `后果：${constraint.consequence}` : "",
      ].filter(Boolean)),
      ...system.theoryModel.invariants,
    ],
    sourceRefs: [ref("world/cultivation-ecology.json", cultivationHash, "canon", system.id, system.summary)],
  }));

  const ruleProjections: RuleProjection[] = [];
  settingContents.forEach(
    ({ setting, pageContent, entriesText, pageHash, entriesHash }) => {
    if (setting.status !== "completed") return;
    if (!/法则|规则|时空|天道|限制/u.test(`${setting.name} ${setting.group}`)) return;
    ruleProjections.push({
      id: `setting-rule-${setting.id}`,
      title: setting.name,
      description: clip([pageContent, entriesText].filter(Boolean).join("\n"), 2_000),
      severity: "hard",
      regionId: setting.nodeId,
      sourceRefs: [
        ref(setting.pagePath, pageHash, "canon", setting.id, pageContent),
        ref(setting.entriesPath, entriesHash, "canon", setting.id, entriesText),
      ],
    });
    },
  );
  cultivationSystems.forEach((system) => system.hardConstraints.forEach((constraint, index) => {
    ruleProjections.push({
      id: `cultivation-rule-${system.id}-${index + 1}`,
      title: `${system.name}约束 ${index + 1}`,
      description: constraint,
      severity: "hard",
      regionId: null,
      sourceRefs: system.sourceRefs,
    });
  }));

  const regions: RegionProjection[] = regionNodes.map((node) => {
    const location = locationByNodeId.get(node.id);
    const nodeSettings = settingContents.filter((entry) => entry.setting.nodeId === node.id);
    const pageText = nodeSettings
      .map((entry) =>
        clip(
          [entry.pageContent, entry.entriesText].filter(Boolean).join("\n"),
          800,
        ),
      )
      .filter(Boolean);
    const rulerFactionIds = factionProjections.filter((faction) => faction.territoryIds.includes(node.id)).map((faction) => faction.id);
    const activeFactionIds = factionProjections.filter((faction) => faction.territoryIds.includes(node.id) || faction.resources.some((resource) => resource.regionId === node.id)).map((faction) => faction.id);
    const sourceRefs = [ref("world/setting-library/spatial-tree.json", spatialTreeHash, "canon", node.id), ...(location ? [ref("world/locations/index.json", locationHash, location.status === "appeared" ? "actual" : "planned", location.id, location.summary)] : []), ...nodeSettings.flatMap((entry) => [ref(entry.setting.pagePath, entry.pageHash, entry.setting.status === "completed" ? "canon" : "author-secret", entry.setting.id, entry.pageContent), ref(entry.setting.entriesPath, entry.entriesHash, entry.setting.status === "completed" ? "canon" : "author-secret", entry.setting.id, entry.entriesText)])];
    return {
      id: node.id,
      name: node.name,
      type: settings.meta.levelTypes.find((type) => type.id === node.typeId)?.name ?? node.typeId,
      parentId: node.parentId,
      summary: clip([location?.summary, location?.description, ...pageText].filter(Boolean).join("\n"), 2_000),
      rulerFactionIds,
      activeFactionIds,
      residentCharacterIds: characterProjections.filter((character) => character.locationId === node.id).map((character) => character.id),
      itemIds: itemProjections.filter((item) => item.locationId === node.id).map((item) => item.id),
      culture: nodeSettings.filter((entry) => /文化|信仰|制度|风俗/u.test(`${entry.setting.name} ${entry.setting.group}`)).map((entry) => clip([entry.pageContent, entry.entriesText].filter(Boolean).join("\n"), 300)),
      rules: ruleProjections.filter((rule) => rule.regionId === node.id).map((rule) => rule.id),
      connections: spatialConnections.filter((connection) => connection.fromRegionId === node.id || (connection.bidirectional && connection.toRegionId === node.id)),
      sourceRefs: dedupeRefs(sourceRefs),
    };
  });

  const narrativeMode = scenario.narrativeContext.mode;
  const narrativeConstraints: NarrativeConstraintProjection[] = [];
  const knownCharacterIds = new Set(
    characterProjections.map((character) => character.id),
  );
  const plotLineById = new Map(
    project.narrative.library.lines.map((line) => [line.id, line]),
  );
  const storyArcById = new Map(
    project.narrative.library.arcs.map((arc) => [arc.id, arc]),
  );
  const narrativeReferenceDiagnosticIds = new Set<string>();
  const warnNarrativeReference = (
    id: string,
    title: string,
    detail: string,
  ) => {
    if (narrativeReferenceDiagnosticIds.has(id)) return;
    narrativeReferenceDiagnosticIds.add(id);
    diagnostics.push({
      id,
      severity: "warning",
      title,
      detail,
      sourceRefs: [
        ref(
          "narrative/index.json",
          narrativeHash,
          narrativeMode === "strict" ? "constraint" : "planned",
        ),
      ],
    });
  };
  const resolveNarrativeEntityIds = (input: {
    readonly constraintId: string;
    readonly characterIds?: readonly (string | null)[];
    readonly lineIds?: readonly string[];
    readonly arcIds?: readonly string[];
  }): readonly string[] => {
    const entityIds: string[] = [];
    const addCharacter = (characterId: string | null, origin: string) => {
      if (!characterId) return;
      if (knownCharacterIds.has(characterId)) {
        entityIds.push(characterId);
        return;
      }
      warnNarrativeReference(
        `narrative-character-reference-missing-${input.constraintId}-${characterId}`,
        "剧情约束关联人物不存在",
        `剧情约束“${input.constraintId}”通过${origin}关联了不存在的人物 ${characterId}，该关联不会参与推演。`,
      );
    };
    input.characterIds?.forEach((characterId) =>
      addCharacter(characterId, "人物引用"),
    );
    input.lineIds?.forEach((lineId) => {
      const line = plotLineById.get(lineId);
      if (!line) {
        warnNarrativeReference(
          `narrative-plot-line-reference-missing-${input.constraintId}-${lineId}`,
          "剧情约束关联剧情线不存在",
          `剧情约束“${input.constraintId}”关联了不存在的剧情线 ${lineId}，该关联不会参与推演。`,
        );
        return;
      }
      addCharacter(line.protagonistCharacterId, `剧情线“${line.title}”`);
    });
    input.arcIds?.forEach((arcId) => {
      const arc = storyArcById.get(arcId);
      if (!arc) {
        warnNarrativeReference(
          `narrative-story-arc-reference-missing-${input.constraintId}-${arcId}`,
          "剧情约束关联故事弧不存在",
          `剧情约束“${input.constraintId}”关联了不存在的故事弧 ${arcId}，该关联不会参与推演。`,
        );
        return;
      }
      addCharacter(arc.characterId, `故事弧“${arc.title}”`);
      arc.lineIds.forEach((lineId) => {
        const line = plotLineById.get(lineId);
        if (!line) {
          warnNarrativeReference(
            `narrative-plot-line-reference-missing-${input.constraintId}-${lineId}`,
            "剧情约束关联剧情线不存在",
            `故事弧“${arc.title}”关联了不存在的剧情线 ${lineId}，该关联不会参与推演。`,
          );
          return;
        }
        addCharacter(line.protagonistCharacterId, `故事弧“${arc.title}”关联的剧情线“${line.title}”`);
      });
    });
    return uniqueIds(entityIds);
  };
  const chapterPlanEntityIds = (
    chapter: (typeof project.narrative.library.chapters)[number],
    constraintId: string,
  ) =>
    resolveNarrativeEntityIds({
      constraintId,
      characterIds: chapter.sections.map((section) => section.povCharacterId),
      lineIds: [
        ...chapter.lineIds,
        ...chapter.sections.flatMap((section) => section.lineIds),
      ],
      arcIds: [
        ...chapter.arcIds,
        ...chapter.sections.flatMap((section) => section.arcIds),
      ],
    });
  const selectedNarrative = <T extends { readonly id: string }>(
    values: readonly T[],
    selectedIds: readonly string[],
    kind: string,
    label: string,
  ): readonly T[] => {
    const result = selected(values, selectedIds);
    if (selectedIds.length === 0) return result;
    const existingIds = new Set(values.map((value) => value.id));
    selectedIds.forEach((id) => {
      if (existingIds.has(id)) return;
      diagnostics.push({
        id: `narrative-selection-missing-${kind}-${id}`,
        severity: narrativeMode === "strict" ? "blocking" : "warning",
        title: `选定${label}不存在`,
        detail: `运行方案引用的${label} ${id} 已不存在，不能静默忽略。请重新选择剧情工程约束。`,
        sourceRefs: [
          ref(
            "narrative/index.json",
            narrativeHash,
            narrativeMode === "strict" ? "constraint" : "planned",
          ),
        ],
      });
    });
    return result;
  };
  if (narrativeMode !== "off") {
    if (scenario.narrativeContext.usePlotLines) {
      selectedNarrative(
        project.narrative.library.lines,
        scenario.narrativeContext.selectedPlotLineIds,
        "plot-line",
        "剧情线",
      ).forEach((line) => narrativeConstraints.push({
        id: `plot-line-${line.id}`,
        kind: "plot-line",
        title: line.title,
        content: clip([line.premise, line.content, ...line.keyNodes.map((node) => `${node.title}：${node.content}`)].filter(Boolean).join("\n")),
        mode: narrativeMode,
        entityIds: resolveNarrativeEntityIds({
          constraintId: `plot-line-${line.id}`,
          characterIds: [line.protagonistCharacterId],
        }),
        sourceRefs: [ref("narrative/index.json", narrativeHash, narrativeMode === "strict" ? "constraint" : "planned", line.id, line.content)],
      }));
    }
    if (scenario.narrativeContext.useStoryArcs) {
      selectedNarrative(
        project.narrative.library.arcs,
        scenario.narrativeContext.selectedStoryArcIds,
        "story-arc",
        "故事弧",
      ).forEach((arc) => narrativeConstraints.push({
        id: `story-arc-${arc.id}`,
        kind: "story-arc",
        title: arc.title,
        content: clip([arc.content, ...arc.keyNodes.map((node) => `${node.title}：${node.content}`)].filter(Boolean).join("\n")),
        mode: narrativeMode,
        entityIds: resolveNarrativeEntityIds({
          constraintId: `story-arc-${arc.id}`,
          characterIds: [arc.characterId],
          lineIds: arc.lineIds,
        }),
        sourceRefs: [ref("narrative/index.json", narrativeHash, narrativeMode === "strict" ? "constraint" : "planned", arc.id, arc.content)],
      }));
    }
    if (scenario.narrativeContext.useDirectoryOutline) {
      selectedNarrative(
        project.narrative.library.directories,
        scenario.narrativeContext.selectedDirectoryIds,
        "directory",
        "大纲目录",
      ).forEach((directory) => {
        const directoryIds = new Set([directory.id]);
        let previousSize = -1;
        while (previousSize !== directoryIds.size) {
          previousSize = directoryIds.size;
          project.narrative.library.directories.forEach((candidate) => {
            if (candidate.parentId && directoryIds.has(candidate.parentId)) {
              directoryIds.add(candidate.id);
            }
          });
        }
        const entityIds = uniqueIds(
          project.narrative.library.chapters
            .filter((chapter) => chapter.directoryId && directoryIds.has(chapter.directoryId))
            .flatMap((chapter) =>
              chapterPlanEntityIds(chapter, `outline-${directory.id}`),
            ),
        );
        narrativeConstraints.push({
          id: `outline-${directory.id}`,
          kind: "outline",
          title: directory.title,
          content: directory.description,
          mode: narrativeMode,
          entityIds,
          sourceRefs: [ref("narrative/index.json", narrativeHash, narrativeMode === "strict" ? "constraint" : "planned", directory.id, directory.description)],
        });
      });
    }
    if (scenario.narrativeContext.useChapterPlans) {
      selectedNarrative(
        project.narrative.library.chapters,
        scenario.narrativeContext.selectedChapterPlanIds,
        "chapter-plan",
        "章节计划",
      ).forEach((chapter) => narrativeConstraints.push({
        id: `chapter-plan-${chapter.id}`,
        kind: "chapter-plan",
        title: chapter.title,
        content: clip([chapter.description, ...chapter.sections.map((section) => `${section.title}：${section.description}`)].filter(Boolean).join("\n")),
        mode: narrativeMode,
        entityIds: chapterPlanEntityIds(chapter, `chapter-plan-${chapter.id}`),
        sourceRefs: [ref("narrative/index.json", narrativeHash, narrativeMode === "strict" ? "constraint" : "planned", chapter.id, chapter.description)],
      }));
    }
  }

  const chapters: ChapterProjection[] = await Promise.all(project.chapters.map(async (chapter) => ({
    id: chapter.id,
    title: chapter.title,
    displayNumber: chapter.displayNumber,
    status: chapter.status,
    content: scenario.chapterContext.chapterId === chapter.id ? clip(chapter.content, 12_000) : clip(chapter.content, 600),
    narrativeChapterId: chapter.narrativeChapterId,
    linkedTimelineEventIds: mainTimeline.filter((event) => event.chapterIds.includes(chapter.id)).map((event) => event.id),
    sourceRefs: [ref(chapter.path, await hashSimulationSource(chapter.content), scenario.chapterContext.chapterId === chapter.id ? "constraint" : "planned", chapter.id, chapter.content)],
  })));

  if (regions.length === 0) diagnostics.push({ id: "regions-empty", severity: "blocking", title: "没有可推演地域", detail: "请先在世界架构中建立至少一个空间节点。", sourceRefs: [] });
  if (characterProjections.length === 0 && factionProjections.length === 0) diagnostics.push({ id: "actors-empty", severity: "warning", title: "没有人物或势力", detail: "世界过程仍可运行，但不会产生主体决策。", sourceRefs: [] });
  if (!cultivation) diagnostics.push({ id: "cultivation-missing", severity: "info", title: "修炼体系未初始化", detail: "本次推演不会生成修炼突破和超凡寿命变化。", sourceRefs: [] });

  const projectedCharacters = new Map(characterProjections.map((character) => [character.id, character]));
  scenario.scope.characterIds.forEach((characterId) => {
    const character = projectedCharacters.get(characterId);
    if (!character) {
      diagnostics.push({
        id: `selected-character-missing-${characterId}`,
        severity: "blocking",
        title: "选定人物不存在",
        detail: `运行方案引用了不存在的人物 ${characterId}。请在“空间与主体”中重新选择。`,
        sourceRefs: [],
      });
      return;
    }
    if (isDraftOrArchivedStatus(character.status)) {
      diagnostics.push({
        id: `selected-character-inactive-${character.id}`,
        severity: "blocking",
        title: `${character.name}尚未可参与推演`,
        detail: `人物当前状态为“${character.status}”。请先在人物库将其设为有效角色，或取消选中。`,
        sourceRefs: character.sourceRefs,
      });
    }
    if (!character.locationId) {
      diagnostics.push({
        id: `selected-character-location-missing-${character.id}`,
        severity: "blocking",
        title: `${character.name}缺少初始地点`,
        detail: "人物没有可验证的起始地域，不能生成旅行、感知或地域行动。请在人物资料或事实时间线中补充地点。",
        sourceRefs: character.sourceRefs,
      });
    }
  });

  const projectedFactions = new Map(factionProjections.map((faction) => [faction.id, faction]));
  scenario.scope.factionIds.forEach((factionId) => {
    if (projectedFactions.has(factionId)) return;
    diagnostics.push({
      id: `selected-faction-missing-${factionId}`,
      severity: "blocking",
      title: "选定势力不存在",
      detail: `运行方案引用了不存在的势力 ${factionId}。请在“空间与主体”中重新选择。`,
      sourceRefs: [],
    });
  });

  const projectedRegions = new Map(regions.map((region) => [region.id, region]));
  scenario.scope.regionIds.forEach((regionId) => {
    if (projectedRegions.has(regionId)) return;
    diagnostics.push({
      id: `selected-region-missing-${regionId}`,
      severity: "blocking",
      title: "选定地域不存在",
      detail: `运行方案引用了不存在的地域 ${regionId}。请在“空间与主体”中重新选择。`,
      sourceRefs: [],
    });
  });

  const scopedRegionIds = resolveWorldSimulationRegionScope(
    regions,
    scenario.scope,
  );
  const selectedCharacterIds = new Set(scenario.scope.characterIds);
  const selectedFactionIds = new Set(scenario.scope.factionIds);
  const eligibleCharacters = characterProjections.filter(
    (character) =>
      !isDraftOrArchivedStatus(character.status) &&
      character.locationId !== null &&
      (selectedCharacterIds.size > 0
        ? selectedCharacterIds.has(character.id)
        : scopedRegionIds.has(character.locationId)),
  );
  const eligibleFactions = factionProjections.filter((faction) => {
    if (/draft|archived|草稿|归档|dissolved|解散|灭亡/iu.test(faction.status))
      return false;
    const isInScope = selectedFactionIds.size > 0
      ? selectedFactionIds.has(faction.id)
      : faction.territoryIds.some((id) => scopedRegionIds.has(id));
    const hasTrigger =
      faction.relations.some(
        (relation) =>
          relation.status === "active" &&
          (relation.kind === "hostile" || relation.kind === "competitive"),
      ) ||
      faction.resources.some(
        (resource) =>
          resource.controlLevel === "contested" ||
          resource.competingFactionIds.length > 0,
      );
    return isInScope && hasTrigger;
  });
  if (eligibleCharacters.length === 0 && eligibleFactions.length === 0) {
    diagnostics.push({
      id: "actionable-subjects-missing",
      severity: "blocking",
      title: "没有可行动的推演主体",
      detail: "当前范围内没有已启用且具备初始地点的人物，也没有带有明确冲突或资源争夺的势力。请补充人物地点、事实事件，或势力关系与资源后再创建运行。",
      sourceRefs: [
        ...characterProjections.flatMap((character) => character.sourceRefs),
        ...factionProjections.flatMap((faction) => faction.sourceRefs),
      ],
    });
  }

  const sourceRefs = dedupeRefs([
    ref("novel.json", metadataHash, "canon", project.metadata.projectId),
    ref("manuscript/index.json", chapterIndexHash, "canon"),
    ref("characters/index.json", characterHash, "canon"),
    ref("world/factions/index.json", factionHash, "canon"),
    ref("timeline/index.json", timelineHash, timeline.library.factsThroughEventId ? "actual" : "planned"),
    ref(SETTING_LIBRARY_PATHS.meta, settingMetaHash, "canon"),
    ref(SETTING_LIBRARY_PATHS.spatialTree, spatialTreeHash, "canon"),
    ref(SETTING_LIBRARY_PATHS.settings, settingsIndexHash, "canon"),
    ...settingContents.flatMap((entry) => [
      ref(
        entry.setting.pagePath,
        entry.pageHash,
        entry.setting.status === "completed" ? "canon" : "author-secret",
        entry.setting.id,
      ),
      ref(
        entry.setting.entriesPath,
        entry.entriesHash,
        entry.setting.status === "completed" ? "canon" : "author-secret",
        entry.setting.id,
      ),
    ]),
    ref("narrative/index.json", narrativeHash, narrativeMode === "strict" ? "constraint" : "planned"),
    ref(ITEM_LIBRARY_PATHS.meta, itemMetaHash, "canon"),
    ref(ITEM_LIBRARY_PATHS.index, itemIndexHash, "canon"),
    ref(MAP_LIBRARY_PATH, mapIndexHash, "canon"),
    ...(cultivation ? [ref("world/cultivation-ecology.json", cultivationHash, "canon")] : []),
    ...timelineFacts.flatMap((event) => event.sourceRefs),
    ...timelinePlans.flatMap((event) => event.sourceRefs),
    ...characterProjections.flatMap((character) => character.sourceRefs),
    ...factionProjections.flatMap((faction) => faction.sourceRefs),
    ...regions.flatMap((region) => [
      ...region.sourceRefs,
      ...region.connections.flatMap((connection) => connection.sourceRefs),
    ]),
    ...itemProjections.flatMap((item) => item.sourceRefs),
    ...cultivationSystems.flatMap((system) => system.sourceRefs),
    ...ruleProjections.flatMap((rule) => rule.sourceRefs),
    ...narrativeConstraints.flatMap((constraint) => constraint.sourceRefs),
    ...chapters.flatMap((chapter) => chapter.sourceRefs),
    ...diagnostics.flatMap((diagnostic) => diagnostic.sourceRefs),
  ]);
  const sourceRevision = await hashSimulationSource(sourceRefs.map((item) => `${item.path}:${item.sourceHash}:${item.authority}`).sort().join("\n"));
  const baselineRevision = await hashSimulationSource([
    sourceRevision,
    `anchor:${anchorSortKey}`,
    `facts-through:${effectiveFactsThroughIndex >= 0 ? mainTimeline[effectiveFactsThroughIndex]?.id ?? "none" : "none"}`,
    `chapter:${scenario.chapterContext.mode}:${scenario.chapterContext.chapterId ?? "none"}`,
    `start:${scenario.start.mode}:${scenario.start.sortKey}`,
  ].join("\n"));
  const baselineId = `baseline-${baselineRevision.replace(/^[^:]+:/u, "").slice(0, 16)}`;

  return {
    schemaVersion: WORLD_SIMULATION_SCHEMA_VERSION,
    baselineId,
    projectId: project.metadata.projectId,
    projectTitle: project.metadata.title,
    sourceRevision,
    compiledAt: new Date().toISOString(),
    anchor: createWorldInstant(anchorSortKey, scenario.calendar),
    factsThroughEventId: effectiveFactsThroughIndex >= 0 ? mainTimeline[effectiveFactsThroughIndex]?.id ?? null : null,
    calendar: scenario.calendar,
    characters: characterProjections,
    factions: factionProjections,
    regions,
    items: itemProjections,
    cultivationSystems,
    rules: ruleProjections,
    timelineFacts,
    timelinePlans,
    narrativeConstraints,
    chapters,
    diagnostics,
    sourceRefs,
  };
}
