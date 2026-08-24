import { z } from "zod";

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const textSchema = z.string();
const referenceIdsSchema = z.array(idSchema).superRefine((ids, context) => {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "关联 id 不得重复",
      });
    }
    seen.add(id);
  });
});

export const timelineEventKindSchema = z.enum([
  "event",
  "turning-point",
  "battle",
  "discovery",
  "foreshadowing",
  "backstory",
]);

export type TimelineEventKind = z.infer<typeof timelineEventKindSchema>;

export const timelineEntityTypeSchema = z.enum([
  "character",
  "faction",
  "item",
  "location",
]);

export type TimelineEntityType = z.infer<typeof timelineEntityTypeSchema>;

export const timelineStateChangeSchema = z
  .object({
    id: idSchema,
    entityType: timelineEntityTypeSchema,
    entityId: idSchema,
    before: textSchema,
    after: textSchema,
    note: textSchema,
  })
  .strict();

export type TimelineStateChange = z.infer<typeof timelineStateChangeSchema>;

export const timelineForeshadowingStatusSchema = z.enum([
  "planted",
  "paid-off",
  "abandoned",
]);

export type TimelineForeshadowingStatus = z.infer<
  typeof timelineForeshadowingStatusSchema
>;

export const timelineForeshadowingSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    status: timelineForeshadowingStatusSchema,
    plantedChapterId: idSchema.nullable(),
    payoffEventId: idSchema.nullable(),
    note: textSchema,
  })
  .strict();

export type TimelineForeshadowing = z.infer<typeof timelineForeshadowingSchema>;

export const timelineTimePrecisionSchema = z.enum([
  "exact",
  "range",
  "approximate",
  "unknown",
]);

export type TimelineTimePrecision = z.infer<typeof timelineTimePrecisionSchema>;

export const timelineScopeSchema = z.enum(["universe", "local", "story"]);

export type TimelineScope = z.infer<typeof timelineScopeSchema>;

export const timelineKnowledgeScopeSchema = z.enum([
  "public",
  "local",
  "sect",
  "high",
  "observer",
]);

export type TimelineKnowledgeScope = z.infer<
  typeof timelineKnowledgeScopeSchema
>;

export const timelineTimeExpressionSchema = z
  .object({
    calendarId: idSchema,
    label: z.string().trim().min(1),
    startValue: z.number().finite().nullable(),
    endValue: z.number().finite().nullable(),
    precision: timelineTimePrecisionSchema,
  })
  .strict();

export type TimelineTimeExpression = z.infer<
  typeof timelineTimeExpressionSchema
>;

export const timelineEventSchema = z
  .object({
    id: idSchema,
    branchId: idSchema,
    timeLabel: z.string().trim().min(1),
    sortKey: z.number().finite(),
    worldSortKey: z
      .string()
      .regex(/^-?\d+$/u)
      .nullable()
      .optional(),
    sortOrder: z.number().int().nonnegative(),
    endSortKey: z.number().finite().nullable().default(null),
    timePrecision: timelineTimePrecisionSchema.default("exact"),
    timeExpressions: z.array(timelineTimeExpressionSchema).default([]),
    periodId: idSchema.nullable().default(null),
    scope: timelineScopeSchema.default("story"),
    knowledgeScope: timelineKnowledgeScopeSchema.default("public"),
    narrativeOrder: z.number().int().nonnegative().nullable().default(null),
    title: z.string().trim().min(1),
    kind: timelineEventKindSchema,
    summary: textSchema,
    description: textSchema,
    characterIds: referenceIdsSchema,
    locationIds: referenceIdsSchema,
    chapterIds: referenceIdsSchema,
    factionIds: referenceIdsSchema.default([]),
    itemIds: referenceIdsSchema.default([]),
    causeEventIds: referenceIdsSchema.default([]),
    stateChanges: z.array(timelineStateChangeSchema).default([]),
    foreshadowings: z.array(timelineForeshadowingSchema).default([]),
    tags: z.array(z.string().trim().min(1)).superRefine((tags, context) => {
      const seen = new Set<string>();
      tags.forEach((tag, index) => {
        if (seen.has(tag)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "标签不得重复",
          });
        }
        seen.add(tag);
      });
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TimelineEvent = z.infer<typeof timelineEventSchema>;
