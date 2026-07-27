import { z } from "zod";

export const CULTIVATION_PROPOSALS_DIRECTORY = "world/cultivation-proposals";
export const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const cultivationProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: idSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    source: z
      .object({
        kind: z.literal("agent"),
        promptId: z.string().trim().min(1),
        promptVersion: z.string().trim().min(1),
      })
      .strict(),
    changes: z
      .array(
        z
          .object({
            id: idSchema,
            targetPath: z.literal(CULTIVATION_ECOLOGY_PATH),
            operation: z.literal("modify"),
            summary: z.string().trim().min(1),
            status: z.enum(["pending", "applied", "rejected"]),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

export type CultivationProposalManifest = z.infer<
  typeof cultivationProposalManifestSchema
>;

export function cultivationProposalManifestPath(proposalId: string): string {
  return `${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function cultivationProposalSnapshotPath(
  proposalId: string,
  side: "before" | "after",
): string {
  return `${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}/${side}/cultivation-ecology.json`;
}

export function serializeCultivationProposalManifest(
  manifest: CultivationProposalManifest,
): string {
  return `${JSON.stringify(cultivationProposalManifestSchema.parse(manifest), null, 2)}\n`;
}

