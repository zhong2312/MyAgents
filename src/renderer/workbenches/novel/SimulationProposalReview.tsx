import {
  Check,
  ChevronRight,
  CircleAlert,
  GitBranch,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  LegacySimulationProposal,
  NarrativeEngineering,
  SimulationProposal,
  SimulationProposalStatus,
} from "./narrativeEngineeringSchema";

type ProposalFilter = "all" | SimulationProposalStatus;

function createStableId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.toLowerCase()}`;
}

function riskLabel(level: "low" | "medium" | "high"): string {
  if (level === "high") return "高风险";
  if (level === "low") return "低风险";
  return "中风险";
}

function isLegacyProposal(
  proposal: SimulationProposal,
): proposal is LegacySimulationProposal {
  return !("kind" in proposal);
}

function reviewProposal(
  library: NarrativeEngineering,
  proposal: LegacySimulationProposal,
  status: Extract<SimulationProposalStatus, "accepted" | "rejected">,
): NarrativeEngineering {
  const reviewedAt = new Date().toISOString();
  const simulationProposals = library.simulationProposals.map((item) =>
    item.id === proposal.id ? { ...item, status, reviewedAt } : item,
  );
  if (status === "rejected") return { ...library, simulationProposals };

  const source = proposal.sourceChapterPlanId
    ? library.chapters.find(
        (chapter) => chapter.id === proposal.sourceChapterPlanId,
      )
    : undefined;
  const siblings = library.chapters.filter(
    (chapter) => chapter.directoryId === (source?.directoryId ?? null),
  );
  const description = [proposal.premise, proposal.description]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n");
  return {
    ...library,
    simulationProposals,
    chapters: [
      ...library.chapters,
      {
        id: createStableId("chapter-plan"),
        directoryId: source?.directoryId ?? null,
        manuscriptChapterId: null,
        title: proposal.title,
        description,
        status: "idea",
        order:
          siblings.reduce(
            (highest, chapter) => Math.max(highest, chapter.order),
            -1,
          ) + 1,
        updatedAt: reviewedAt,
        lineIds: source?.lineIds ?? [],
        arcIds: source?.arcIds ?? [],
        sections: proposal.nodes.map((node, index) => ({
          id: createStableId("section-plan"),
          order: index,
          title: node.title,
          description: [
            node.summary,
            node.checkpoint ? `验收：${node.checkpoint}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          povCharacterId: null,
          lineIds: source?.lineIds ?? [],
          arcIds: source?.arcIds ?? [],
          paragraphs: [],
        })),
      },
    ],
  };
}

