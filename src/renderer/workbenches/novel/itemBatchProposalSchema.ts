import { z } from "zod";

import { itemFieldValueSchema } from "./itemLibrarySchema";

export const ITEM_BATCH_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const ITEM_BATCH_PROPOSALS_DIRECTORY = "world/items/proposals";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const itemBatchProposalCandidateStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
]);

export type ItemBatchProposalCandidateStatus = z.infer<
  typeof itemBatchProposalCandidateStatusSchema
>;

export const itemBatchProposalCandidateSchema = z
  .object({
    candidateId: idSchema,
    name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)),
    tags: z.array(z.string().trim().min(1)),
    summary: z.string().trim(),
    values: z.record(idSchema, itemFieldValueSchema),
    description: z.string(),
    status: itemBatchProposalCandidateStatusSchema,
  })
  .strict();

export type ItemBatchProposalCandidate = z.infer<
  typeof itemBatchProposalCandidateSchema
>;

export const itemBatchProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(ITEM_BATCH_PROPOSAL_SCHEMA_VERSION),
    proposalId: idSchema,
    title: z.string().trim().min(1),
    description: z.string().trim(),
    categoryId: idSchema,
    createdAt: z.string().datetime(),
    source: z
      .object({
        kind: z.literal("agent"),
        promptId: z.string().trim().min(1),
        promptVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      })
      .strict(),
    items: z.array(itemBatchProposalCandidateSchema).min(1).max(20),
  })
  .strict()
  .superRefine((proposal, context) => {
    const candidateIds = new Set<string>();
    const names = new Set<string>();
    proposal.items.forEach((item, index) => {
      if (candidateIds.has(item.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "candidateId"],
          message: "候选 id 不得重复",
        });
      }
      candidateIds.add(item.candidateId);
      const normalizedName = item.name.toLocaleLowerCase("zh-CN");
      if (names.has(normalizedName)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "name"],
          message: "候选名称不得重复",
        });
      }
      names.add(normalizedName);
    });
  });

export type ItemBatchProposalManifest = z.infer<
  typeof itemBatchProposalManifestSchema
>;

export function itemBatchProposalManifestPath(proposalId: string): string {
  return `${ITEM_BATCH_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function parseItemBatchProposalManifest(
  path: string,
  content: string,
): ItemBatchProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${path} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = itemBatchProposalManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${path} 格式错误：${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return result.data;
}

export function serializeItemBatchProposalManifest(
  manifest: ItemBatchProposalManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
