import { z } from "zod";

export const NARRATIVE_ENGINEERING_SCHEMA_VERSION = 3 as const;
export const NARRATIVE_ENGINEERING_PATH = "narrative/index.json";

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);
const textSchema = z.string();
const uniqueIdsSchema = z.array(idSchema).superRefine((ids, context) => {
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

export const plotLineKindSchema = z.enum([
  "main",
  "emotion",
  "mirror",
  "information",
  "theme",
  "custom",
]);
export type PlotLineKind = z.infer<typeof plotLineKindSchema>;

export const plotLineStoryRoleSchema = z.enum(["a", "b", "both", "none"]);
export type PlotLineStoryRole = z.infer<typeof plotLineStoryRoleSchema>;

export const narrativeKeyNodeLocationSchema = z
  .object({
    id: idSchema,
    chapterId: idSchema,
    sectionId: idSchema.nullable(),
  })
  .strict();

export type NarrativeKeyNodeLocation = z.infer<
  typeof narrativeKeyNodeLocationSchema
>;

export const narrativeKeyNodeSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    content: textSchema,
    order: z.number().int().nonnegative(),
    locations: z.array(narrativeKeyNodeLocationSchema),
  })
  .strict();

export type NarrativeKeyNode = z.infer<typeof narrativeKeyNodeSchema>;

const plotLineV2Schema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    kind: plotLineKindSchema,
    storyRole: plotLineStoryRoleSchema.default("none"),
    status: z.enum(["idea", "active", "resolved", "paused"]),
    color: z.string().regex(/^#[0-9a-f]{6}$/iu),
    premise: textSchema,
    dramaticQuestion: textSchema,
    protagonistCharacterId: idSchema.nullable(),
    want: textSchema,
    obstacle: textSchema,
    finalConfrontation: textSchema,
    resolution: textSchema,
    themePosition: textSchema,
  })
  .strict();

type PlotLineV2 = z.infer<typeof plotLineV2Schema>;

export const plotLineSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    kind: plotLineKindSchema,
    storyRole: plotLineStoryRoleSchema.default("none"),
    status: z.enum(["idea", "active", "resolved", "paused"]),
    color: z.string().regex(/^#[0-9a-f]{6}$/iu),
    premise: textSchema,
    protagonistCharacterId: idSchema.nullable(),
    keyNodes: z.array(narrativeKeyNodeSchema),
    content: textSchema,
  })
  .strict();

export type PlotLine = z.infer<typeof plotLineSchema>;

const storyArcV2Schema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    kind: z.enum([
      "plot",
      "character",
      "relationship",
      "mystery",
      "theme",
      "custom",
    ]),
    characterId: idSchema.nullable(),
    characterArcStageId: idSchema.nullable().default(null),
    characterArcStageTitle: textSchema,
    lineIds: uniqueIdsSchema,
    openingState: textSchema,
    lie: textSchema,
    wound: textSchema,
    truth: textSchema,
    crack: textSchema,
    midpointShift: textSchema,
    darkNight: textSchema,
    finalChoice: textSchema,
    endingState: textSchema,
  })
  .strict();

type StoryArcV2 = z.infer<typeof storyArcV2Schema>;

export const storyArcSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1),
    kind: z.enum([
      "plot",
      "character",
      "relationship",
      "mystery",
      "theme",
      "custom",
    ]),
    characterId: idSchema.nullable(),
    characterArcStageId: idSchema.nullable().default(null),
    characterArcStageTitle: textSchema,
    lineIds: uniqueIdsSchema,
    keyNodes: z.array(narrativeKeyNodeSchema),
    content: textSchema,
  })
  .strict();

export type StoryArc = z.infer<typeof storyArcSchema>;

export const narrativeDirectoryKindSchema = z.enum(["volume", "part", "group"]);
export type NarrativeDirectoryKind = z.infer<
  typeof narrativeDirectoryKindSchema
>;

export const narrativePlanStatusSchema = z.enum([
  "idea",
  "planned",
  "drafting",
  "complete",
]);
export type NarrativePlanStatus = z.infer<typeof narrativePlanStatusSchema>;

export const narrativeDirectorySchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    kind: narrativeDirectoryKindSchema,
    title: z.string().trim().min(1),
    description: textSchema,
    status: narrativePlanStatusSchema,
    order: z.number().int().nonnegative(),
  })
  .strict();

export type NarrativeDirectory = z.infer<typeof narrativeDirectorySchema>;

