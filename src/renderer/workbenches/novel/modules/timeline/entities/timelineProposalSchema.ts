import { z } from "zod";

export const TIMELINE_PROPOSALS_DIRECTORY = "timeline/proposals";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const timelineProposalOperationSchema = z
  .object({
    candidateId: idSchema,
    kind: z.literal("event"),
    action: z.enum(["create", "update"]),
    targetId: idSchema.optional(),
    summary: z.string().trim().min(1),
    baseValue: z.record(z.string(), z.unknown()).nullable().optional(),
    value: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export type TimelineProposalOperation = z.infer<
  typeof timelineProposalOperationSchema
>;

export const timelineProposalManifestSchema = z
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
    operations: z.array(timelineProposalOperationSchema).min(1).max(40),
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

export type TimelineProposalManifest = z.infer<
  typeof timelineProposalManifestSchema
>;

export class TimelineProposalFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "TimelineProposalFormatError";
  }
}

export function timelineProposalManifestPath(proposalId: string): string {
  if (!idSchema.safeParse(proposalId).success) {
    throw new Error("时间线提案 id 只能使用小写字母、数字和连字符");
  }
  return `${TIMELINE_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function parseTimelineProposalManifest(
  path: string,
  content: string,
): TimelineProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new TimelineProposalFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = timelineProposalManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TimelineProposalFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeTimelineProposalManifest(
  manifest: TimelineProposalManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
