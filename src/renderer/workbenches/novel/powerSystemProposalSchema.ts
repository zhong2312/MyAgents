import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const POWER_SYSTEM_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const POWER_SYSTEM_PROPOSALS_DIRECTORY = "world/power-systems/proposals";
const POWER_SYSTEM_DIRECTORY = "world/power-systems";
const POWER_SYSTEM_PREFIX = `${POWER_SYSTEM_DIRECTORY}/`;
const POWER_SYSTEM_PROPOSAL_TARGET_PATTERN =
  /^world\/power-systems\/(?:meta\.json|index\.json|interactions\.json|records\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/u;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);

export function normalizePowerSystemProposalTargetPath(path: string): string {
  const normalized = normalizeWorkbenchStoragePath(path);
  if (!POWER_SYSTEM_PROPOSAL_TARGET_PATTERN.test(normalized)) {
    throw new Error("提案只能修改力量体系库文件");
  }
  return normalized;
}

function targetPathSchema() {
  return z.string().transform((path, context) => {
    try {
      return normalizePowerSystemProposalTargetPath(path);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

export const powerSystemProposalChangeSchema = z
  .object({
    id: idSchema,
    targetPath: targetPathSchema(),
    operation: z.enum(["create", "modify"]),
    summary: z.string().trim().min(1),
    status: z.enum(["pending", "applied", "rejected"]),
  })
  .strict();

export type PowerSystemProposalChange = z.infer<
  typeof powerSystemProposalChangeSchema
>;

export const powerSystemProposalManifestSchema = z
  .object({
    schemaVersion: z.literal(POWER_SYSTEM_PROPOSAL_SCHEMA_VERSION),
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
    changes: z.array(powerSystemProposalChangeSchema).min(1),
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
          message: "同一提案不能重复修改同一目标文件",
        });
      }
      ids.add(change.id);
      targets.add(change.targetPath);
    });
  });

export type PowerSystemProposalManifest = z.infer<
  typeof powerSystemProposalManifestSchema
>;

export class PowerSystemProposalFormatError extends Error {
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`力量体系提案格式错误（${path}）：${issues.join("；")}`);
    this.name = "PowerSystemProposalFormatError";
  }
}

export function powerSystemProposalManifestPath(proposalId: string): string {
  return `${POWER_SYSTEM_PROPOSALS_DIRECTORY}/${proposalId}/proposal.json`;
}

export function powerSystemProposalSnapshotPath(
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): string {
  const normalized = normalizePowerSystemProposalTargetPath(targetPath);
  return `${POWER_SYSTEM_PROPOSALS_DIRECTORY}/${proposalId}/${side}/${normalized.slice(POWER_SYSTEM_PREFIX.length)}`;
}

export function parsePowerSystemProposalManifest(
  content: string,
  path: string,
): PowerSystemProposalManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new PowerSystemProposalFormatError(path, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const result = powerSystemProposalManifestSchema.safeParse(value);
  if (!result.success) {
    throw new PowerSystemProposalFormatError(
      path,
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"} ${issue.message}`,
      ),
    );
  }
  return result.data;
}

export function serializePowerSystemProposalManifest(
  manifest: PowerSystemProposalManifest,
): string {
  return `${JSON.stringify(powerSystemProposalManifestSchema.parse(manifest), null, 2)}\n`;
}

export function buildPowerSystemProposalAgentInstructions(): string {
  return `## 受控写回协议（必须遵守）

本会话不得使用 Write、Edit、Bash、Task 或其他原始文件写入路径修改小说项目，也不得直接修改正式力量体系。

1. 首先调用 \`novel_power_get_context\` 读取力量体系类型、体系索引、跨体系交互和当前目标；不要猜测已有 id、结构或路径。
2. 通过简洁对话确认题材、叙事功能、显式程度、量化方式、成长结构、代价政策、比较方式和例外政策。抽象必须保持题材中立，不得把所有体系强行设计成修炼境界。
3. 生成完整文件变更后调用 \`novel_power_validate_changes\`。新增体系必须在同一提案中修改 \`index.json\`，并同时创建 \`records/<system-id>.json\` 与 \`pages/<system-id>.md\`；所有关系、状态、标尺、体系类型和跨体系引用必须闭合。
4. 仅在校验通过后调用 \`novel_power_submit_proposal\`。该工具只创建待审批快照，不修改正式力量体系。
5. 提交成功后说明变更数量，并请作者回到小说工作台的力量体系页面点击“审阅提案”逐项审批。

你没有应用提案的工具。只有作者在审批界面采纳变更后，小说工作台才能写入正式存储。`;
}
