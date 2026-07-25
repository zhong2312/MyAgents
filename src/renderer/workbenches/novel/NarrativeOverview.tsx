import {
  BookOpenText,
  CheckCircle2,
  FileText,
  FolderTree,
  GitBranch,
  Link2,
  Route,
  SearchCheck,
} from "lucide-react";
import { useMemo } from "react";

import type { CharacterRecord } from "./characterLibrarySchema";
import type { NarrativeEngineering } from "./narrativeEngineeringSchema";
import type { LoadedNovelChapter } from "./repository";

interface NarrativeOverviewProps {
  readonly library: NarrativeEngineering;
  readonly manuscriptChapters: readonly LoadedNovelChapter[];
  readonly characters: readonly CharacterRecord[];
  readonly diagnostics: Readonly<{
    errors: number;
    warnings: number;
    infos: number;
  }>;
  readonly onOpenChapters: () => void;
  readonly onOpenLines: () => void;
  readonly onOpenArcs: () => void;
  readonly onOpenAudit: () => void;
}

function percentage(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

export default function NarrativeOverview({
  library,
  manuscriptChapters,
  characters,
  diagnostics,
  onOpenChapters,
  onOpenLines,
  onOpenArcs,
  onOpenAudit,
}: NarrativeOverviewProps) {
  const metrics = useMemo(() => {
    const sections = library.chapters.flatMap((chapter) => chapter.sections);
    const paragraphs = sections.flatMap((section) => section.paragraphs);
    const linkedManuscriptIds = new Set(
      library.chapters.flatMap((chapter) =>
        chapter.manuscriptChapterId ? [chapter.manuscriptChapterId] : [],
      ),
    );
    const linkedLineIds = new Set(
      library.chapters.flatMap((chapter) => [
        ...chapter.lineIds,
        ...chapter.sections.flatMap((section) => section.lineIds),
      ]),
    );
    const linkedArcIds = new Set(
      library.chapters.flatMap((chapter) => [
        ...chapter.arcIds,
        ...chapter.sections.flatMap((section) => section.arcIds),
      ]),
    );
    return {
      sections,
      paragraphs,
      linkedManuscriptIds,
      linkedLineIds,
      linkedArcIds,
    };
  }, [library.chapters]);
  const totalDiagnostics =
    diagnostics.errors + diagnostics.warnings + diagnostics.infos;
  const characterIds = new Set(characters.map((character) => character.id));
  const linkedCharacterArcs = library.arcs.filter(
    (arc) =>
      arc.kind === "character" &&
      arc.characterId &&
      characterIds.has(arc.characterId),
  ).length;
  const recentChapters = [...library.chapters]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 6);

  const cards = [
    {
      label: "目录结构",
      value: String(library.directories.length),
      detail: `${library.directories.filter((item) => item.kind === "volume").length} 卷 · ${library.directories.filter((item) => item.kind === "part").length} 篇 · ${library.directories.filter((item) => item.kind === "group").length} 组`,
      icon: FolderTree,
      onClick: onOpenChapters,
    },
    {
      label: "章节拆解",
      value: `${library.chapters.length} 章`,
      detail: `${metrics.sections.length} 节 · ${metrics.paragraphs.length} 段`,
      icon: BookOpenText,
      onClick: onOpenChapters,
    },
    {
      label: "正文关联",
      value: `${percentage(metrics.linkedManuscriptIds.size, manuscriptChapters.length)}%`,
      detail: `${metrics.linkedManuscriptIds.size}/${manuscriptChapters.length} 篇正文已关联`,
      icon: Link2,
      onClick: onOpenChapters,
    },
    {
      label: "叙事检查",
      value: String(totalDiagnostics),
      detail: diagnostics.errors
        ? `${diagnostics.errors} 个错误需要处理`
        : diagnostics.warnings
          ? `${diagnostics.warnings} 项规划提醒`
          : "当前没有待处理项",
      icon: totalDiagnostics ? SearchCheck : CheckCircle2,
      onClick: onOpenAudit,
    },
  ];

  return (
    <div className="ne-panel-scroll bg-[var(--paper)]">
      <div className="mx-auto max-w-6xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--ink)]">
              创作进度总览
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
              只汇总事实对象和待整理项，不用警告数量判断作品质量。
            </p>
          </div>
          {library.legacyArchive && (
            <span className="rounded-md bg-[var(--warning-bg)] px-2 py-1 text-xs text-[var(--warning)]">
              已保留 v1 只读归档
            </span>
          )}
        </div>

        <div className="mt-5 grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-md:grid-cols-1">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.label}
                type="button"
                className="rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-shadow hover:shadow-sm"
                onClick={card.onClick}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-[var(--ink-muted)]">
                    {card.label}
                  </span>
                  <Icon className="h-4 w-4 text-[var(--accent-warm)]" />
                </span>
                <span className="mt-3 block text-xl font-semibold text-[var(--ink)]">
                  {card.value}
                </span>
                <span className="mt-1 block text-xs text-[var(--ink-muted)]">
                  {card.detail}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-7 grid grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)] gap-6 max-lg:grid-cols-1">
          <section className="border-t border-[var(--line)] pt-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--ink)]">
                  最近规划的章节
                </h3>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  按章节规划的最后修改时间排序。
                </p>
              </div>
              <button
                type="button"
                className="ns-button"
                onClick={onOpenChapters}
              >
                <FileText className="h-3.5 w-3.5" />
                打开章节
              </button>
            </div>
            {recentChapters.length === 0 ? (
              <p className="mt-5 border-l-2 border-[var(--line-strong)] pl-4 text-sm text-[var(--ink-muted)]">
                尚未创建章节规划。
              </p>
            ) : (
              <div className="mt-4 divide-y divide-[var(--line-subtle)] border-y border-[var(--line)]">
                {recentChapters.map((chapter) => (
                  <button
                    key={chapter.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-[var(--hover-bg)]"
                    onClick={onOpenChapters}
                  >
                    <span className="w-12 shrink-0 text-xs font-semibold tabular-nums text-[var(--accent-warm)]">
                      {String(chapter.order + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
                      {chapter.title}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                      {chapter.sections.length} 节
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="border-t border-[var(--line)] pt-5">
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              线路与故事弧覆盖
            </h3>
            <div className="mt-4 space-y-3">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md bg-[var(--paper-elevated)] px-4 py-3 text-left hover:bg-[var(--hover-bg)]"
                onClick={onOpenLines}
              >
                <Route className="h-4 w-4 text-[var(--accent-warm)]" />
                <span className="min-w-0 flex-1 text-sm font-medium">
                  剧情线路
                </span>
                <span className="text-xs text-[var(--ink-muted)]">
                  {metrics.linkedLineIds.size}/{library.lines.length} 已入章
                </span>
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md bg-[var(--paper-elevated)] px-4 py-3 text-left hover:bg-[var(--hover-bg)]"
                onClick={onOpenArcs}
              >
                <GitBranch className="h-4 w-4 text-[var(--accent-cool)]" />
                <span className="min-w-0 flex-1 text-sm font-medium">
                  故事弧
                </span>
                <span className="text-xs text-[var(--ink-muted)]">
                  {metrics.linkedArcIds.size}/{library.arcs.length} 已入章
                </span>
              </button>
              <div className="px-1 text-xs leading-5 text-[var(--ink-muted)]">
                角色弧已关联人物库 {linkedCharacterArcs} 条；人物总弧光仍由人物库维护。
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
