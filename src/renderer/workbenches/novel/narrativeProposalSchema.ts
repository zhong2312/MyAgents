import { z } from "zod";

import {
  plotLineSchema,
  storyArcSchema,
} from "./narrativeEngineeringSchema";

export const NARRATIVE_PROPOSALS_DIRECTORY = "narrative/proposals";

const idSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/u);

const proposalCandidateSchema = z
  .object({
    candidateId: idSchema,
    summary: z.string().trim().min(1),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export const narrativeLineProposalCandidateSchema = proposalCandidateSchema
  .extend({ value: plotLineSchema })
  .strict();

export const narrativeArcProposalCandidateSchema = proposalCandidateSchema
  .extend({ value: storyArcSchema })
  .strict();

export const narrativeProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
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
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    [...manifest.lines, ...manifest.arcs].forEach((candidate, index) => {
      if (ids.has(candidate.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "candidateId"],
          message: "候选 id 不得重复",
        });
      }
      ids.add(candidate.candidateId);
    });
  });

export type NarrativeLineProposalCandidate = z.infer<
  typeof narrativeLineProposalCandidateSchema
>;
export type NarrativeArcProposalCandidate = z.infer<
  typeof narrativeArcProposalCandidateSchema
>;
export type NarrativeProposalManifest = z.infer<
  typeof narrativeProposalManifestSchema
>;

export class NarrativeProposalFormatError extends Error {
  constructor(readonly filePath: string, detail: string) {
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
