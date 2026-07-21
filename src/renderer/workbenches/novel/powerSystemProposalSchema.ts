import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const POWER_SYSTEM_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const POWER_SYSTEM_PROPOSALS_DIRECTORY = "world/power-systems/proposals";
const POWER_SYSTEM_DIRECTORY = "world/power-systems";
const POWER_SYSTEM_PREFIX = `${POWER_SYSTEM_DIRECTORY}/`;
const POWER_SYSTEM_PROPOSAL_TARGET_PATTERN =
  /^world\/power-systems\/(?:meta\.json|index\.json|catalog\.json|connections\.json|records\/[a-z0-9-]+\.json|pages\/[a-z0-9-]+\.md)$/u;

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

1. 首先调用 \`novel_power_get_context\`。如果是恢复此前会话，发现未提交草稿后调用 \`novel_power_get_draft\` 继续，不要重复创建。
2. 通过简洁对话确认叙事功能、核心机制、成长模型、代价、比较规则与例外边界。先向作者展示一份六项结构化设计摘要，并明确询问是否按此方案生成；作者明确确认前，只能讨论和读取，禁止创建草稿。
3. 作者确认后调用 \`novel_power_create_draft\`。不要手写 index.json、catalog.json、connections.json、record JSON 或 Markdown 文件，也不要调用旧的完整文件变更协议。
4. 使用 \`novel_power_update_draft_overview\`、\`novel_power_upsert_catalog\`、\`novel_power_upsert_progression\`、\`novel_power_upsert_connections\` 做小批量领域编辑。每次沿用工具返回的 draftId；失败时修正当前对象，不要从头生成整套文件。
5. 严格区分：状态定义已经获得的结果与契约；方法定义如何发展；理论解释方法为何有效；能力定义能够产生的效果。共享对象只在有叙事作用时创建，再通过连接应用到体系、状态或转换。
6. 质量表示同一状态下做得多好，边界表示最多能做到哪里。不得生成永久“总战力”。认知模型可以是顺序、图网络、模块算法、空间场、动态系统、演化规则、概率、身体或情绪控制，不得只适配修真。
7. 编辑完成后调用 \`novel_power_validate_draft\`。若失败，只按结构化错误的 path 和 suggestion 修复；任何编辑都会使旧 validationToken 失效，必须重新校验。
8. 校验成功后，将返回的 validationToken 原样传给 \`novel_power_submit_draft\`，只调用一次。它只创建待审批快照，不修改正式力量体系。
9. 提交工具返回 submitted=true 后，必须再调用 \`novel_power_get_proposal_status\`。只有状态查询返回 exists=true，才能告知作者提案提交成功；否则必须如实说明未能确认，严禁根据自己的推断宣称成功。
10. 成功后说明提案 id 和变更数量，请作者回到力量体系页面点击“审阅提案”逐项审批。

你没有应用提案的工具。只有作者在审批界面采纳变更后，小说工作台才能写入正式存储。`;
}