export const narrativeParagraphPlanSchema = z
  .object({
    id: idSchema,
    order: z.number().int().nonnegative(),
    content: textSchema,
  })
  .strict();

export type NarrativeParagraphPlan = z.infer<
  typeof narrativeParagraphPlanSchema
>;

export const narrativeSectionPlanSchema = z
  .object({
    id: idSchema,
    order: z.number().int().nonnegative(),
    title: textSchema,
    description: textSchema,
    povCharacterId: idSchema.nullable(),
    lineIds: uniqueIdsSchema,
    arcIds: uniqueIdsSchema,
    paragraphs: z.array(narrativeParagraphPlanSchema),
  })
  .strict();

export type NarrativeSectionPlan = z.infer<typeof narrativeSectionPlanSchema>;

export const narrativeChapterPlanSchema = z
  .object({
    id: idSchema,
    directoryId: idSchema.nullable(),
    manuscriptChapterId: idSchema.nullable(),
    title: z.string().trim().min(1),
    description: textSchema,
    status: narrativePlanStatusSchema,
    order: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    lineIds: uniqueIdsSchema,
    arcIds: uniqueIdsSchema,
    sections: z.array(narrativeSectionPlanSchema),
  })
  .strict();

export type NarrativeChapterPlan = z.infer<typeof narrativeChapterPlanSchema>;

const legacyTrackFieldsSchema = z
  .object({
    lines: z.array(
      z
        .object({
          id: idSchema,
          dramaticQuestion: textSchema,
          want: textSchema,
          obstacle: textSchema,
          finalConfrontation: textSchema,
          resolution: textSchema,
          themePosition: textSchema,
        })
        .strict(),
    ),
    arcs: z.array(
      z
        .object({
          id: idSchema,
          openingState: textSchema,
          lie: textSchema,
          wound: textSchema,
          truth: textSchema,
          crack: textSchema,
          midpointShift: textSchema,
          darkNight: textSchema,
          finalChoice: textSchema,
          endingState: textSchema,
        })
        .strict(),
    ),
  })
  .strict();

const legacyArchiveSchema = z
  .object({
    sourceSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    migratedAt: z.string().datetime(),
    theme: z.unknown(),
    motifs: z.array(z.unknown()),
    beats: z.array(z.unknown()),
    nodes: z.array(z.unknown()),
    storyArcNodeLinks: z.array(
      z
        .object({
          arcId: idSchema,
          nodeIds: z.array(z.unknown()),
        })
        .strict(),
    ),
    trackFields: legacyTrackFieldsSchema.optional(),
  })
  .strict();

export type NarrativeLegacyArchive = z.infer<typeof legacyArchiveSchema>;

