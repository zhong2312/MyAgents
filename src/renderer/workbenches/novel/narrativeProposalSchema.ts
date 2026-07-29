import { z } from "zod";

import {
  narrativeChapterPlanSchema,
  narrativeDirectorySchema,
  plotLineSchema,
  storyArcSchema,
} from "./narrativeEngineeringSchema";

export const NARRATIVE_PROPOSALS_DIRECTORY = "narrative/proposals";
export const NARRATIVE_PROPOSAL_SCHEMA_VERSION = 4 as const;

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

const proposalCandidateSchema = z
  .object({
    candidateId: idSchema,
    summary: z.string().trim().min(1),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export const narrativeLineProposalCandidateSchema = proposalCandidateSchema
  .extend({
    value: plotLineSchema,
    baseValue: plotLineSchema.nullable().optional(),
  })
  .strict();

export const narrativeArcProposalCandidateSchema = proposalCandidateSchema
  .extend({
    value: storyArcSchema,
    baseValue: storyArcSchema.nullable().optional(),
  })
  .strict();

export const narrativeDirectoryProposalCandidateSchema = proposalCandidateSchema
  .extend({
    value: narrativeDirectorySchema,
    baseValue: narrativeDirectorySchema.nullable().optional(),
  })
  .strict();

export const narrativeChapterProposalCandidateSchema = proposalCandidateSchema
  .extend({
    value: narrativeChapterPlanSchema,
    baseValue: narrativeChapterPlanSchema.nullable().optional(),
  })
  .strict();

export const narrativeProposalManifestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(NARRATIVE_PROPOSAL_SCHEMA_VERSION),
    ]),
    proposalId: idSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    createdAt: z.string().datetime(),
    source: z
      .object({
        kind: z.literal("agent"),
        promptId: z.string().trim().min(1),
        promptVersion: z.string().trim().min(1),
      })
      .strict(),
    baseSourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    lines: z.array(narrativeLineProposalCandidateSchema),
    arcs: z.array(narrativeArcProposalCandidateSchema),
    directories: z.array(narrativeDirectoryProposalCandidateSchema).default([]),
    chapters: z.array(narrativeChapterProposalCandidateSchema).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const candidates = [
      ...manifest.lines,
      ...manifest.arcs,
      ...manifest.directories,
      ...manifest.chapters,
    ];
    candidates.forEach((candidate, index) => {
      if (ids.has(candidate.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "candidateId"],
          message: "候选 id 不得重复",
        });
      }
      ids.add(candidate.candidateId);
    });
    if (manifest.schemaVersion >= 2) {
      const versionedCandidates =
        manifest.schemaVersion === 2
          ? [...manifest.lines, ...manifest.arcs]
          : manifest.schemaVersion === 3
            ? [...manifest.lines, ...manifest.arcs, ...manifest.directories]
            : candidates;
      versionedCandidates.forEach((candidate, index) => {
        if (candidate.baseValue === undefined) {
          context.addIssue({
            code: "custom",
            path: ["candidates", index, "baseValue"],
            message: `v${manifest.schemaVersion} 剧情候选必须保存对象级基准；新增对象使用 null`,
          });
        }
      });
    }
  });

export type NarrativeLineProposalCandidate = z.infer<
  typeof narrativeLineProposalCandidateSchema
>;
export type NarrativeArcProposalCandidate = z.infer<
  typeof narrativeArcProposalCandidateSchema
>;
export type NarrativeDirectoryProposalCandidate = z.infer<
  typeof narrativeDirectoryProposalCandidateSchema
>;
export type NarrativeChapterProposalCandidate = z.infer<
  typeof narrativeChapterProposalCandidateSchema
>;
export type NarrativeProposalManifest = z.infer<
  typeof narrativeProposalManifestSchema
>;

export class NarrativeProposalFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "NarrativeProposalFormatError";
  }
}

export function narrativeProposalManifestPath(proposalId: string): string {
  if (!idSchema.safeParse(proposalId).success) {
    throw new Error("剧情提案 id 只能使用小写字母、数字和连字符");
  }
  return `${NARRATIVE_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function parseNarrativeProposalManifest(
  path: string,
  content: string,
): NarrativeProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new NarrativeProposalFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = narrativeProposalManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new NarrativeProposalFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeNarrativeProposalManifest(
  manifest: NarrativeProposalManifest,
): string {
  return `${JSON.stringify(narrativeProposalManifestSchema.parse(manifest), null, 2)}\n`;
}
