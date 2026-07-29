import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Info,
  ListChecks,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { CharacterRecord } from "./characterLibrarySchema";
import { planNarrativeDuplicateRepair } from "./narrativeDuplicateRepair";
import type { NarrativeEngineering } from "./narrativeEngineeringSchema";
import { orderedNarrativeChapters } from "./narrativePlanningModel";
import type { LoadedNovelChapter } from "./repository";

export type NarrativeWorkspaceView =
  | "overview"
  | "lines"
  | "arcs"
  | "outline"
  | "chapters"
  | "schedule"
  | "audit"
  | "proposals";
export type NarrativeAuditSeverity = "error" | "warning" | "info";

export interface NarrativeAuditFinding {
  readonly id: string;
  readonly severity: NarrativeAuditSeverity;
  readonly title: string;
  readonly detail: string;
  readonly view: NarrativeWorkspaceView;
  readonly entityId?: string;
}

function addFinding(
  findings: NarrativeAuditFinding[],
  finding: NarrativeAuditFinding,
): void {
  if (!findings.some((candidate) => candidate.id === finding.id)) {
    findings.push(finding);
  }
}

export function buildNarrativeAuditFindings(
  library: NarrativeEngineering,
  characters: readonly CharacterRecord[],
  manuscriptChapters: readonly LoadedNovelChapter[],
): readonly NarrativeAuditFinding[] {
  const findings: NarrativeAuditFinding[] = [];
  const directoryById = new Map(
    library.directories.map((directory) => [directory.id, directory]),
  );
  const lineIds = new Set(library.lines.map((line) => line.id));
  const arcIds = new Set(library.arcs.map((arc) => arc.id));
  const characterById = new Map(
    characters.map((character) => [character.id, character]),
  );
  const manuscriptIds = new Set(
    manuscriptChapters.map((chapter) => chapter.id),
  );
  const duplicatePlan = planNarrativeDuplicateRepair(library);

  duplicatePlan.lineIdMap.forEach((legacyId, duplicateId) => {
    const legacy = library.lines.find((line) => line.id === legacyId);
    if (!legacy) return;
    addFinding(findings, {
      id: `duplicate-ai-line-${duplicateId}`,
      severity: "error",
      title: `线路“${legacy.title}”存在 AI 审批产生的重复记录`,
      detail: "旧记录缺少关键节点，重复记录包含节点。可在本页使用“修复重复记录”保留旧 ID 并合并节点。",
      view: "lines",
      entityId: legacyId,
    });
  });
  duplicatePlan.arcIdMap.forEach((legacyId, duplicateId) => {
    const legacy = library.arcs.find((arc) => arc.id === legacyId);
    if (!legacy) return;
    addFinding(findings, {
      id: `duplicate-ai-arc-${duplicateId}`,
      severity: "error",
      title: `故事弧“${legacy.title}”存在 AI 审批产生的重复记录`,
      detail: "旧记录缺少关键节点，重复记录包含节点。可在本页使用“修复重复记录”保留旧 ID 并合并节点。",
      view: "arcs",
      entityId: legacyId,
    });
  });

  const auditKeyNodes = (
    view: "lines" | "arcs",
    owners: readonly (
      | (typeof library.lines)[number]
      | (typeof library.arcs)[number]
    )[],
  ) => {
    owners.forEach((owner) => {
      owner.keyNodes.forEach((node) => {
        if (node.locations.length > 0) return;
        addFinding(findings, {
          id: `key-node-unlocated-${node.id}`,
          severity: "info",
          title: `关键节点“${node.title}”尚未关联章节或节`,
          detail: `它仍保留在“${owner.title}”中；完成定位后会自动投影到故事编排。`,
          view,
          entityId: owner.id,
        });
      });
    });
  };
  auditKeyNodes("lines", library.lines);
  auditKeyNodes("arcs", library.arcs);

  library.directories.forEach((directory) => {
    const parent = directory.parentId
      ? directoryById.get(directory.parentId)
      : null;
    if (directory.parentId && !parent) {
      addFinding(findings, {
        id: `directory-parent-${directory.id}`,
        severity: "error",
        title: `目录“${directory.title}”的上级已失效`,
        detail: "请在大纲中重新整理目录关系。",
        view: "outline",
        entityId: directory.id,
      });
    }
    const parentIsValid =
      directory.kind === "volume"
        ? directory.parentId === null
        : directory.kind === "part"
          ? parent?.kind === "volume"
          : parent !== null;
    if (!parentIsValid && (!directory.parentId || parent)) {
      addFinding(findings, {
        id: `directory-level-${directory.id}`,
        severity: "error",
        title: `目录“${directory.title}”的层级不符合规则`,
        detail:
          directory.kind === "volume"
            ? "卷必须位于根层。"
            : directory.kind === "part"
              ? "篇必须位于卷下。"
              : "组必须位于卷、篇或其它组下。",
        view: "outline",
        entityId: directory.id,
      });
    }
    const visited = new Set([directory.id]);
    let cursor = directory.parentId;
    while (cursor) {
      if (visited.has(cursor)) {
        addFinding(findings, {
          id: `directory-cycle-${directory.id}`,
          severity: "error",
          title: `目录“${directory.title}”形成了循环`,
          detail: "目录循环会让章节路径无法确定，必须重新指定上级目录。",
          view: "outline",
          entityId: directory.id,
        });
        break;
      }
      visited.add(cursor);
      cursor = directoryById.get(cursor)?.parentId ?? null;
    }
  });

  const manuscriptLinks = new Map<string, string[]>();
  library.chapters.forEach((chapter) => {
    if (chapter.directoryId && !directoryById.has(chapter.directoryId)) {
      addFinding(findings, {
        id: `chapter-directory-${chapter.id}`,
        severity: "error",
        title: `章节“${chapter.title}”关联了失效目录`,
        detail: "请把章节移动到现有卷、篇、组，或暂时设为未归类。",
        view: "chapters",
        entityId: chapter.id,
      });
    }
    if (!chapter.directoryId) {
      addFinding(findings, {
        id: `chapter-unassigned-${chapter.id}`,
        severity: "info",
        title: `章节“${chapter.title}”尚未归类`,
        detail: "非线性写作允许暂时未归类；需要时再移动到卷、篇或组。",
        view: "chapters",
        entityId: chapter.id,
      });
    }
    if (chapter.manuscriptChapterId) {
      const linked = manuscriptLinks.get(chapter.manuscriptChapterId) ?? [];
      linked.push(chapter.title);
      manuscriptLinks.set(chapter.manuscriptChapterId, linked);
      if (!manuscriptIds.has(chapter.manuscriptChapterId)) {
        addFinding(findings, {
          id: `chapter-manuscript-missing-${chapter.id}`,
          severity: "warning",
          title: `章节“${chapter.title}”关联的正文已不存在`,
          detail: "剧情规划会保留，请重新选择正文或解除关联。",
          view: "chapters",
          entityId: chapter.id,
        });
      }
    }
    if (chapter.sections.length === 0) {
      addFinding(findings, {
        id: `chapter-sections-${chapter.id}`,
        severity: "warning",
        title: `章节“${chapter.title}”还没有节规划`,
        detail: "章节可以先保存为空；需要细化时至少添加一个节。",
        view: "chapters",
        entityId: chapter.id,
      });
    }
    chapter.lineIds.forEach((lineId) => {
      if (!lineIds.has(lineId)) {
        addFinding(findings, {
          id: `chapter-line-${chapter.id}-${lineId}`,
          severity: "error",
          title: `章节“${chapter.title}”存在失效线路引用`,
          detail: `线路 ID：${lineId}`,
          view: "chapters",
          entityId: chapter.id,
        });
      }
    });
    chapter.arcIds.forEach((arcId) => {
      if (!arcIds.has(arcId)) {
        addFinding(findings, {
          id: `chapter-arc-${chapter.id}-${arcId}`,
          severity: "error",
          title: `章节“${chapter.title}”存在失效故事弧引用`,
          detail: `故事弧 ID：${arcId}`,
          view: "chapters",
          entityId: chapter.id,
        });
      }
    });
    chapter.sections.forEach((section, sectionIndex) => {
      const label = `${String(sectionIndex + 1).padStart(2, "0")}节`;
      if (!section.description.trim()) {
        addFinding(findings, {
          id: `section-empty-${section.id}`,
          severity: "warning",
          title: `“${chapter.title}”的${label}缺少简述`,
          detail: "补一句本节的时空、行动或状态变化，后续编排会更易辨认。",
          view: "chapters",
          entityId: chapter.id,
        });
      }
      if (
        section.povCharacterId &&
        !characterById.has(section.povCharacterId)
      ) {
        addFinding(findings, {
          id: `section-character-${section.id}`,
          severity: "warning",
          title: `“${chapter.title}”的${label}视角人物已失效`,
          detail: "节规划会保留，请重新关联人物库角色。",
          view: "chapters",
          entityId: chapter.id,
        });
      }
      section.lineIds.forEach((lineId) => {
        if (!lineIds.has(lineId)) {
          addFinding(findings, {
            id: `section-line-${section.id}-${lineId}`,
            severity: "error",
            title: `“${chapter.title}”的${label}存在失效线路引用`,
            detail: `线路 ID：${lineId}`,
            view: "chapters",
            entityId: chapter.id,
          });
        }
      });
      section.arcIds.forEach((arcId) => {
        if (!arcIds.has(arcId)) {
          addFinding(findings, {
            id: `section-arc-${section.id}-${arcId}`,
            severity: "error",
            title: `“${chapter.title}”的${label}存在失效故事弧引用`,
            detail: `故事弧 ID：${arcId}`,
            view: "chapters",
            entityId: chapter.id,
          });
        }
      });
      section.paragraphs.forEach((paragraph, paragraphIndex) => {
        if (!paragraph.content.trim()) {
          addFinding(findings, {
            id: `paragraph-empty-${paragraph.id}`,
            severity: "info",
            title: `“${chapter.title}”的${label}第 ${paragraphIndex + 1} 段为空`,
            detail: "可以补充动作、话题或说话人变化，也可以删除这个空段。",
            view: "chapters",
            entityId: chapter.id,
          });
        }
      });
    });
  });

  manuscriptLinks.forEach((chapterTitles, manuscriptId) => {
    if (chapterTitles.length > 1) {
      addFinding(findings, {
        id: `manuscript-duplicate-${manuscriptId}`,
        severity: "error",
        title: "同一篇正文被多个章节规划关联",
        detail: chapterTitles.join("、"),
        view: "chapters",
        entityId: library.chapters.find(
          (chapter) => chapter.manuscriptChapterId === manuscriptId,
        )?.id,
      });
    }
  });

  library.lines.forEach((line) => {
    if (
      line.protagonistCharacterId &&
      !characterById.has(line.protagonistCharacterId)
    ) {
      addFinding(findings, {
        id: `line-character-${line.id}`,
        severity: "warning",
        title: `线路“${line.title}”的中心角色已失效`,
        detail: "线路仍会保留，请重新关联人物库角色。",
        view: "lines",
        entityId: line.id,
      });
    }
  });

  library.arcs.forEach((arc) => {
    const character = arc.characterId
      ? characterById.get(arc.characterId)
      : null;
    if (arc.characterId && !character) {
      addFinding(findings, {
        id: `arc-character-${arc.id}`,
        severity: "warning",
        title: `故事弧“${arc.title}”关联的人物已失效`,
        detail: "故事弧设计不会被删除，请重新关联人物库角色。",
        view: "arcs",
        entityId: arc.id,
      });
    }
    if (
      character &&
      arc.characterArcStageId &&
      !character.arcStages.some(
        (stage, index) =>
          (stage.id ?? `${character.id}-arc-stage-${index + 1}`) ===
          arc.characterArcStageId,
      )
    ) {
      addFinding(findings, {
        id: `arc-stage-${arc.id}`,
        severity: "warning",
        title: `故事弧“${arc.title}”关联的人物弧阶段已失效`,
        detail: `保留的阶段标题：${arc.characterArcStageTitle || "未命名"}`,
        view: "arcs",
        entityId: arc.id,
      });
    }
    arc.lineIds.forEach((lineId) => {
      if (!lineIds.has(lineId)) {
        addFinding(findings, {
          id: `arc-line-${arc.id}-${lineId}`,
          severity: "error",
          title: `故事弧“${arc.title}”存在失效线路引用`,
          detail: `线路 ID：${lineId}`,
          view: "arcs",
          entityId: arc.id,
        });
      }
    });
  });

  const chapters = orderedNarrativeChapters(library.chapters);
  const longGapThreshold = Math.max(3, Math.ceil(chapters.length * 0.15));
  library.lines.forEach((line) => {
    const linkedIndexes = chapters.flatMap((chapter, index) =>
      chapter.lineIds.includes(line.id) ||
      chapter.sections.some((section) => section.lineIds.includes(line.id))
        ? [index]
        : [],
    );
    if (linkedIndexes.length === 0) {
      addFinding(findings, {
        id: `line-unused-${line.id}`,
        severity: "warning",
        title: `线路“${line.title}”尚未进入任何章节`,
        detail: "可在章级或节级建立关联。",
        view: "lines",
        entityId: line.id,
      });
      return;
    }
    const longestGap = linkedIndexes.reduce(
      (longest, index, position) =>
        position === 0
          ? longest
          : Math.max(longest, index - linkedIndexes[position - 1] - 1),
      0,
    );
    if (longestGap >= longGapThreshold) {
      addFinding(findings, {
        id: `line-gap-${line.id}`,
        severity: "info",
        title: `线路“${line.title}”存在较长空档`,
        detail: `最长连续 ${longestGap} 章未出现；如果是刻意留白，可以忽略。`,
        view: "schedule",
        entityId: line.id,
      });
    }
  });

  return findings.sort((left, right) => {
    const rank: Record<NarrativeAuditSeverity, number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    return rank[left.severity] - rank[right.severity];
  });
}

