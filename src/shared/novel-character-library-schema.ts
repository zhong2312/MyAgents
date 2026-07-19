import { z } from "zod";

export const characterLibraryIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const textSchema = z.string();
const trimmedTextSchema = z.string().trim();

export const characterRoleWeightSchema = z.enum([
  "main",
  "secondary",
  "npc",
  "extra",
]);

export type CharacterRoleWeight = z.infer<typeof characterRoleWeightSchema>;

export const characterRelationSchema = z
  .object({
    targetId: characterLibraryIdSchema,
    type: trimmedTextSchema,
    tone: z.enum(["positive", "negative", "neutral"]),
    summary: textSchema,
  })
  .strict();

export type CharacterRelation = z.infer<typeof characterRelationSchema>;

export const characterAppearanceSchema = z
  .object({
    chapter: textSchema,
    title: textSchema,
    event: textSchema,
    state: textSchema,
  })
  .strict();

export type CharacterAppearance = z.infer<typeof characterAppearanceSchema>;

export const characterInventoryItemSchema = z
  .object({
    id: characterLibraryIdSchema,
    itemId: characterLibraryIdSchema.nullable(),
    name: z.string().trim().min(1),
    quantity: z.number().finite().min(0),
    unit: textSchema,
    description: textSchema,
  })
  .strict();

export type CharacterInventoryItem = z.infer<
  typeof characterInventoryItemSchema
>;

const characterArcStageSchema = z
  .object({
    title: textSchema,
    state: textSchema,
    detail: textSchema,
    complete: z.boolean(),
  })
  .strict();

export const characterRecordSchema = z
  .object({
    id: characterLibraryIdSchema,
    name: z.string().trim().min(1),
    alias: textSchema,
    roleWeight: characterRoleWeightSchema,
    archetype: textSchema,
    alignment: textSchema,
    status: textSchema,
    summary: textSchema,
    identities: z.array(trimmedTextSchema),
    age: textSchema,
    gender: textSchema,
    raceId: characterLibraryIdSchema.or(z.literal("")),
    soulId: characterLibraryIdSchema.or(z.literal("")),
    groupIds: z.array(characterLibraryIdSchema),
    hometown: textSchema,
    appearance: textSchema,
    personality: textSchema,
    values: textSchema,
    strengths: textSchema,
    weaknesses: textSchema,
    fears: textSchema,
    motivation: textSchema,
    goals: textSchema,
    innerConflict: textSchema,
    background: textSchema,
    abilities: textSchema,
    speechStyle: textSchema,
    habits: textSchema,
    signatureItem: textSchema,
    storyRole: textSchema,
    arc: textSchema,
    firstAppearance: textSchema,
    completeness: z.number().int().min(0).max(100),
    relations: z.array(characterRelationSchema),
    appearances: z.array(characterAppearanceSchema),
    arcStages: z.array(characterArcStageSchema),
    // 兼容新增物品栏前已保存的角色记录。
    inventory: z.array(characterInventoryItemSchema).default([]),
  })
  .strict()
  .superRefine((character, context) => {
    const itemIds = new Set<string>();
    character.inventory.forEach((item, index) => {
      if (itemIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["inventory", index, "id"],
          message: "物品栏条目 id 不得重复",
        });
      }
      itemIds.add(item.id);
    });
  });

export type CharacterRecord = z.infer<typeof characterRecordSchema>;

export const raceDefinitionSchema = z
  .object({
    id: characterLibraryIdSchema,
    name: z.string().trim().min(1),
    description: textSchema,
  })
  .strict();

export type RaceDefinition = z.infer<typeof raceDefinitionSchema>;

export const characterSoulDefinitionSchema = z
  .object({
    id: characterLibraryIdSchema,
    builtIn: z.boolean(),
    name: z.string().trim().min(1),
    category: textSchema,
    summary: textSchema,
    expressionDna: textSchema,
    mentalModel: textSchema,
    decisionHeuristics: textSchema,
    valueAntiPatterns: textSchema,
    boundaries: textSchema,
    expressionConflictKeywords: z.array(trimmedTextSchema),
    decisionConflictKeywords: z.array(trimmedTextSchema),
    valueConflictKeywords: z.array(trimmedTextSchema),
    amplificationKeywords: z.array(trimmedTextSchema),
  })
  .strict();

export type CharacterSoulDefinition = z.infer<
  typeof characterSoulDefinitionSchema
>;

export const characterGroupDefinitionSchema = z
  .object({
    id: characterLibraryIdSchema,
    name: z.string().trim().min(1),
    description: textSchema,
  })
  .strict();

export type CharacterGroupDefinition = z.infer<
  typeof characterGroupDefinitionSchema
>;