export const narrativeEngineeringSchema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_ENGINEERING_SCHEMA_VERSION),
    updatedAt: z.string().datetime(),
    lines: z.array(plotLineSchema),
    arcs: z.array(storyArcSchema),
    directories: z.array(narrativeDirectorySchema),
    chapters: z.array(narrativeChapterPlanSchema),
    legacyArchive: legacyArchiveSchema.optional(),
  })
  .strict()
  .superRefine((library, context) => {
    const collections: readonly [string, readonly { readonly id: string }[]][] =
      [
        ["lines", library.lines],
        ["arcs", library.arcs],
        ["directories", library.directories],
        ["chapters", library.chapters],
      ];
    collections.forEach(([key, records]) => {
      const ids = new Set<string>();
      records.forEach((record, index) => {
        if (ids.has(record.id)) {
          context.addIssue({
            code: "custom",
            path: [key, index, "id"],
            message: "id 不得重复",
          });
        }
        ids.add(record.id);
      });
    });

    const nestedIds = new Set<string>();
    library.chapters.forEach((chapter, chapterIndex) => {
      chapter.sections.forEach((section, sectionIndex) => {
        if (nestedIds.has(section.id)) {
          context.addIssue({
            code: "custom",
            path: ["chapters", chapterIndex, "sections", sectionIndex, "id"],
            message: "节 id 在项目内不得重复",
          });
        }
        nestedIds.add(section.id);
        section.paragraphs.forEach((paragraph, paragraphIndex) => {
          if (nestedIds.has(paragraph.id)) {
            context.addIssue({
              code: "custom",
              path: [
                "chapters",
                chapterIndex,
                "sections",
                sectionIndex,
                "paragraphs",
                paragraphIndex,
                "id",
              ],
              message: "节和段的 id 在项目内不得重复",
            });
          }
          nestedIds.add(paragraph.id);
        });
      });
    });

    const chapterById = new Map(
      library.chapters.map((chapter) => [chapter.id, chapter]),
    );
    const keyNodeIds = new Set<string>();
    const locationIds = new Set<string>();
    const validateKeyNodes = (
      collection: "lines" | "arcs",
      owners: readonly (PlotLine | StoryArc)[],
    ) => {
      owners.forEach((owner, ownerIndex) => {
        owner.keyNodes.forEach((node, nodeIndex) => {
          if (keyNodeIds.has(node.id)) {
            context.addIssue({
              code: "custom",
              path: [collection, ownerIndex, "keyNodes", nodeIndex, "id"],
              message: "关键节点 id 在项目内不得重复",
            });
          }
          keyNodeIds.add(node.id);
          const targets = new Set<string>();
          node.locations.forEach((location, locationIndex) => {
            if (locationIds.has(location.id)) {
              context.addIssue({
                code: "custom",
                path: [
                  collection,
                  ownerIndex,
                  "keyNodes",
                  nodeIndex,
                  "locations",
                  locationIndex,
                  "id",
                ],
                message: "关键节点关联位置 id 在项目内不得重复",
              });
            }
            locationIds.add(location.id);
            const targetKey = `${location.chapterId}:${location.sectionId ?? ""}`;
            if (targets.has(targetKey)) {
              context.addIssue({
                code: "custom",
                path: [
                  collection,
                  ownerIndex,
                  "keyNodes",
                  nodeIndex,
                  "locations",
                  locationIndex,
                ],
                message: "同一个关键节点不能重复关联同一章或节",
              });
            }
            targets.add(targetKey);
            const chapter = chapterById.get(location.chapterId);
            if (!chapter) {
              context.addIssue({
                code: "custom",
                path: [
                  collection,
                  ownerIndex,
                  "keyNodes",
                  nodeIndex,
                  "locations",
                  locationIndex,
                  "chapterId",
                ],
                message: "关键节点关联了不存在的章节",
              });
            } else if (
              location.sectionId &&
              !chapter.sections.some(
                (section) => section.id === location.sectionId,
              )
            ) {
              context.addIssue({
                code: "custom",
                path: [
                  collection,
                  ownerIndex,
                  "keyNodes",
                  nodeIndex,
                  "locations",
                  locationIndex,
                  "sectionId",
                ],
                message: "关键节点关联的节不属于指定章节",
              });
            }
          });
        });
      });
    };
    validateKeyNodes("lines", library.lines);
    validateKeyNodes("arcs", library.arcs);
  });

export type NarrativeEngineering = z.infer<typeof narrativeEngineeringSchema>;

export function createEmptyNarrativeEngineering(
  createdAt = new Date().toISOString(),
): NarrativeEngineering {
  return {
    schemaVersion: NARRATIVE_ENGINEERING_SCHEMA_VERSION,
    updatedAt: createdAt,
    lines: [],
    arcs: [],
    directories: [],
    chapters: [],
  };
}

const legacyNodeSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable(),
    kind: z.enum([
      "folder",
      "volume",
      "part",
      "chapter",
      "section",
      "paragraph",
    ]),
    title: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    status: narrativePlanStatusSchema,
    manuscriptChapterId: idSchema.nullable(),
    summary: textSchema,
    lineIds: uniqueIdsSchema,
    arcIds: uniqueIdsSchema,
    povCharacterId: idSchema.nullable(),
  })
  .passthrough();

type LegacyNode = z.infer<typeof legacyNodeSchema>;

const legacyArcSchema = storyArcV2Schema
  .omit({})
  .extend({ nodeIds: uniqueIdsSchema })
  .passthrough();

const legacyEngineeringSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().datetime(),
    theme: z.unknown(),
    motifs: z.array(z.unknown()),
    lines: z.array(plotLineV2Schema),
    arcs: z.array(legacyArcSchema),
    beats: z.array(z.unknown()),
    nodes: z.array(legacyNodeSchema),
  })
  .passthrough();

const narrativeEngineeringV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    updatedAt: z.string().datetime(),
    lines: z.array(plotLineV2Schema),
    arcs: z.array(storyArcV2Schema),
    directories: z.array(narrativeDirectorySchema),
    chapters: z.array(narrativeChapterPlanSchema),
    legacyArchive: legacyArchiveSchema.optional(),
  })
  .strict();

