import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const WORLD_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const WORLD_PROPOSALS_DIRECTORY = "world/setting-library/proposals";
const SETTING_LIBRARY_DIRECTORY = "world/setting-library";
const SETTING_LIBRARY_PREFIX = `${SETTING_LIBRARY_DIRECTORY}/`;
export const WORLD_LOCATION_LIBRARY_PATH = "world/locations/index.json";
const WORLD_LOCATION_SNAPSHOT_PATH = "__locations/index.json";
const WORLD_PROPOSAL_TARGET_PATTERN =
  /^(?:world\/setting-library\/(?:meta\.json|spatial-tree\.json|settings\.json|pages\/[a-z0-9-]+\/[a-z0-9-]+\.md|entries\/[a-z0-9-]+\/[a-z0-9-]+\.json)|world\/locations\/index\.json)$/;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export function normalizeWorldProposalTargetPath(path: string): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  if (!WORLD_PROPOSAL_TARGET_PATTERN.test(normalized)) {
    throw new Error("提案只能修改设定库文件或地点索引");
  }
  return normalized;
}

export function worldProposalTargetPathFromSnapshotRelativePath(
  path: string,
): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  if (normalized === WORLD_LOCATION_SNAPSHOT_PATH) {
    return WORLD_LOCATION_LIBRARY_PATH;
  }
  if (normalized === WORLD_LOCATION_LIBRARY_PATH) return normalized;
  return normalizeWorldProposalTargetPath(
    normalized.startsWith(SETTING_LIBRARY_PREFIX)
      ? normalized
      : `${SETTING_LIBRARY_PREFIX}${normalized}`,
  );
}

export function worldProposalSnapshotRelativePath(targetPath: string): string {
  const normalized = normalizeWorldProposalTargetPath(targetPath);
  return normalized === WORLD_LOCATION_LIBRARY_PATH
    ? WORLD_LOCATION_SNAPSHOT_PATH
    : normalized.slice(SETTING_LIBRARY_PREFIX.length);
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
  const relative = worldProposalSnapshotRelativePath(targetPath);
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
3. 作者确认后先调用 \`novel_world_create_draft\`，再用 \`novel_world_upsert_draft_changes\` 分批写入候选。工具中断、会话恢复或校验失败时，先调用 \`novel_world_get_draft\`，不得重新生成另一份提案。新增任何页面或词条文件时，必须在同一草稿的 \`settings.json\` 变更中登记对应的 \`pagePath\` 与 \`entriesPath\`；新增或修改地点时，使用 \`world/locations/index.json\`，其 schemaVersion 固定为 1，且每条地点必须包含 id、nodeId、parentLocationId、name、aliases、type、status、summary、appearanceNote、description、order。地点名称允许重复；地点必须归属现有或同一草稿中的空间节点，上级地点只能在同一空间节点内且不得形成循环。
4. 完成后调用 \`novel_world_validate_draft\`。只使用这次返回的 \`validationToken\` 调用 \`novel_world_submit_draft\`；草稿变化后必须重新校验。该工具只创建待审批快照，不修改正式设定。
5. 最后调用 \`novel_world_get_proposal_status\`。仅当 \`exists=true\` 时说明提交成功，并请作者在小说工作台点击“审阅提案”逐项审批。

你没有应用提案的工具。只有作者在审批界面采纳变更后，小说工作台才能写入正式存储。`;
}
