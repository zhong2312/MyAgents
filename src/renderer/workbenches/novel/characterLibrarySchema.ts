import { z } from "zod";

import {
  characterGroupDefinitionSchema,
  characterRecordSchema,
  characterSoulDefinitionSchema,
  raceDefinitionSchema,
} from "../../../shared/novel-character-library-schema";
import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

import { CHARACTER_LIBRARY_SCHEMA_VERSION } from "./characterLibraryDefaults";

export {
  characterAppearanceSchema,
  characterGroupDefinitionSchema,
  characterInventoryItemSchema,
  characterRelationSchema,
  characterRecordSchema,
  characterRoleWeightSchema,
  characterSoulDefinitionSchema,
  raceDefinitionSchema,
} from "../../../shared/novel-character-library-schema";
export type {
  CharacterAppearance,
  CharacterGroupDefinition,
  CharacterInventoryItem,
  CharacterRelation,
  CharacterRecord,
  CharacterRoleWeight,
  CharacterSoulDefinition,
  RaceDefinition,
} from "../../../shared/novel-character-library-schema";

export const characterLibraryMetaSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_LIBRARY_SCHEMA_VERSION),
    races: z.array(raceDefinitionSchema),
    groups: z.array(characterGroupDefinitionSchema),
    ungroupedGroup: characterGroupDefinitionSchema,
    souls: z.array(characterSoulDefinitionSchema),
  })
  .strict()
  .superRefine((meta, context) => {
    const definitions: readonly [string, readonly { readonly id: string }[]][] =
      [
        ["种族", meta.races],
        ["角色分组", meta.groups],
        ["角色灵魂", meta.souls],
      ];
    for (const [label, records] of definitions) {
      const ids = new Set<string>();
      records.forEach((record, index) => {
        if (ids.has(record.id)) {
          context.addIssue({
            code: "custom",
            path: [
              label === "种族"
                ? "races"
                : label === "角色分组"
                  ? "groups"
                  : "souls",
              index,
              "id",
            ],
            message: `${label} id 不得重复`,
          });
        }
        ids.add(record.id);
      });
    }
    if (meta.groups.some((group) => group.id === meta.ungroupedGroup.id)) {
      context.addIssue({
        code: "custom",
        path: ["ungroupedGroup", "id"],
        message: "未分组标签不能与角色分组共用 id",
      });
    }
  });

export type CharacterLibraryMeta = z.infer<typeof characterLibraryMetaSchema>;

export const characterLibraryIndexSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_LIBRARY_SCHEMA_VERSION),
    characters: z.array(characterRecordSchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    index.characters.forEach((character, position) => {
      if (ids.has(character.id)) {
        context.addIssue({
          code: "custom",
          path: ["characters", position, "id"],
          message: "角色 id 不得重复",
        });
      }
      ids.add(character.id);
    });
  });

export type CharacterLibraryIndex = z.infer<typeof characterLibraryIndexSchema>;

export class CharacterLibraryFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "CharacterLibraryFormatError";
  }
}

function parseFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  content: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new CharacterLibraryFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CharacterLibraryFormatError(
      filePath,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function parseCharacterLibraryMeta(
  content: string,
): CharacterLibraryMeta {
  return parseFile(
    "characters/library.json",
    characterLibraryMetaSchema,
    content,
  );
}

export function parseCharacterLibraryIndex(
  content: string,
): CharacterLibraryIndex {
  return parseFile(
    "characters/index.json",
    characterLibraryIndexSchema,
    content,
  );
}

export function serializeCharacterLibraryFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeCharacterLibraryPath(path: string): string {
  return normalizeWorkbenchStoragePath(path);
}
