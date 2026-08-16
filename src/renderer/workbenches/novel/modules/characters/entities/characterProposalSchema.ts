import { z } from "zod";

export const CHARACTER_PROPOSALS_DIRECTORY = "characters/proposals";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const characterProposalOperationSchema = z
  .object({
    candidateId: idSchema,
    kind: z.enum(["character", "race", "group", "soul"]),
    action: z.enum(["create", "update"]),
    targetId: idSchema.optional(),
    /** 更新候选生成时读取到的正式对象快照；缺失表示旧提案，审阅时必须显式核对。 */
    baseValue: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().trim().min(1),
    value: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export type CharacterProposalOperation = z.infer<
  typeof characterProposalOperationSchema
>;

export const characterProposalManifestSchema = z
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
    operations: z.array(characterProposalOperationSchema).min(1).max(40),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    manifest.operations.forEach((operation, index) => {
      if (ids.has(operation.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "candidateId"],
          message: "候选 id 不得重复",
        });
      }
      ids.add(operation.candidateId);
      if (operation.action === "update" && !operation.targetId) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "targetId"],
          message: "更新候选必须指定 targetId",
        });
      }
    });
  });

export type CharacterProposalManifest = z.infer<
  typeof characterProposalManifestSchema
>;

export class CharacterProposalFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "CharacterProposalFormatError";
  }
}

export function characterProposalManifestPath(proposalId: string): string {
  if (!idSchema.safeParse(proposalId).success) {
    throw new Error("角色提案 id 只能使用小写字母、数字和连字符");
  }
  return `${CHARACTER_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function parseCharacterProposalManifest(
  path: string,
  content: string,
): CharacterProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new CharacterProposalFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = characterProposalManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CharacterProposalFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeCharacterProposalManifest(
  manifest: CharacterProposalManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
