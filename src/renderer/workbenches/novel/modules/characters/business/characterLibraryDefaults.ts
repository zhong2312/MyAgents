import type {
  CharacterGroupDefinition,
  CharacterLibraryIndex,
  CharacterLibraryMeta,
  CharacterSoulDefinition,
  RaceDefinition,
} from "../entities/characterLibrarySchema";
import characterSoulPresets from "./characterSoulPresets.json";

export const CHARACTER_LIBRARY_SCHEMA_VERSION = 1 as const;
export const UNGROUPED_CHARACTER_GROUP_ID = "ungrouped";

const defaultRaces: readonly RaceDefinition[] = [
  {
    id: "human",
    name: "人族",
    description: "分布最广的族群，各地文化、体貌与寿命差异显著。",
  },
];

const builtInSouls: readonly CharacterSoulDefinition[] = characterSoulPresets;

const ungroupedGroup: CharacterGroupDefinition = {
  id: UNGROUPED_CHARACTER_GROUP_ID,
  name: "未分组",
  description: "尚未加入任何角色分组的角色。",
};

export function createDefaultCharacterLibraryMeta(): CharacterLibraryMeta {
  return {
    schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION,
    races: defaultRaces.map((race) => ({ ...race })),
    groups: [],
    ungroupedGroup: { ...ungroupedGroup },
    souls: builtInSouls.map((soul) => ({
      ...soul,
      expressionConflictKeywords: [...soul.expressionConflictKeywords],
      decisionConflictKeywords: [...soul.decisionConflictKeywords],
      valueConflictKeywords: [...soul.valueConflictKeywords],
      amplificationKeywords: [...soul.amplificationKeywords],
    })),
  };
}

export function createEmptyCharacterLibraryIndex(): CharacterLibraryIndex {
  return { schemaVersion: CHARACTER_LIBRARY_SCHEMA_VERSION, characters: [] };
}