export default function SimulationProposalReview({
  library,
  onChange,
}: {
  readonly library: NarrativeEngineering;
  readonly onChange: (library: NarrativeEngineering) => void;
}) {
  const [filter, setFilter] = useState<ProposalFilter>("pending");
  const counts = useMemo(
    () => ({
      all: library.simulationProposals.filter(isLegacyProposal).length,
      pending: library.simulationProposals.filter(
        (item) => isLegacyProposal(item) && item.status === "pending",
      ).length,
      accepted: library.simulationProposals.filter(
        (item) => isLegacyProposal(item) && item.status === "accepted",
      ).length,
      rejected: library.simulationProposals.filter(
        (item) => isLegacyProposal(item) && item.status === "rejected",
      ).length,
    }),
    [library.simulationProposals],
  );
  const visible = useMemo(
    () =>
      library.simulationProposals
        .filter(isLegacyProposal)
        .filter((item) => filter === "all" || item.status === filter)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [filter, library.simulationProposals],
  );

  return (
    <div className="ne-panel-scroll h-full bg-[var(--paper)]">
      <div className="mx-auto max-w-5xl p-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-[var(--accent-cool)]" />
              <h2 className="text-base font-semibold">剧情提案</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
              审阅旧版剧情推演生成的候选，接受后生成可编辑章节计划。
            </p>
          </div>
          <div className="flex flex-wrap items-center rounded-md bg-[var(--paper-inset)] p-0.5">
            {(
              [
                ["pending", "待审"],
                ["all", "全部"],
                ["accepted", "已接受"],
                ["rejected", "已拒绝"],
              ] as const
            ).map(([status, label]) => (
              <button
                type="button"
                key={status}
                className={`rounded px-2.5 py-1.5 text-xs font-medium ${filter === status ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)]"}`}
                onClick={() => setFilter(status)}
              >
                {label} {counts[status]}
              </button>
            ))}
          </div>
        </header>

        {visible.length === 0 ? (
          <div className="py-20 text-center">
            <Sparkles className="mx-auto h-9 w-9 text-[var(--ink-subtle)]" />
            <h3 className="mt-4 text-sm font-semibold">没有匹配的剧情提案</h3>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              确认剧情候选后，记录会出现在这里。
            </p>
          </div>
        ) : (
          <div className="mt-5 grid gap-4">
            {visible.map((proposal) => (
              <article
                key={proposal.id}
                className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-elevated)]"
              >
                <header className="flex flex-wrap items-start gap-3 border-b border-[var(--line-subtle)] px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">
                        {proposal.title}
                      </h3>
                      <span
                        className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${
                          proposal.riskLevel === "high"
                            ? "bg-[var(--error-bg)] text-[var(--error)]"
                            : proposal.riskLevel === "medium"
                              ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                              : "bg-[var(--success-bg)] text-[var(--success)]"
                        }`}
                      >
                        {riskLabel(proposal.riskLevel)}
                      </span>
                      <span className="rounded-sm bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-subtle)]">
                        {proposal.status === "pending"
                          ? "待审阅"
                          : proposal.status === "accepted"
                            ? "已接受"
                            : "已拒绝"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                      {proposal.agentRole || "剧情推演 Agent"} ·{" "}
                      {new Date(proposal.createdAt).toLocaleString("zh-CN")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--ink-muted)]">
                    <span>连贯 {proposal.coherence}</span>
                    <span>新颖 {proposal.novelty}</span>
                    <span>风险 {proposal.risk}</span>
                  </div>
                </header>
                <div className="p-4">
                  {(proposal.premise || proposal.description) && (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-muted)]">
                      {proposal.premise || proposal.description}
                    </p>
                  )}
                  {proposal.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {proposal.tags.map((tag) => (
                        <span
                          className="rounded-sm bg-[var(--accent-cool-subtle)] px-1.5 py-0.5 text-xs text-[var(--accent-cool)]"
                          key={tag}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {proposal.nodes.length > 0 && (
                    <div className="mt-4 grid gap-2 border-l-2 border-[var(--accent-cool)] pl-3">
                      {proposal.nodes.map((node) => (
                        <div key={`${node.offset}-${node.title}`}>
                          <div className="flex flex-wrap items-baseline gap-2">
                            <b className="text-xs text-[var(--ink)]">
                              +{node.offset} 章 · {node.title}
                            </b>
                            {node.checkpoint && (
                              <span className="text-xs text-[var(--ink-subtle)]">
                                验收：{node.checkpoint}
                              </span>
                            )}
                          </div>
                          {node.summary && (
                            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
                              {node.summary}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {proposal.status === "pending" && (
                  <footer className="flex justify-end gap-2 border-t border-[var(--line-subtle)] px-4 py-2.5">
                    <button
                      type="button"
                      className="ns-button"
                      onClick={() =>
                        onChange(reviewProposal(library, proposal, "rejected"))
                      }
                    >
                      <X className="h-3.5 w-3.5" /> 拒绝
                    </button>
                    <button
                      type="button"
                      className="ns-button is-primary"
                      onClick={() =>
                        onChange(reviewProposal(library, proposal, "accepted"))
                      }
                    >
                      <Check className="h-3.5 w-3.5" /> 接受为章节计划
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </footer>
                )}
                {proposal.reviewedAt && (
                  <footer className="flex items-center gap-2 border-t border-[var(--line-subtle)] px-4 py-2 text-xs text-[var(--ink-subtle)]">
                    <CircleAlert className="h-3.5 w-3.5" />
                    {proposal.status === "accepted"
                      ? "已生成章节计划"
                      : "已保留拒绝记录"}{" "}
                    · {new Date(proposal.reviewedAt).toLocaleString("zh-CN")}
                  </footer>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