const SEVERITY_META = {
  error: { label: "错误", icon: CircleAlert, color: "var(--error)" },
  warning: { label: "警告", icon: AlertTriangle, color: "var(--warning)" },
  info: { label: "提示", icon: Info, color: "var(--info)" },
} as const;

export default function NarrativeAudit({
  findings,
  onOpenFinding,
  onRepairDuplicates,
}: {
  readonly findings: readonly NarrativeAuditFinding[];
  readonly onOpenFinding: (finding: NarrativeAuditFinding) => void;
  readonly onRepairDuplicates?: () => void;
}) {
  const [filter, setFilter] = useState<NarrativeAuditSeverity | "all">("all");
  const visible = useMemo(
    () =>
      filter === "all"
        ? findings
        : findings.filter((finding) => finding.severity === filter),
    [filter, findings],
  );
  return (
    <div className="ne-panel-scroll h-full bg-[var(--paper)]">
      <div className="mx-auto max-w-5xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
          <div>
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-[var(--accent-warm)]" />
              <h2 className="text-base font-semibold">叙事检查</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
              检查引用闭合与规划缺口；所有提示均不阻止保存。
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onRepairDuplicates && (
              <button
                type="button"
                className="ns-button"
                onClick={onRepairDuplicates}
              >
                <Wrench className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                修复重复记录
              </button>
            )}
            <div className="flex items-center rounded-md bg-[var(--paper-inset)] p-0.5">
              {(["all", "error", "warning", "info"] as const).map((severity) => {
                const count =
                  severity === "all"
                    ? findings.length
                    : findings.filter((finding) => finding.severity === severity)
                        .length;
                const label =
                  severity === "all" ? "全部" : SEVERITY_META[severity].label;
                return (
                  <button
                    key={severity}
                    type="button"
                    className={`rounded px-2.5 py-1.5 text-xs font-medium ${filter === severity ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs" : "text-[var(--ink-muted)]"}`}
                    onClick={() => setFilter(severity)}
                  >
                    {label} {count}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="py-20 text-center">
            <CheckCircle2 className="mx-auto h-9 w-9 text-[var(--success)]" />
            <h3 className="mt-4 text-sm font-semibold">当前没有匹配的检查项</h3>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              可以继续规划或写作。
            </p>
          </div>
        ) : (
          <div className="mt-5 divide-y divide-[var(--line-subtle)] border-y border-[var(--line)]">
            {visible.map((finding) => {
              const meta = SEVERITY_META[finding.severity];
              const Icon = meta.icon;
              return (
                <button
                  key={finding.id}
                  type="button"
                  className="group flex w-full items-start gap-3 px-3 py-4 text-left hover:bg-[var(--hover-bg)]"
                  onClick={() => onOpenFinding(finding)}
                >
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: meta.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--ink)]">
                      {finding.title}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
                      {finding.detail}
                    </span>
                  </span>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-subtle)] group-hover:text-[var(--accent-warm)]" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