function migrateLineFromV2(line: PlotLineV2): PlotLine {
  const {
    dramaticQuestion: _dramaticQuestion,
    want: _want,
    obstacle: _obstacle,
    finalConfrontation: _finalConfrontation,
    resolution: _resolution,
    themePosition: _themePosition,
    ...next
  } = line;
  return { ...next, keyNodes: [], content: "" };
}

function migrateArcFromV2(arc: StoryArcV2): StoryArc {
  const {
    openingState: _openingState,
    lie: _lie,
    wound: _wound,
    truth: _truth,
    crack: _crack,
    midpointShift: _midpointShift,
    darkNight: _darkNight,
    finalChoice: _finalChoice,
    endingState: _endingState,
    ...next
  } = arc;
  return { ...next, keyNodes: [], content: "" };
}

function legacyTrackFields(
  lines: readonly PlotLineV2[],
  arcs: readonly StoryArcV2[],
): z.infer<typeof legacyTrackFieldsSchema> {
  return {
    lines: lines.map((line) => ({
      id: line.id,
      dramaticQuestion: line.dramaticQuestion,
      want: line.want,
      obstacle: line.obstacle,
      finalConfrontation: line.finalConfrontation,
      resolution: line.resolution,
      themePosition: line.themePosition,
    })),
    arcs: arcs.map((arc) => ({
      id: arc.id,
      openingState: arc.openingState,
      lie: arc.lie,
      wound: arc.wound,
      truth: arc.truth,
      crack: arc.crack,
      midpointShift: arc.midpointShift,
      darkNight: arc.darkNight,
      finalChoice: arc.finalChoice,
      endingState: arc.endingState,
    })),
  };
}

function orderedLegacyNodes(
  nodes: readonly LegacyNode[],
): readonly LegacyNode[] {
  const children = new Map<string | null, LegacyNode[]>();
  nodes.forEach((node) => {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  });
  children.forEach((siblings) =>
    siblings.sort((left, right) =>
      left.order !== right.order
        ? left.order - right.order
        : left.id.localeCompare(right.id),
    ),
  );
  const result: LegacyNode[] = [];
  const visited = new Set<string>();
  const append = (parentId: string | null) => {
    (children.get(parentId) ?? []).forEach((node) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      result.push(node);
      append(node.id);
    });
  };
  append(null);
  nodes.forEach((node) => {
    if (!visited.has(node.id)) {
      visited.add(node.id);
      result.push(node);
      append(node.id);
    }
  });
  return result;
}

function nearestLegacyAncestor(
  node: LegacyNode,
  nodeById: ReadonlyMap<string, LegacyNode>,
  kinds: ReadonlySet<LegacyNode["kind"]>,
): LegacyNode | null {
  const visited = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);
    const parent = nodeById.get(parentId);
    if (!parent) return null;
    if (kinds.has(parent.kind)) return parent;
    parentId = parent.parentId;
  }
  return null;
}

