import type {
  WorkbenchSimulationActorSnapshot,
  WorkbenchSimulationAuthority,
  WorkbenchSimulationRuleSnapshot,
  WorkbenchSimulationSourceRef,
  WorkbenchSimulationWorldSnapshot,
  WorkbenchStorage,
} from "@/workbench-sdk";

import { createNovelCharacterLibraryRepository } from "./characterLibraryRepository";
import { createNovelFactionLibraryRepository } from "./factionLibraryRepository";
import { parseNovelMetadata } from "./projectSchema";
import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";
import {
  MAIN_TIMELINE_BRANCH_ID,
  getTimelineBranchEvents,
} from "./timelineLibrarySchema";
import { createNovelTimelineLibraryRepository } from "./timelineLibraryRepository";

const WORLD_RULES_PATH = "world/rules.json";

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values
    .flatMap((value) => (value ?? "").split(/[\r\n；;]+/u))
    .map((value) => value.trim())
    .filter(Boolean);
}

function fallbackHash(content: string): string {
  let hash = 0x811c9dc5;
  for (const value of new TextEncoder().encode(content)) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

async function hashText(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return fallbackHash(content);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function sourceRef(
  path: string,
  sourceHash: string,
  authority: WorkbenchSimulationAuthority,
): WorkbenchSimulationSourceRef {
  return { path, sourceHash, authority };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRules(
  content: string,
  sourceHash: string,
): WorkbenchSimulationRuleSnapshot[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.rules)) return [];
  const seen = new Set<string>();
  return value.rules.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const authority =
      raw.authority === "actual" || raw.authority === "canon"
        ? raw.authority
        : raw.authority === undefined
          ? "canon"
          : null;
    if (!authority) return [];
    const rawId =
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `rule-${index + 1}`;
    const id = `world-rule-${rawId}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const title =
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : rawId;
    const description = [raw.description, raw.summary, raw.content]
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
    return [
      {
        id,
        title,
        description,
        severity: raw.severity === "soft" ? "soft" : "hard",
        sourceRefs: [sourceRef(WORLD_RULES_PATH, sourceHash, authority)],
      },
    ];
  });
}

export interface BuildWorldSimulationSnapshotOptions {
  readonly anchor?: string;
}

export async function buildWorldSimulationSnapshot(
  storage: WorkbenchStorage,
  options: BuildWorldSimulationSnapshotOptions = {},
): Promise<WorkbenchSimulationWorldSnapshot> {
  const metadataFile = await storage.readText("novel.json");
  const metadata = parseNovelMetadata(metadataFile.content);
  const characterRepository = createNovelCharacterLibraryRepository(storage);
  const factionRepository = createNovelFactionLibraryRepository(storage);
  const settingRepository = createNovelSettingLibraryRepository(storage);
  const timelineRepository = createNovelTimelineLibraryRepository(storage);
  const [characters, factions, settings, timeline, rulesFile] =
    await Promise.all([
      characterRepository.load(),
      factionRepository.load(),
      settingRepository.load(metadata.title),
      timelineRepository.load(),
      storage.readText(WORLD_RULES_PATH),
    ]);

  const hashes = await Promise.all([
    hashText(metadataFile.content),
    hashText(characters.indexContent),
    hashText(factions.content),
    hashText(settings.spatialTreeContent),
    hashText(timeline.content),
    hashText(rulesFile.content),
  ]);
  const [metadataHash, characterHash, factionHash, locationHash, timelineHash, rulesHash] =
    hashes;

  const locations = settings.spatialTree.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    summary: `空间类型：${node.typeId}`,
    parentId: node.parentId,
    sourceRefs: [
      sourceRef(
        "world/setting-library/spatial-tree.json",
        locationHash,
        "canon",
      ),
    ],
  }));
  const locationIds = new Set(locations.map((location) => location.id));

  const characterActors: WorkbenchSimulationActorSnapshot[] =
    characters.index.characters.map((character) => ({
      id: `character-${character.id}`,
      name: character.name,
      kind: "character",
      summary: character.summary || character.storyRole,
      locationId: null,
      goals: compact([character.goals, character.motivation]),
      traits: compact([
        character.personality,
        character.values,
        character.strengths,
        character.weaknesses,
      ]),
      resources: compact([
        character.currentRealm,
        character.abilities,
        character.signatureItem,
        ...character.inventory.map(
          (item) => `${item.name}${item.quantity ? ` × ${item.quantity}` : ""}`,
        ),
      ]),
      knowledge: [],
      constraints: compact([character.fears, character.innerConflict]),
      sourceRefs: [
        sourceRef("characters/index.json", characterHash, "canon"),
      ],
    }));

  const factionActors: WorkbenchSimulationActorSnapshot[] =
    factions.library.factions.map((faction) => ({
      id: `faction-${faction.id}`,
      name: faction.name,
      kind: "faction",
      summary: faction.summary,
      locationId:
        faction.territories.find(
          (territory) =>
            territory.worldNodeId && locationIds.has(territory.worldNodeId),
        )?.worldNodeId ?? null,
      goals: compact([
        faction.state.governance,
        faction.state.military,
        faction.state.economy,
      ]),
      traits: compact([faction.type, faction.status]),
      resources: compact([
        ...faction.assets.map((asset) => `${asset.name}：${asset.value}`),
        ...faction.resources.map(
          (resource) => `${resource.name}：${resource.controlLevel}`,
        ),
        ...faction.rights
          .filter((right) => right.status === "active")
          .map((right) => right.name),
      ]),
      knowledge: [],
      constraints: compact([
        faction.state.publicSupport,
        faction.state.territorialIntegrity,
      ]),
      sourceRefs: [
        sourceRef("world/factions/index.json", factionHash, "canon"),
      ],
    }));
  const actors = [...characterActors, ...factionActors];
  const actorIds = new Set(actors.map((actor) => actor.id));

  const mainTimelineEvents = getTimelineBranchEvents(
    timeline.library,
    MAIN_TIMELINE_BRANCH_ID,
  );
  const factsThroughIndex = timeline.library.factsThroughEventId
    ? mainTimelineEvents.findIndex(
        ({ event }) => event.id === timeline.library.factsThroughEventId,
      )
    : -1;
  const factsThroughEvent =
    factsThroughIndex >= 0
      ? mainTimelineEvents[factsThroughIndex]?.event
      : undefined;
  const timelineEvents = mainTimelineEvents
    .slice(0, factsThroughIndex + 1)
    .map(({ event }) => ({
      id: event.id,
      title: event.title,
      summary: event.summary || event.description,
      timeLabel: event.timeLabel,
      actorIds: [
        ...event.characterIds.map((id) => `character-${id}`),
        ...event.factionIds.map((id) => `faction-${id}`),
      ].filter((id) => actorIds.has(id)),
      locationIds: event.locationIds.filter((id) => locationIds.has(id)),
      sourceRefs: [sourceRef("timeline/index.json", timelineHash, "actual")],
    }));
  const anchor =
    options.anchor?.trim() ||
    factsThroughEvent?.timeLabel ||
    factsThroughEvent?.title ||
    "当前设定基线";
  const sourceRevision = await hashText(
    JSON.stringify({
      metadata: metadataHash,
      characters: characterHash,
      factions: factionHash,
      locations: locationHash,
      timeline: timelineHash,
      rules: rulesHash,
    }),
  );

  return {
    schemaVersion: 1,
    projectId: metadata.projectId,
    title: metadata.title,
    sourceRevision,
    anchor,
    actors,
    locations,
    rules: parseRules(rulesFile.content, rulesHash),
    timelineEvents,
  };
}
