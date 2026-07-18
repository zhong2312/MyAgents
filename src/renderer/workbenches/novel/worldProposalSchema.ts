import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const WORLD_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const WORLD_PROPOSALS_DIRECTORY = "world/setting-library/proposals";
const SETTING_LIBRARY_DIRECTORY = "world/setting-library";
const SETTING_LIBRARY_PREFIX = `${SETTING_LIBRARY_DIRECTORY}/`;
const WORLD_PROPOSAL_TARGET_PATTERN =
  /^world\/setting-library\/(?:meta\.json|spatial-tree\.json|settings\.json|pages\/[a-z0-9-]+\/[a-z0-9-]+\.md|entries\/[a-z0-9-]+\/[a-z0-9-]+\.json)$/;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export function normalizeWorldProposalTargetPath(path: string): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  if (!WORLD_PROPOSAL_TARGET_PATTERN.test(normalized)) {
    throw new Error("提案只能修改设定库的元配置、空间树、索引、页面或词条文件");
  }
  return normalized;
}

export function worldProposalTargetPathFromSnapshotRelativePath(
  path: string,
): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  return normalizeWorldProposalTargetPath(
    normalized.startsWith(SETTING_LIBRARY_PREFIX)
      ? normalized
      : `${SETTING_LIBRARY_PREFIX}${normalized}`,
  );
}

function targetPathSchema() {
  return z.string().transform((path, context) => {
    try {
      return normalizeWorldProposalTargetPath(path);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

export const worldProposalChangeSchema = z
  .object({
    id: idSchema,
    targetPath: targetPathSchema(),
    operation: z.enum(["create", "modify"]),
    summary: z.string().trim().min(1),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export type WorldProposalChange = z.infer<typeof worldProposalChangeSchema>;

export const worldProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(WORLD_PROPOSAL_SCHEMA_VERSION),
    proposalId: idSchema,
    title: z.string().trim().min(1),
    description: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    source: z
      .object({
        kind: z.literal("agent"),
        promptId: z.string().trim().min(1),
        promptVersion: semverSchema,
      })
      .strict(),
    changes: z.array(worldProposalChangeSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    manifest.changes.forEach((change, index) => {
      if (ids.has(change.id)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "id"],
          message: "变更 id 不得重复",
        });
      }
      if (targets.has(change.targetPath)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "targetPath"],
          message: "同一提案不能重复修改同一个目标文件",
        });
      }
      ids.add(change.id);
      targets.add(change.targetPath);
    });
  });

export type WorldProposalManifest = z.infer<typeof worldProposalManifestSchema>;

export class WorldProposalFormatError extends Error {
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`世界架构提案格式错误（${path}）：${issues.join("；")}`);
    this.name = "WorldProposalFormatError";
  }
}

export function worldProposalManifestPath(proposalId: string): string {
  return `${WORLD_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function worldProposalSnapshotPath(
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): string {
  const normalized = normalizeWorldProposalTargetPath(targetPath);
  const relative = normalized.slice(SETTING_LIBRARY_PREFIX.length);
  return `${WORLD_PROPOSALS_DIRECTORY}/${proposalId}/${side}/${relative}`;
}

/** Compatibility path used by early Agent output that mirrored project-root paths. */
export function worldProposalLegacySnapshotPath(
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): string {
  return `${WORLD_PROPOSALS_DIRECTORY}/${proposalId}/${side}/${normalizeWorldProposalTargetPath(targetPath)}`;
}

export function parseWorldProposalManifest(
  content: string,
  path: string,
): WorldProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new WorldProposalFormatError(path, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const result = worldProposalManifestSchema.safeParse(value);
  if (!result.success) {
    throw new WorldProposalFormatError(
      path,
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"} ${issue.message}`,
      ),
    );
  }
  return result.data;
}

export function serializeWorldProposalManifest(
  manifest: WorldProposalManifest,
): string {
  return `${JSON.stringify(worldProposalManifestSchema.parse(manifest), null, 2)}\n`;
}

export function buildWorldProposalAgentInstructions(): string {
  return `## 受控写回协议（必须遵守）

本会话不得使用 Write、Edit、Bash、Task 或其他原始文件写入路径修改小说项目，也不得直接修改正式设定。

1. 使用 \`novel_world_get_context\` 读取当前世界架构；不要猜测现有层级、模板或路径。
2. 通过对话逐步确认作者选择。未获得作者明确确认前，不得提交提案。
3. 生成完整变更后，先调用 \`novel_world_validate_changes\`。新增任何页面或词条文件时，必须在同一提案的 \`settings.json\` 变更中登记对应的 \`pagePath\` 与 \`entriesPath\`；校验失败时修正变更并重新校验。
4. 仅在校验通过后调用 \`novel_world_submit_proposal\`。该工具只创建待审批快照，不修改正式设定。
5. 提交成功后说明变更数量，并请作者在小说工作台点击“审阅提案”逐项审批。

你没有应用提案的工具。只有作者在审批界面采纳变更后，小说工作台才能写入正式存储。`;
}
