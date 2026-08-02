/**
 * 圆桌会商（LLM 多轮）：由 MyAgents 模型场景驱动，不依赖 MiroFish 伴服。
 * 每个代表基于事实（目标/资源/约束）逐轮发言，最终轮投票。
 * 纯函数：prompt 构建与 JSON 解析可独立测试。
 */

export interface CouncilActorProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly goals: readonly string[];
  readonly resources: readonly string[];
  readonly constraints: readonly string[];
}

export interface CouncilStatement {
  readonly actorId: string;
  readonly message: string;
}

export interface CouncilVote {
  readonly actorId: string;
  readonly choice: string;
}

export interface CouncilRoundInput {
  readonly topic: string;
  readonly actors: readonly CouncilActorProfile[];
  readonly round: number;
  readonly maxRounds: number;
  readonly history: readonly CouncilStatement[];
  /** 最后一轮：输出立场总结与投票，不再生成新发言。 */
  readonly isFinal: boolean;
}

export interface CouncilRoundOutput {
  readonly statements: readonly CouncilStatement[];
  readonly votes: readonly CouncilVote[];
}

export type CouncilSessionStatus = "idle" | "running" | "completed" | "error";

export interface CouncilSession {
  readonly schemaVersion: 1;
  readonly topic: string;
  readonly actorIds: readonly string[];
  readonly maxRounds: number;
  readonly round: number;
  readonly history: readonly CouncilStatement[];
  readonly votes: readonly CouncilVote[];
  readonly status: CouncilSessionStatus;
  readonly updatedAt: string;
  readonly error: string | null;
}

export const COUNCIL_SCENE_ID = "simulation.council" as const;

export function buildCouncilSystemPrompt(): string {
  return [
    "你是长篇小说的圆桌会商主持人，组织多位角色与势力代表围绕一个议题发言。",
    "只依据提供的人物事实（目标/资源/约束/过往发言）和议题，不得虚构事实。",
    "每轮发言要体现各方立场差异、利益冲突与可能妥协，语言符合小说人物声口。",
    "只输出 JSON，不要解释，不要 Markdown 代码围栏。",
    "发言轮次：JSON {\"statements\":[{\"actorId\":\"稳定ID\",\"message\":\"发言内容\"}]}",
    "最终轮：JSON {\"votes\":[{\"actorId\":\"稳定ID\",\"choice\":\"支持/反对/弃权\"}]}",
  ].join("\n");
}

export function buildCouncilRoundPrompt(input: CouncilRoundInput): string {
  const actorLines = input.actors.map(
    (actor) =>
      `- ${actor.name}（${actor.kind === "faction" ? "势力" : "人物"}）` +
      (actor.goals.length ? `\n  目标：${actor.goals.join("；")}` : "") +
      (actor.resources.length ? `\n  资源：${actor.resources.join("；")}` : "") +
      (actor.constraints.length ? `\n  约束：${actor.constraints.join("；")}` : ""),
  );
  const historyLines = input.history.map(
    (statement) => {
      const name =
        input.actors.find((actor) => actor.id === statement.actorId)?.name ??
        statement.actorId;
      return `- ${name}：${statement.message}`;
    },
  );
  return [
    `议题：${input.topic}`,
    `参与代表：\n${actorLines.join("\n")}`,
    input.history.length
      ? `已往发言：\n${historyLines.join("\n")}`
      : "这是第一轮发言。",
    input.isFinal
      ? "这是最终轮：请每位代表给出简短立场总结，并投票（choice 只能是 支持/反对/弃权）。"
      : `第 ${input.round}/${input.maxRounds} 轮：请每位代表针对上一轮发言表态或提出新行动。`,
  ].join("\n\n");
}

export function parseCouncilOutput(output: string): CouncilRoundOutput {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/iu)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new Error("会商结果不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("会商结果结构无效");
  }
  const record = value as Record<string, unknown>;
  const statements = Array.isArray(record.statements)
    ? record.statements
        .filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && !Array.isArray(item),
        )
        .map((item) => ({
          actorId: typeof item.actorId === "string" ? item.actorId : "",
          message: typeof item.message === "string" ? item.message : "",
        }))
        .filter((item) => item.actorId && item.message)
    : [];
  const votes = Array.isArray(record.votes)
    ? record.votes
        .filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && !Array.isArray(item),
        )
        .map((item) => ({
          actorId: typeof item.actorId === "string" ? item.actorId : "",
          choice: typeof item.choice === "string" ? item.choice : "",
        }))
        .filter((item) => item.actorId && item.choice)
    : [];
  // 最终轮允许只输出投票（不强制要求发言）。
  if (!statements.length && !votes.length) {
    throw new Error("会商结果缺少发言或投票");
  }
  return Object.freeze({
    statements: Object.freeze(statements),
    votes: Object.freeze(votes),
  });
}