function migrateLegacyEngineering(
  legacy: z.infer<typeof legacyEngineeringSchema>,
): NarrativeEngineering {
  const nodeById = new Map(legacy.nodes.map((node) => [node.id, node]));
  const orderedNodes = orderedLegacyNodes(legacy.nodes);
  const directoryKinds = new Set<LegacyNode["kind"]>([
    "folder",
    "volume",
    "part",
  ]);
  const directories: NarrativeDirectory[] = orderedNodes.flatMap((node) => {
    if (!directoryKinds.has(node.kind)) return [];
    const parent = nearestLegacyAncestor(node, nodeById, directoryKinds);
    return [
      {
        id: node.id,
        parentId: parent?.id ?? null,
        kind:
          node.kind === "folder" ? "group" : (node.kind as "volume" | "part"),
        title: node.title,
        description: node.summary,
        status: node.status,
        order: node.order,
      },
    ];
  });

  const sectionNodes = orderedNodes.filter((node) => node.kind === "section");
  const paragraphNodes = orderedNodes.filter(
    (node) => node.kind === "paragraph",
  );
  const chapterKinds = new Set<LegacyNode["kind"]>(["chapter"]);
  const sectionKinds = new Set<LegacyNode["kind"]>(["section"]);
  const chapters: NarrativeChapterPlan[] = orderedNodes.flatMap((node) => {
    if (node.kind !== "chapter") return [];
    const directory = nearestLegacyAncestor(node, nodeById, directoryKinds);
    const sections: NarrativeSectionPlan[] = sectionNodes.flatMap((section) => {
      if (
        nearestLegacyAncestor(section, nodeById, chapterKinds)?.id !== node.id
      ) {
        return [];
      }
      const paragraphs = paragraphNodes.flatMap((paragraph) => {
        if (
          nearestLegacyAncestor(paragraph, nodeById, sectionKinds)?.id !==
          section.id
        ) {
          return [];
        }
        const content =
          paragraph.summary.trim() &&
          paragraph.summary.trim() !== paragraph.title
            ? `${paragraph.title}\n${paragraph.summary}`
            : paragraph.summary || paragraph.title;
        return [
          {
            id: paragraph.id,
            order: paragraph.order,
            content,
          },
        ];
      });
      return [
        {
          id: section.id,
          order: section.order,
          title: section.title,
          description: section.summary,
          povCharacterId: section.povCharacterId,
          lineIds: section.lineIds,
          arcIds: section.arcIds,
          paragraphs,
        },
      ];
    });
    return [
      {
        id: node.id,
        directoryId: directory?.id ?? null,
        manuscriptChapterId: node.manuscriptChapterId,
        title: node.title,
        description: node.summary,
        status: node.status,
        order: node.order,
        updatedAt: legacy.updatedAt,
        lineIds: node.lineIds,
        arcIds: node.arcIds,
        sections,
      },
    ];
  });

  return narrativeEngineeringSchema.parse({
    schemaVersion: NARRATIVE_ENGINEERING_SCHEMA_VERSION,
    updatedAt: legacy.updatedAt,
    lines: legacy.lines.map(migrateLineFromV2),
    arcs: legacy.arcs.map(({ nodeIds: _nodeIds, ...arc }) =>
      migrateArcFromV2(arc),
    ),
    directories,
    chapters,
    legacyArchive: {
      sourceSchemaVersion: 1,
      migratedAt: new Date().toISOString(),
      theme: legacy.theme,
      motifs: legacy.motifs,
      beats: legacy.beats,
      nodes: legacy.nodes,
      storyArcNodeLinks: legacy.arcs.map((arc) => ({
        arcId: arc.id,
        nodeIds: arc.nodeIds,
      })),
      trackFields: legacyTrackFields(
        legacy.lines,
        legacy.arcs.map(({ nodeIds: _nodeIds, ...arc }) => arc),
      ),
    },
  });
}

function migrateV2Engineering(
  legacy: z.infer<typeof narrativeEngineeringV2Schema>,
): NarrativeEngineering {
  const archive = legacy.legacyArchive;
  return narrativeEngineeringSchema.parse({
    schemaVersion: NARRATIVE_ENGINEERING_SCHEMA_VERSION,
    updatedAt: legacy.updatedAt,
    lines: legacy.lines.map(migrateLineFromV2),
    arcs: legacy.arcs.map(migrateArcFromV2),
    directories: legacy.directories,
    chapters: legacy.chapters,
    legacyArchive: {
      sourceSchemaVersion: 2,
      migratedAt: new Date().toISOString(),
      theme: archive?.theme ?? null,
      motifs: archive?.motifs ?? [],
      beats: archive?.beats ?? [],
      nodes: archive?.nodes ?? [],
      storyArcNodeLinks: archive?.storyArcNodeLinks ?? [],
      trackFields: legacyTrackFields(legacy.lines, legacy.arcs),
    },
  });
}

export class NarrativeEngineeringFormatError extends Error {
  constructor(detail: string) {
    super(`${NARRATIVE_ENGINEERING_PATH} 格式错误：${detail}`);
    this.name = "NarrativeEngineeringFormatError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("；");
}

export function parseNarrativeEngineering(
  content: string,
): NarrativeEngineering {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause) {
    throw new NarrativeEngineeringFormatError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
  ) {
    const legacy = legacyEngineeringSchema.safeParse(value);
    if (!legacy.success) {
      throw new NarrativeEngineeringFormatError(formatIssues(legacy.error));
    }
    return migrateLegacyEngineering(legacy.data);
  }
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === 2
  ) {
    const legacy = narrativeEngineeringV2Schema.safeParse(value);
    if (!legacy.success) {
      throw new NarrativeEngineeringFormatError(formatIssues(legacy.error));
    }
    return migrateV2Engineering(legacy.data);
  }
  const result = narrativeEngineeringSchema.safeParse(value);
  if (!result.success) {
    throw new NarrativeEngineeringFormatError(formatIssues(result.error));
  }
  return result.data;
}

export function serializeNarrativeEngineering(
  library: NarrativeEngineering,
): string {
  return `${JSON.stringify(narrativeEngineeringSchema.parse(library), null, 2)}\n`;
}
