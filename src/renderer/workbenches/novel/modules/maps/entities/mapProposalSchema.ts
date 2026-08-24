import { z } from "zod";

export const MAP_PROPOSALS_DIRECTORY = "world/maps/proposals";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const mapProposalOperationSchema = z
  .object({
    candidateId: idSchema,
    kind: z.literal("map"),
    action: z.enum(["create", "update"]),
    targetId: idSchema.optional(),
    summary: z.string().trim().min(1),
    value: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export type MapProposalOperation = z.infer<typeof mapProposalOperationSchema>;

export const mapProposalOperationReferenceSchema = mapProposalOperationSchema
  .omit({ value: true })
  .extend({
    valuePath: z.string().regex(/^candidates\/[a-z0-9][a-z0-9-]*\.json$/u),
  })
  .strict();

export type MapProposalOperationReference = z.infer<
  typeof mapProposalOperationReferenceSchema
>;

export const legacyMapProposalManifestSchema = z
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
        worldSourceHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        generatorAdapter: z.string().trim().min(1).max(120).optional(),
        runtime: z.enum(["azgaar-http", "compatibility-adapter"]).optional(),
        runtimeError: z.string().max(2_000).optional(),
        generationPlanVersion: z.number().int().positive().optional(),
      })
      .strict(),
    operations: z.array(mapProposalOperationSchema).min(1).max(40),
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

export type LegacyMapProposalManifest = z.infer<
  typeof legacyMapProposalManifestSchema
>;

export const mapProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    proposalId: idSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    createdAt: z.string().datetime(),
    source: z
      .object({
        kind: z.literal("agent"),
        promptId: z.string().trim().min(1),
        promptVersion: z.string().trim().min(1),
        worldSourceHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        generatorAdapter: z.string().trim().min(1).max(120).optional(),
        runtime: z.enum(["azgaar-http", "compatibility-adapter"]).optional(),
        runtimeError: z.string().max(2_000).optional(),
        generationPlanVersion: z.number().int().positive().optional(),
      })
      .strict(),
    operations: z.array(mapProposalOperationReferenceSchema).min(1).max(40),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    manifest.operations.forEach((operation, index) => {
      if (ids.has(operation.candidateId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "candidateId"],
          message: "候选 id 不得重复",
        });
      }
      ids.add(operation.candidateId);
      if (paths.has(operation.valuePath)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "valuePath"],
          message: "候选文件路径不得重复",
        });
      }
      paths.add(operation.valuePath);
      if (operation.action === "update" && !operation.targetId) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "targetId"],
          message: "更新候选必须指定 targetId",
        });
      }
    });
  });

export type MapProposalManifest = z.infer<typeof mapProposalManifestSchema>;

export class MapProposalFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "MapProposalFormatError";
  }
}

export function mapProposalManifestPath(proposalId: string): string {
  if (!idSchema.safeParse(proposalId).success) {
    throw new Error("地图提案 id 只能使用小写字母、数字和连字符");
  }
  return `${MAP_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function mapProposalCandidatePath(
  proposalId: string,
  candidateId: string,
): string {
  if (!idSchema.safeParse(candidateId).success) {
    throw new Error("地图候选 id 只能使用小写字母、数字和连字符");
  }
  return `${MAP_PROPOSALS_DIRECTORY}/${proposalId}/candidates/${candidateId}.json`;
}

export function parseMapProposalManifest(
  path: string,
  content: string,
): MapProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new MapProposalFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = mapProposalManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new MapProposalFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function parseLegacyMapProposalManifest(
  path: string,
  content: string,
): LegacyMapProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new MapProposalFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = legacyMapProposalManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new MapProposalFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeMapProposalManifest(
  manifest: MapProposalManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
