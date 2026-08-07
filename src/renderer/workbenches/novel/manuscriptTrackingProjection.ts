import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./characterLibraryRepository";
import type {
  CharacterAppearance,
  CharacterInventoryItem,
  CharacterRecord,
  CharacterRelation,
} from "./characterLibrarySchema";
import { createNovelFactionLibraryRepository } from "./modules/factions/data-access/factionLibraryRepository";
import type { FactionRecord } from "./modules/factions/entities/factionLibrarySchema";
import { createNovelItemLibraryRepository } from "./itemLibraryRepository";
import { createNovelLocationLibraryRepository } from "./locationLibraryRepository";
import type { NovelLocation } from "./locationLibrarySchema";
import {
  createEmptyManuscriptContinuityState,
  MANUSCRIPT_CONTINUITY_PATH,
  parseManuscriptContinuityState,
  serializeManuscriptContinuityState,
  type ManuscriptContinuityFact,
  type ManuscriptContinuityState,
  type ManuscriptTrackingBatch,
  type ManuscriptTrackingChange,
  type ManuscriptTrackingMutation,
} from "./manuscriptTrackingSchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";
import {
  MAIN_TIMELINE_BRANCH_ID,
  type TimelineEvent,
  type TimelineForeshadowing,
  type TimelineLibrary,
  type TimelineStateChange,
} from "./timelineLibrarySchema";

export interface ManuscriptProjectionChapter {
  readonly id: string;
  readonly number: number;
  readonly sequence: number;
  readonly title: string;
  readonly content: string;
}

interface LoadedContinuityState {
  readonly state: ManuscriptContinuityState;
  readonly content: string;
}

interface ProjectionState {
  readonly timeline: Awaited<
    ReturnType<ReturnType<typeof createNovelTimelineLibraryRepository>["load"]>
  >;
  readonly characters: {
    readonly library: Awaited<
      ReturnType<
        ReturnType<typeof createNovelCharacterLibraryRepository>["load"]
      >
    >;
    readonly records: readonly CharacterRecord[];
  };
  readonly items: Awaited<
    ReturnType<ReturnType<typeof createNovelItemLibraryRepository>["load"]>
  >;
  readonly locations: Awaited<
    ReturnType<ReturnType<typeof createNovelLocationLibraryRepository>["load"]>
  >;
  readonly factions: Awaited<
    ReturnType<ReturnType<typeof createNovelFactionLibraryRepository>["load"]>
  >;
  readonly continuity: LoadedContinuityState;
}

interface MutableProjection {
  timeline: TimelineLibrary;
  characters: CharacterRecord[];
  locations: NovelLocation[];
  factions: FactionRecord[];
  continuity: ManuscriptContinuityState;
}

