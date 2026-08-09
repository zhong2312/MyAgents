import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

import { CULTIVATION_ECOLOGY_INDEX_PATH } from "../../../shared/workbenches/novel/cultivationEcologyStorage";

export const CULTIVATION_PROPOSALS_DIRECTORY = "world/cultivation-proposals";
export { CULTIVATION_ECOLOGY_INDEX_PATH };

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const TARGET_PATTERN =
  /^world\/cultivation\/(?:index\.json|origins\/records\/[a-z0-9-]+\.json|relations\/(?:index\.json|records\/[a-z0-9-]+\.json)|systems\/[a-z0-9-]+\/(?:system\.json|projection\.json|audit\.json|theory\/(?:index\.json|nodes\/[a-z0-9-]+\.json)|(?:progression|track-interactions|resources|methods|abilities|formations|foundations|transitions|constraints)\/(?:index\.json|records\/[a-z0-9-]+\.json)))$/u;

export function normalizeCultivationProposalTargetPath(path: string): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  if (!TARGET_PATTERN.test(normalized)) {
    throw new Error(`不是受支持的修行体系模块路径：${path}`);
  }
  return normalized;
}

function targetPathSchema() {
  return z.string().transform((path, context) => {
    try {
      return normalizeCultivationProposalTargetPath(path);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

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
            targetPath: targetPathSchema(),
            operation: z.enum(["create", "modify"]),
            summary: z.string().trim().min(1),
            status: z.enum(["pending", "applied", "rejected"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    manifest.changes.forEach((change, index) => {
      if (ids.has(change.id)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "id"],
          message: "变更 id 不得重复",
        });
      }
      if (paths.has(change.targetPath)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "targetPath"],
          message: "同一提案不能重复修改同一模块文件",
        });
      }
      ids.add(change.id);
      paths.add(change.targetPath);
    });
  });

export type CultivationProposalManifest = z.infer<
  typeof cultivationProposalManifestSchema
>;

export function cultivationProposalManifestPath(proposalId: string): string {
  return `${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function cultivationProposalSnapshotPath(
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): string {
  return `${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}/${side}/${normalizeCultivationProposalTargetPath(targetPath)}`;
}

export function serializeCultivationProposalManifest(
  manifest: CultivationProposalManifest,
): string {
  return `${JSON.stringify(cultivationProposalManifestSchema.parse(manifest), null, 2)}\n`;
}