export interface ProjectionSnapshotUpdate {
  readonly mutation: ManuscriptTrackingMutation;
  readonly expected: unknown | null;
  readonly value: unknown | null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableSuffix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function continuityContent(state: ManuscriptContinuityState): string {
  return serializeManuscriptContinuityState({
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

async function ensureContinuityFile(
  storage: WorkbenchStorage,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([MANUSCRIPT_CONTINUITY_PATH]);
  if (info?.exists) return storage.readText(MANUSCRIPT_CONTINUITY_PATH);
  const content = serializeManuscriptContinuityState(
    createEmptyManuscriptContinuityState(),
  );
  try {
    return await storage.createText(MANUSCRIPT_CONTINUITY_PATH, content, {
      createParents: true,
    });
  } catch {
    return storage.readText(MANUSCRIPT_CONTINUITY_PATH);
  }
}

function findCharacter(
  characters: readonly CharacterRecord[],
  id: string | null,
): CharacterRecord {
  const character = id
    ? characters.find((candidate) => candidate.id === id)
    : undefined;
  if (!character)
    throw new Error(`状态变化关联的人物不存在：${id ?? "未提供"}`);
  return character;
}

function findLocation(
  locations: readonly NovelLocation[],
  id: string | null,
): NovelLocation {
  const location = id
    ? locations.find((candidate) => candidate.id === id)
    : undefined;
  if (!location) throw new Error(`状态变化关联的地点不存在：${id ?? "未提供"}`);
  return location;
}

function findFaction(
  factions: readonly FactionRecord[],
  id: string | null,
): FactionRecord {
  const faction = id
    ? factions.find((candidate) => candidate.id === id)
    : undefined;
  if (!faction) throw new Error(`状态变化关联的势力不存在：${id ?? "未提供"}`);
  return faction;
}

function eventEntityType(
  change: ManuscriptTrackingChange,
): TimelineStateChange["entityType"] | null {
  if (
    change.domain === "character-state" ||
    change.domain === "character-appearance" ||
    change.domain === "relationship" ||
    change.domain === "inventory"
  )
    return "character";
  if (change.domain === "location") return "location";
  if (change.domain === "faction") return "faction";
  return null;
}

function timelineEventForBatch(
  state: ProjectionState,
  batch: ManuscriptTrackingBatch,
  changes: readonly ManuscriptTrackingChange[],
  chapter: ManuscriptProjectionChapter,
): TimelineEvent {
  const operation = changes.find(
    (change) => change.operation?.kind === "timeline-event",
  )?.operation;
  const now = new Date().toISOString();
  const sortKey = chapter.sequence;
  const sortOrder =
    state.timeline.library.events
      .filter((event) => event.sortKey === sortKey)
      .reduce((highest, event) => Math.max(highest, event.sortOrder), -1) + 1;
  const stateChanges = changes.flatMap((change): TimelineStateChange[] => {
    const entityType = eventEntityType(change);
    if (!entityType || !change.entityId) return [];
    return [
      {
        id: `state-${change.id}`,
        entityType,
        entityId: change.entityId,
        before: change.before ?? "",
        after: change.after,
        note: change.evidence,
      },
    ];
  });
  const eventId = `event-${batch.id}`;
  const characterIds = new Set<string>();
  const locationIds = new Set<string>();
  const factionIds = new Set<string>();
  const itemIds = new Set<string>();
  changes.forEach((change) => {
    if (!change.entityId) return;
    if (
      change.domain === "character-appearance" ||
      change.domain === "character-state" ||
      change.domain === "relationship" ||
      change.domain === "inventory"
    )
      characterIds.add(change.entityId);
    if (change.domain === "location") locationIds.add(change.entityId);
    if (change.domain === "faction") factionIds.add(change.entityId);
    if (change.operation?.kind === "inventory" && change.operation.itemId)
      itemIds.add(change.operation.itemId);
  });
  return {
    id: eventId,
    branchId: MAIN_TIMELINE_BRANCH_ID,
    timeLabel:
      operation?.kind === "timeline-event" && operation.timeLabel.trim()
        ? operation.timeLabel.trim()
        : `第 ${chapter.number} 章`,
    sortKey,
    sortOrder,
    endSortKey: null,
    timePrecision: "unknown",
    timeExpressions: [],
    periodId: null,
    scope: "story",
    knowledgeScope: "public",
    narrativeOrder: chapter.sequence,
    title:
      changes.find((change) => change.domain === "timeline")?.title ||
      batch.summary ||
      chapter.title,
    kind: operation?.kind === "timeline-event" ? operation.eventKind : "event",
    summary: batch.summary,
    description: changes
      .map((change) => `${change.title}：${change.after}`)
      .join("\n"),
    characterIds: [...characterIds],
    locationIds: [...locationIds],
    chapterIds: [chapter.id],
    factionIds: [...factionIds],
    itemIds: [...itemIds],
    causeEventIds: [],
    stateChanges,
    foreshadowings: changes.flatMap((change) => {
      if (
        change.operation?.kind !== "foreshadow" ||
        change.operation.status !== "planted"
      )
        return [];
      return [
        {
          id: `foreshadow-${change.id}`,
          title: change.title,
          status: change.operation.status,
          plantedChapterId: chapter.id,
          payoffEventId: change.operation.payoffEventId,
          note: `${change.after}\n证据：${change.evidence}`,
        },
      ];
    }),
    tags: ["正文同步"],
    createdAt: now,
    updatedAt: now,
  };
}

function mutation(
  input: Omit<ManuscriptTrackingMutation, "before" | "after">,
  before: unknown | null,
  after: unknown | null,
): ManuscriptTrackingMutation {
  return { ...input, before: cloneJson(before), after: cloneJson(after) };
}

function readMutationValue(
  projection: MutableProjection,
  target: ManuscriptTrackingMutation,
): unknown | null {
  if (target.targetKind === "timeline-event") {
    return (
      projection.timeline.events.find(
        (event) => event.id === target.entityId,
      ) ?? null
    );
  }
  if (
    target.targetKind === "character-appearance" ||
    target.targetKind === "character-field" ||
    target.targetKind === "relationship" ||
    target.targetKind === "inventory"
  ) {
    const character = findCharacter(projection.characters, target.entityId);
    if (target.targetKind === "character-appearance")
      return (
        character.appearances.find(
          (appearance) => appearance.chapter === target.relatedId,
        ) ?? null
      );
    if (target.targetKind === "character-field")
      return cloneJson(
        character[
          target.field as
            | "status"
            | "currentRealm"
            | "goals"
            | "motivation"
            | "hometown"
        ],
      );
    if (target.targetKind === "relationship")
      return (
        character.relations.find(
          (relation) => relation.targetId === target.relatedId,
        ) ?? null
      );
    return (
      character.inventory.find((item) => item.id === target.relatedId) ?? null
    );
  }
  if (target.targetKind === "location-field") {
    const location = findLocation(projection.locations, target.entityId);
    return cloneJson(
      location[target.field as "status" | "appearanceNote" | "summary"],
    );
  }
  if (target.targetKind === "faction-field") {
    const faction = findFaction(projection.factions, target.entityId);
    if (target.field === "status" || target.field === "summary")
      return cloneJson(faction[target.field]);
    return cloneJson(
      faction.state[
        target.field as
          | "governance"
          | "military"
          | "economy"
          | "publicSupport"
          | "territorialIntegrity"
      ],
    );
  }
  return (
    projection.continuity.facts.find((fact) => fact.id === target.relatedId) ??
    null
  );
}

function replaceCharacter(
  projection: MutableProjection,
  character: CharacterRecord,
): void {
  projection.characters = projection.characters.map((candidate) =>
    candidate.id === character.id ? character : candidate,
  );
}

function writeMutationValue(
  projection: MutableProjection,
  target: ManuscriptTrackingMutation,
  value: unknown | null,
): void {
  if (target.targetKind === "timeline-event") {
    projection.timeline = {
      ...projection.timeline,
      events: value
        ? [
            ...projection.timeline.events.filter(
              (event) => event.id !== target.entityId,
            ),
            cloneJson(value as TimelineEvent),
          ]
        : projection.timeline.events.filter(
            (event) => event.id !== target.entityId,
          ),
    };
    return;
  }
  if (
    target.targetKind === "character-appearance" ||
    target.targetKind === "character-field" ||
    target.targetKind === "relationship" ||
    target.targetKind === "inventory"
  ) {
    const character = findCharacter(projection.characters, target.entityId);
    if (target.targetKind === "character-appearance") {
      replaceCharacter(projection, {
        ...character,
        appearances: value
          ? [
              ...character.appearances.filter(
                (appearance) => appearance.chapter !== target.relatedId,
              ),
              cloneJson(value as CharacterAppearance),
            ]
          : character.appearances.filter(
              (appearance) => appearance.chapter !== target.relatedId,
            ),
      });
      return;
    }
    if (target.targetKind === "character-field") {
      replaceCharacter(projection, {
        ...character,
        [target.field!]: value,
      });
      return;
    }
    if (target.targetKind === "relationship") {
      replaceCharacter(projection, {
        ...character,
        relations: value
          ? [
              ...character.relations.filter(
                (relation) => relation.targetId !== target.relatedId,
              ),
              cloneJson(value as CharacterRelation),
            ]
          : character.relations.filter(
              (relation) => relation.targetId !== target.relatedId,
            ),
      });
      return;
    }
    replaceCharacter(projection, {
      ...character,
      inventory: value
        ? [
            ...character.inventory.filter(
              (item) => item.id !== target.relatedId,
            ),
            cloneJson(value as CharacterInventoryItem),
          ]
        : character.inventory.filter((item) => item.id !== target.relatedId),
    });
    return;
  }
  if (target.targetKind === "location-field") {
    projection.locations = projection.locations.map((location) =>
      location.id === target.entityId
        ? { ...location, [target.field!]: value }
        : location,
    );
    return;
  }
  if (target.targetKind === "faction-field") {
    projection.factions = projection.factions.map((faction) => {
      if (faction.id !== target.entityId) return faction;
      if (target.field === "status" || target.field === "summary")
        return {
          ...faction,
          [target.field]: value,
          updatedAt: new Date().toISOString(),
        };
      return {
        ...faction,
        state: { ...faction.state, [target.field!]: value },
        updatedAt: new Date().toISOString(),
      };
    });
    return;
  }
  projection.continuity = {
    ...projection.continuity,
    facts: value
      ? [
          ...projection.continuity.facts.filter(
            (fact) => fact.id !== target.relatedId,
          ),
          cloneJson(value as ManuscriptContinuityFact),
        ]
      : projection.continuity.facts.filter(
          (fact) => fact.id !== target.relatedId,
        ),
  };
}

function mutableProjection(state: ProjectionState): MutableProjection {
  return {
    timeline: cloneJson(state.timeline.library),
    characters: [...cloneJson(state.characters.records)],
    locations: cloneJson(state.locations.index.locations),
    factions: cloneJson(state.factions.library.factions),
    continuity: cloneJson(state.continuity.state),
  };
}

export function createManuscriptTrackingProjection(storage: WorkbenchStorage) {
  const timelineRepository = createNovelTimelineLibraryRepository(storage);
  const characterRepository = createNovelCharacterLibraryRepository(storage);
  const itemRepository = createNovelItemLibraryRepository(storage);
  const locationRepository = createNovelLocationLibraryRepository(storage);
  const factionRepository = createNovelFactionLibraryRepository(storage);

  const load = async (): Promise<ProjectionState> => {
    const [timeline, characterLibrary, items, locations, factions, continuityFile] =
      await Promise.all([
        timelineRepository.load(),
        characterRepository.load(),
        itemRepository.load(),
        locationRepository.load(),
        factionRepository.load(),
        ensureContinuityFile(storage),
      ]);
    return {
      timeline,
      characters: {
        library: characterLibrary,
        records: await loadCharacterRecords(
          characterRepository,
          characterLibrary,
        ),
      },
      items,
      locations,
      factions,
      continuity: {
        state: parseManuscriptContinuityState(continuityFile.content),
        content: continuityFile.content,
      },
    };
  };

  const save = async (
    state: ProjectionState,
    next: MutableProjection,
  ): Promise<void> => {
    const rollback: (() => Promise<unknown>)[] = [];
    try {
      if (!jsonEqual(state.timeline.library, next.timeline)) {
        const written = await timelineRepository.save(
          state.timeline,
          next.timeline,
        );
        rollback.push(() =>
          timelineRepository.save(written, state.timeline.library),
        );
      }
      if (!jsonEqual(state.characters.records, next.characters)) {
        let written = state.characters.library;
        const beforeById = new Map(
          state.characters.records.map((character) => [character.id, character]),
        );
        const nextIds = new Set(next.characters.map((character) => character.id));
        for (const character of next.characters) {
          if (jsonEqual(beforeById.get(character.id), character)) continue;
          written = await characterRepository.saveCharacter(written, character);
          const previous = beforeById.get(character.id);
          rollback.push(() =>
            previous
              ? characterRepository.saveCharacter(written, previous)
              : characterRepository.deleteCharacter(written, character.id),
          );
        }
        for (const character of state.characters.records) {
          if (nextIds.has(character.id)) continue;
          written = await characterRepository.deleteCharacter(written, character.id);
          rollback.push(() => characterRepository.saveCharacter(written, character));
        }
      }
      if (!jsonEqual(state.locations.index.locations, next.locations)) {
        const written = await locationRepository.save(state.locations, {
          ...state.locations.index,
          locations: next.locations,
        });
        rollback.push(() =>
          locationRepository.save(written, state.locations.index),
        );
      }
      if (!jsonEqual(state.factions.library.factions, next.factions)) {
        const written = await factionRepository.save(state.factions, {
          ...state.factions.library,
          factions: next.factions,
        });
        rollback.push(() =>
          factionRepository.save(written, state.factions.library),
        );
      }
      if (!jsonEqual(state.continuity.state, next.continuity)) {
        const content = continuityContent(next.continuity);
        const written = await storage.writeText(
          MANUSCRIPT_CONTINUITY_PATH,
          content,
          { expectedContent: state.continuity.content },
        );
        rollback.push(() =>
          storage.writeText(
            MANUSCRIPT_CONTINUITY_PATH,
            state.continuity.content,
            { expectedContent: written.content },
          ),
        );
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const undo of rollback.reverse()) {
        await undo().catch((cause) => failures.push(cause));
      }
      if (failures.length) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；状态事务补偿失败：${failures
            .map((cause) =>
              cause instanceof Error ? cause.message : String(cause),
            )
            .join("；")}`,
        );
      }
      throw error;
    }
  };

  const prepareMutations = (
    state: ProjectionState,
    batch: ManuscriptTrackingBatch,
    changes: readonly ManuscriptTrackingChange[],
    chapter: ManuscriptProjectionChapter,
  ): ManuscriptTrackingMutation[] => {
    const mutations: ManuscriptTrackingMutation[] = [];
    const event = timelineEventForBatch(state, batch, changes, chapter);
    const existingEvent =
      state.timeline.library.events.find(
        (candidate) => candidate.id === event.id,
      ) ?? null;
    mutations.push(
      mutation(
        {
          targetKey: `timeline-event:${event.id}`,
          targetKind: "timeline-event",
          entityId: event.id,
          relatedId: null,
          field: null,
        },
        existingEvent,
        event,
      ),
    );

    const itemIds = new Set(state.items.index.items.map((item) => item.id));
    for (const change of changes) {
      const operation = change.operation;
      if (!operation) throw new Error(`“${change.title}”缺少可执行的状态操作`);
      if (!chapter.content.includes(change.evidence))
        throw new Error(`“${change.title}”的正文证据已失效，请重新分析章节`);
      if (operation.kind === "timeline-event") continue;
      if (operation.kind === "foreshadow") {
        if (operation.status === "planted") continue;
        const foreshadowingId = operation.foreshadowingId;
        if (!foreshadowingId) {
          throw new Error(`“${change.title}”缺少要更新的伏笔 ID`);
        }
        const owner = state.timeline.library.events.find((candidate) =>
          candidate.foreshadowings.some(
            (foreshadowing) => foreshadowing.id === foreshadowingId,
          ),
        );
        const before = owner?.foreshadowings.find(
          (foreshadowing) => foreshadowing.id === foreshadowingId,
        );
        if (!owner || !before) {
          throw new Error(
            `“${change.title}”关联的伏笔不存在：${foreshadowingId}`,
          );
        }
        const updatedForeshadowing: TimelineForeshadowing = {
          ...before,
          status: operation.status,
          payoffEventId: operation.status === "paid-off" ? event.id : null,
          note: `${change.after}\n证据：${change.evidence}`,
        };
        const after: TimelineEvent = {
          ...owner,
          foreshadowings: owner.foreshadowings.map((foreshadowing) =>
            foreshadowing.id === foreshadowingId
              ? updatedForeshadowing
              : foreshadowing,
          ),
          updatedAt: new Date().toISOString(),
        };
        mutations.push(
          mutation(
            {
              targetKey: `timeline-event:${owner.id}`,
              targetKind: "timeline-event",
              entityId: owner.id,
              relatedId: null,
              field: null,
            },
            owner,
            after,
          ),
        );
        continue;
      }
      if (operation.kind === "character-appearance") {
        const character = findCharacter(
          state.characters.records,
          change.entityId,
        );
        const before =
          character.appearances.find(
            (appearance) => appearance.chapter === chapter.id,
          ) ?? null;
        const after: CharacterAppearance = {
          chapter: chapter.id,
          title: chapter.title,
          event: change.after,
          state: change.before ?? "",
        };
        mutations.push(
          mutation(
            {
              targetKey: `character-appearance:${character.id}:${chapter.id}`,
              targetKind: "character-appearance",
              entityId: character.id,
              relatedId: chapter.id,
              field: null,
            },
            before,
            after,
          ),
        );
        continue;
      }
      if (operation.kind === "character-field") {
        const character = findCharacter(
          state.characters.records,
          change.entityId,
        );
        mutations.push(
          mutation(
            {
              targetKey: `character-field:${character.id}:${operation.field}`,
              targetKind: "character-field",
              entityId: character.id,
              relatedId: null,
              field: operation.field,
            },
            character[operation.field],
            change.after,
          ),
        );
        continue;
      }
      if (operation.kind === "relationship") {
        const character = findCharacter(
          state.characters.records,
          change.entityId,
        );
        findCharacter(
          state.characters.records,
          operation.targetCharacterId,
        );
        const before =
          character.relations.find(
            (relation) => relation.targetId === operation.targetCharacterId,
          ) ?? null;
        const after: CharacterRelation = {
          targetId: operation.targetCharacterId,
          type: operation.relationType,
          tone: operation.tone,
          summary: change.after,
        };
        mutations.push(
          mutation(
            {
              targetKey: `relationship:${character.id}:${operation.targetCharacterId}`,
              targetKind: "relationship",
              entityId: character.id,
              relatedId: operation.targetCharacterId,
              field: null,
            },
            before,
            after,
          ),
        );
        continue;
      }
      if (operation.kind === "inventory") {
        const character = findCharacter(
          state.characters.records,
          change.entityId,
        );
        if (operation.itemId && !itemIds.has(operation.itemId))
          throw new Error(
            `“${change.title}”关联的物品不存在：${operation.itemId}`,
          );
        const existing = operation.itemId
          ? character.inventory.find((item) => item.itemId === operation.itemId)
          : undefined;
        const entryId = existing?.id ?? `inventory-${change.id}`;
        const after: CharacterInventoryItem = {
          id: entryId,
          itemId: operation.itemId,
          name: operation.name,
          quantity: operation.quantity,
          unit: operation.unit,
          description: change.after,
        };
        mutations.push(
          mutation(
            {
              targetKey: `inventory:${character.id}:${entryId}`,
              targetKind: "inventory",
              entityId: character.id,
              relatedId: entryId,
              field: null,
            },
            existing ?? null,
            after,
          ),
        );
        continue;
      }
      if (operation.kind === "location-field") {
        const location = findLocation(
          state.locations.index.locations,
          change.entityId,
        );
        const after =
          operation.field === "status"
            ? (operation.status ??
              (() => {
                throw new Error(`“${change.title}”缺少地点状态`);
              })())
            : change.after;
        mutations.push(
          mutation(
            {
              targetKey: `location-field:${location.id}:${operation.field}`,
              targetKind: "location-field",
              entityId: location.id,
              relatedId: null,
              field: operation.field,
            },
            location[operation.field],
            after,
          ),
        );
        continue;
      }
      if (operation.kind === "faction-field") {
        const faction = findFaction(
          state.factions.library.factions,
          change.entityId,
        );
        const before =
          operation.field === "status" || operation.field === "summary"
            ? faction[operation.field]
            : faction.state[operation.field];
        const after =
          operation.field === "status"
            ? (operation.status ??
              (() => {
                throw new Error(`“${change.title}”缺少势力状态`);
              })())
            : change.after;
        mutations.push(
          mutation(
            {
              targetKey: `faction-field:${faction.id}:${operation.field}`,
              targetKind: "faction-field",
              entityId: faction.id,
              relatedId: null,
              field: operation.field,
            },
            before,
            after,
          ),
        );
        continue;
      }
      const factKey = operation.key.startsWith("fact-")
        ? change.id
        : operation.key;
      const factId = `continuity-${stableSuffix(factKey)}`;
      const before =
        state.continuity.state.facts.find((fact) => fact.id === factId) ?? null;
      const after: ManuscriptContinuityFact = {
        id: factId,
        domain: change.domain === "world-rule" ? "world-rule" : "continuity",
        entityId: change.entityId,
        title: change.title,
        value: change.after,
        evidence: change.evidence,
        chapterId: chapter.id,
        batchId: batch.id,
        changeId: change.id,
        updatedAt: new Date().toISOString(),
      };
      mutations.push(
        mutation(
          {
            targetKey: `continuity-fact:${factId}`,
            targetKind: "continuity-fact",
            entityId: change.entityId,
            relatedId: factId,
            field: null,
          },
          before,
          after,
        ),
      );
    }
    const compacted = new Map<string, ManuscriptTrackingMutation>();
    for (const entry of mutations) {
      const current = compacted.get(entry.targetKey);
      compacted.set(
        entry.targetKey,
        current ? { ...entry, before: current.before } : entry,
      );
    }
    return [...compacted.values()];
  };

  return Object.freeze({
    async prepareBatch(
      batch: ManuscriptTrackingBatch,
      changes: readonly ManuscriptTrackingChange[],
      chapter: ManuscriptProjectionChapter,
    ): Promise<readonly ManuscriptTrackingMutation[]> {
      const state = await load();
      return prepareMutations(state, batch, changes, chapter);
    },

    async applySnapshots(
      updates: readonly ProjectionSnapshotUpdate[],
    ): Promise<void> {
      if (!updates.length) return;
      const state = await load();
      const next = mutableProjection(state);
      for (const update of updates) {
        const current = readMutationValue(next, update.mutation);
        if (!jsonEqual(current, update.expected)) {
          throw new Error(
            `“${update.mutation.targetKey}”已被其它模块修改，无法安全回退；请先处理状态冲突`,
          );
        }
        writeMutationValue(next, update.mutation, update.value);
      }
      await save(state, next);
    },
  });
}
