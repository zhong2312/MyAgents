import {
  BookOpen,
  ChartGantt,
  ChevronDown,
  CircleHelp,
  Columns3,
  ExternalLink,
  FileText,
  GitBranch,
  ListTree,
  Route,
  Search,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";

import { DraggableDialogFrame, useCloseLayer } from "@/workbench-sdk";

import type { LoadedNovelChapter } from "./repository";
import type {
  NarrativeChapterPlan,
  NarrativeEngineering,
  NarrativeKeyNode,
  PlotLine,
  PlotLineStoryRole,
  StoryArc,
} from "./narrativeEngineeringSchema";
import { orderedNarrativeChapters } from "./narrativePlanningModel";

interface NarrativeGanttProps {
  readonly library: NarrativeEngineering;
  readonly chapters: readonly LoadedNovelChapter[];
  readonly onSelect: (
    target:
      | { readonly kind: "line"; readonly id: string }
      | { readonly kind: "arc"; readonly id: string }
      | { readonly kind: "chapter"; readonly id: string },
  ) => void;
}

interface GanttChapter {
  readonly id: string;
  readonly nodeId: string;
  readonly title: string;
  readonly planned: boolean;
  readonly plan: NarrativeChapterPlan;
}

interface GanttTrack {
  readonly id: string;
  readonly kind: "line" | "arc";
  readonly title: string;
  readonly meta: string;
  readonly color: string;
  readonly linkedIndexes: readonly number[];
  readonly linkedIndexSet: ReadonlySet<number>;
  readonly linkedCount: number;
  readonly hasGap: boolean;
  readonly keyNodesByIndex: ReadonlyMap<number, readonly TrackKeyNodeDetail[]>;
}

interface GanttBucket {
  readonly index: number;
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly chapters: readonly GanttChapter[];
  readonly hasPlannedChapter: boolean;
}

interface BucketTrackState {
  readonly linkedIndexes: readonly number[];
  readonly linkedCount: number;
  readonly density: number;
  readonly hasInternalGap: boolean;
  readonly keyNodeCount: number;
}

interface GanttViewportState {
  readonly start: number;
  readonly end: number;
  readonly granularity: number;
  readonly chapterCount: number;
  readonly customized: boolean;
}

interface SelectedBar {
  readonly trackId: string;
  readonly trackKind: "line" | "arc";
  readonly startOrdinal: number;
  readonly endOrdinal: number;
}

interface TrackSectionDetail {
  readonly id: string;
  readonly number: number;
  readonly title: string;
}

interface TrackChapterDetail {
  readonly id: string;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly directChapterLink: boolean;
  readonly sections: readonly TrackSectionDetail[];
  readonly keyNodes: readonly TrackKeyNodeDetail[];
}

interface TrackKeyNodeDetail {
  readonly id: string;
  readonly locationId: string;
  readonly title: string;
  readonly content: string;
  readonly sectionId: string | null;
  readonly sectionNumber: number | null;
  readonly sectionTitle: string;
}

interface TrackMatchContext {
  readonly kind: "line" | "arc";
  readonly id: string;
}

type StoryRoleFilter = "all" | "a" | "b" | "none";

const TARGET_COLUMN_COUNT = 10;
const MIN_GRANULARITY = 1;
const MAX_GRANULARITY = 1_000;
const TRACK_LABEL_WIDTH = 220;
const MIN_BUCKET_WIDTH = 92;
const VIRTUAL_OVERSCAN = 3;

const STORY_ROLE_SHORT_LABELS: Readonly<Record<PlotLineStoryRole, string>> = {
  a: "A Story",
  b: "B Story",
  both: "A/B Story",
  none: "未标记",
};

const ARC_COLORS: Readonly<Record<StoryArc["kind"], string>> = {
  plot: "#397c72",
  character: "#6b5aa7",
  relationship: "#bc7740",
  mystery: "#4f6f9e",
  theme: "#8b5d7b",
  custom: "#6b7478",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function suggestedGranularity(chapterCount: number): number {
  if (chapterCount <= 0) return MIN_GRANULARITY;
  return clamp(
    Math.ceil(chapterCount / TARGET_COLUMN_COUNT),
    MIN_GRANULARITY,
    MAX_GRANULARITY,
  );
}

function defaultViewport(chapterCount: number): GanttViewportState {
  return {
    start: 1,
    end: Math.max(chapterCount, 1),
    granularity: suggestedGranularity(chapterCount),
    chapterCount,
    customized: false,
  };
}

function resolveViewport(
  viewport: GanttViewportState,
  chapterCount: number,
): GanttViewportState {
  if (viewport.chapterCount === chapterCount) return viewport;
  if (
    chapterCount === 0 ||
    viewport.chapterCount === 0 ||
    !viewport.customized
  ) {
    return defaultViewport(chapterCount);
  }
  const nextStart = clamp(viewport.start, 1, chapterCount);
  return {
    ...viewport,
    start: nextStart,
    end:
      viewport.end === viewport.chapterCount
        ? chapterCount
        : clamp(viewport.end, nextStart, chapterCount),
    chapterCount,
  };
}

function contiguousSegments(indexes: readonly number[]) {
  const ordered = [...new Set(indexes)].sort((left, right) => left - right);
  const segments: { start: number; length: number }[] = [];
  ordered.forEach((index) => {
    const previous = segments[segments.length - 1];
    if (previous && previous.start + previous.length === index) {
      previous.length += 1;
    } else {
      segments.push({ start: index, length: 1 });
    }
  });
  return segments;
}

function chapterSequence(
  library: NarrativeEngineering,
  chapters: readonly LoadedNovelChapter[],
): readonly GanttChapter[] {
  const manuscriptById = new Map(
    chapters.map((chapter) => [chapter.id, chapter]),
  );
  return orderedNarrativeChapters(library.chapters).map((plan) => {
    const manuscript = plan.manuscriptChapterId
      ? manuscriptById.get(plan.manuscriptChapterId)
      : undefined;
    return {
      id: plan.id,
      nodeId: plan.id,
      title: plan.title,
      planned: !manuscript,
      plan,
    } satisfies GanttChapter;
  });
}

function buildMatchContext(
  kind: "line" | "arc",
  id: string,
): TrackMatchContext {
  return { kind, id };
}

function chapterMatchesTrack(
  chapter: NarrativeChapterPlan,
  context: TrackMatchContext,
): boolean {
  if (
    context.kind === "line"
      ? chapter.lineIds.includes(context.id)
      : chapter.arcIds.includes(context.id)
  ) {
    return true;
  }
  return chapter.sections.some((section) =>
    context.kind === "line"
      ? section.lineIds.includes(context.id)
      : section.arcIds.includes(context.id),
  );
}

function nodeIndexesForTrack(
  context: TrackMatchContext,
  chapters: readonly GanttChapter[],
): readonly number[] {
  return chapters.flatMap((chapter, index) =>
    chapterMatchesTrack(chapter.plan, context) ? [index] : [],
  );
}

function keyNodesByChapterIndex(
  keyNodes: readonly NarrativeKeyNode[],
  chapters: readonly GanttChapter[],
): ReadonlyMap<number, readonly TrackKeyNodeDetail[]> {
  const chapterIndexById = new Map(
    chapters.map((chapter, index) => [chapter.id, index]),
  );
  const result = new Map<number, TrackKeyNodeDetail[]>();
  keyNodes.forEach((node) => {
    node.locations.forEach((location) => {
      const chapterIndex = chapterIndexById.get(location.chapterId);
      if (chapterIndex === undefined) return;
      const chapter = chapters[chapterIndex];
      const sections = [...chapter.plan.sections].sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : left.id.localeCompare(right.id),
      );
      const sectionIndex = location.sectionId
        ? sections.findIndex((section) => section.id === location.sectionId)
        : -1;
      const values = result.get(chapterIndex) ?? [];
      values.push({
        id: node.id,
        locationId: location.id,
        title: node.title,
        content: node.content,
        sectionId: location.sectionId,
        sectionNumber: sectionIndex >= 0 ? sectionIndex + 1 : null,
        sectionTitle:
          sectionIndex >= 0
            ? sections[sectionIndex].title ||
              sections[sectionIndex].description ||
              "未填写简述"
            : "整章",
      });
      result.set(chapterIndex, values);
    });
  });
  result.forEach((values) =>
    values.sort((left, right) =>
      left.title === right.title
        ? left.locationId.localeCompare(right.locationId)
        : left.title.localeCompare(right.title, "zh-CN"),
    ),
  );
  return result;
}

function buildTracks(
  library: NarrativeEngineering,
  chapters: readonly GanttChapter[],
  showLines: boolean,
  showArcs: boolean,
  storyRoleFilter: StoryRoleFilter,
): readonly GanttTrack[] {
  const tracks: GanttTrack[] = [];
  const visibleLines = library.lines.filter((line) =>
    storyRoleFilter === "all"
      ? true
      : storyRoleFilter === "a"
        ? line.storyRole === "a" || line.storyRole === "both"
        : storyRoleFilter === "b"
          ? line.storyRole === "b" || line.storyRole === "both"
          : line.storyRole === "none",
  );
  const visibleLineIds = new Set(visibleLines.map((line) => line.id));
  if (showLines) {
    visibleLines.forEach((line: PlotLine) => {
      const manualIndexes = nodeIndexesForTrack(
        buildMatchContext("line", line.id),
        chapters,
      );
      const keyNodesByIndex = keyNodesByChapterIndex(line.keyNodes, chapters);
      const linkedIndexes = [
        ...new Set([...manualIndexes, ...keyNodesByIndex.keys()]),
      ].sort((left, right) => left - right);
      const segments = contiguousSegments(linkedIndexes);
      tracks.push({
        id: line.id,
        kind: "line",
        title: line.title,
        meta: `${line.kind === "main" ? "主线" : "支线"} · ${STORY_ROLE_SHORT_LABELS[line.storyRole]}`,
        color: line.color,
        linkedIndexes,
        linkedIndexSet: new Set(linkedIndexes),
        linkedCount: linkedIndexes.length,
        hasGap: segments.length > 1 || linkedIndexes.length === 0,
        keyNodesByIndex,
      });
    });
  }
  if (showArcs) {
    library.arcs
      .filter(
        (arc) =>
          storyRoleFilter === "all" ||
          arc.lineIds.some((lineId) => visibleLineIds.has(lineId)),
      )
      .forEach((arc: StoryArc) => {
        const manualIndexes = nodeIndexesForTrack(
          buildMatchContext("arc", arc.id),
          chapters,
        );
        const keyNodesByIndex = keyNodesByChapterIndex(arc.keyNodes, chapters);
        const linkedIndexes = [
          ...new Set([...manualIndexes, ...keyNodesByIndex.keys()]),
        ].sort((left, right) => left - right);
        const segments = contiguousSegments(linkedIndexes);
        tracks.push({
          id: arc.id,
          kind: "arc",
          title: arc.title,
          meta: arc.kind === "character" ? "角色弧" : "故事弧",
          color: ARC_COLORS[arc.kind],
          linkedIndexes,
          linkedIndexSet: new Set(linkedIndexes),
          linkedCount: linkedIndexes.length,
          hasGap: segments.length > 1 || linkedIndexes.length === 0,
          keyNodesByIndex,
        });
      });
  }
  return tracks;
}

function buildBuckets(
  chapters: readonly GanttChapter[],
  startOrdinal: number,
  endOrdinal: number,
  granularity: number,
): readonly GanttBucket[] {
  if (chapters.length === 0) return [];
  const safeStart = clamp(startOrdinal, 1, chapters.length);
  const safeEnd = clamp(endOrdinal, safeStart, chapters.length);
  const safeGranularity = clamp(granularity, MIN_GRANULARITY, MAX_GRANULARITY);
  const buckets: GanttBucket[] = [];
  for (
    let bucketStart = safeStart;
    bucketStart <= safeEnd;
    bucketStart += safeGranularity
  ) {
    const bucketEnd = Math.min(safeEnd, bucketStart + safeGranularity - 1);
    const bucketChapters = chapters.slice(bucketStart - 1, bucketEnd);
    buckets.push({
      index: buckets.length,
      startOrdinal: bucketStart,
      endOrdinal: bucketEnd,
      chapters: bucketChapters,
      hasPlannedChapter: bucketChapters.some((chapter) => chapter.planned),
    });
  }
  return buckets;
}

function buildBucketTrackState(
  track: GanttTrack,
  bucket: GanttBucket,
): BucketTrackState {
  const linkedIndexes: number[] = [];
  for (
    let chapterIndex = bucket.startOrdinal - 1;
    chapterIndex < bucket.endOrdinal;
    chapterIndex += 1
  ) {
    if (track.linkedIndexSet.has(chapterIndex))
      linkedIndexes.push(chapterIndex);
  }
  let hasInternalGap = false;
  for (let index = 1; index < linkedIndexes.length; index += 1) {
    if (linkedIndexes[index] !== linkedIndexes[index - 1] + 1) {
      hasInternalGap = true;
      break;
    }
  }
  const keyNodeCount = linkedIndexes.reduce(
    (count, chapterIndex) =>
      count + (track.keyNodesByIndex.get(chapterIndex)?.length ?? 0),
    0,
  );
  return {
    linkedIndexes,
    linkedCount: linkedIndexes.length,
    density:
      bucket.chapters.length === 0
        ? 0
        : linkedIndexes.length / bucket.chapters.length,
    hasInternalGap,
    keyNodeCount,
  };
}

function bucketLabel(bucket: GanttBucket): string {
  return bucket.startOrdinal === bucket.endOrdinal
    ? String(bucket.startOrdinal)
    : `${bucket.startOrdinal}-${bucket.endOrdinal}`;
}

function buildTrackChapterDetails(
  track: GanttTrack,
  chapters: readonly GanttChapter[],
  startOrdinal: number,
  endOrdinal: number,
): readonly TrackChapterDetail[] {
  const context = buildMatchContext(track.kind, track.id);
  return track.linkedIndexes
    .filter(
      (chapterIndex) =>
        chapterIndex + 1 >= startOrdinal && chapterIndex + 1 <= endOrdinal,
    )
    .map((chapterIndex) => {
      const chapter = chapters[chapterIndex];
      const allSections = [...chapter.plan.sections].sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : left.id.localeCompare(right.id),
      );
      const sectionNumberById = new Map(
        allSections.map((section, index) => [section.id, index + 1]),
      );
      const directChapterLink =
        context.kind === "line"
          ? chapter.plan.lineIds.includes(context.id)
          : chapter.plan.arcIds.includes(context.id);
      return {
        id: chapter.id,
        nodeId: chapter.nodeId,
        ordinal: chapterIndex + 1,
        title: chapter.title,
        directChapterLink,
        sections: allSections
          .filter((section) =>
            context.kind === "line"
              ? section.lineIds.includes(context.id)
              : section.arcIds.includes(context.id),
          )
          .sort((left, right) =>
            left.order !== right.order
              ? left.order - right.order
              : left.id.localeCompare(right.id),
          )
          .map((section) => ({
            id: section.id,
            number: sectionNumberById.get(section.id) ?? 1,
            title: section.title || section.description || "未填写简述",
          })),
        keyNodes: track.keyNodesByIndex.get(chapterIndex) ?? [],
      } satisfies TrackChapterDetail;
    });
}

function TrackLabel({
  track,
  onClick,
}: {
  readonly track: GanttTrack;
  readonly onClick: () => void;
}) {
  const Icon: LucideIcon = track.kind === "line" ? Route : GitBranch;
  return (
    <button
      type="button"
      className="ne-gantt-label group flex min-w-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3 text-left hover:bg-[var(--hover-bg)]"
      onClick={onClick}
      title={`打开${track.meta}“${track.title}”`}
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--paper-inset)]"
        style={{ color: track.color }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--ink)]">
          {track.title}
        </span>
        <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
          {track.meta} · {track.linkedCount} 章
        </span>
      </span>
    </button>
  );
}

function TrackChapterRow({
  detail,
  expanded,
  onToggle,
  onOpenChapter,
}: {
  readonly detail: TrackChapterDetail;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenChapter: () => void;
}) {
  const sectionCount = detail.sections.length;
  const keyNodeCount = detail.keyNodes.length;
  return (
    <div className="border-b border-[var(--line-subtle)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded px-2 py-2 text-left hover:bg-[var(--hover-bg)]"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[var(--ink-muted)] transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
          />
          <span className="w-24 shrink-0 whitespace-nowrap text-xs font-semibold tabular-nums text-[var(--accent-warm)]">
            第 {detail.ordinal} 章
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
            {detail.title}
          </span>
          {detail.directChapterLink && (
            <span className="shrink-0 rounded bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-muted)]">
              章级
            </span>
          )}
          {sectionCount > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-[var(--accent-cool)]">
              {sectionCount} 节
            </span>
          )}
          {keyNodeCount > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-[var(--accent-warm)]">
              ◆ {keyNodeCount}
            </span>
          )}
        </button>
        {detail.nodeId && (
          <button
            type="button"
            className="ns-icon-button h-8 w-8 shrink-0 border-0"
            title="打开章节"
            aria-label={`打开第 ${detail.ordinal} 章“${detail.title}”`}
            onClick={onOpenChapter}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-11 border-l border-[var(--line-strong)] py-2 pl-4">
          {detail.directChapterLink && (
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
              <BookOpen className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
              本章直接关联
            </div>
          )}
          {detail.sections.length > 0 ? (
            <div className="space-y-1.5">
              {detail.sections.map((section) => (
                <div
                  key={section.id}
                  className="flex min-w-0 items-start gap-2 text-sm"
                >
                  <span className="shrink-0 font-mono text-xs leading-5 text-[var(--accent-cool)]">
                    {String(section.number).padStart(2, "0")}节
                  </span>
                  <span className="min-w-0 break-words text-[var(--ink)]">
                    {section.title}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            !detail.directChapterLink &&
            keyNodeCount === 0 && (
              <p className="text-xs text-[var(--ink-muted)]">暂无节级关联</p>
            )
          )}
          {keyNodeCount > 0 && (
            <div className="mt-3 border-t border-[var(--line-subtle)] pt-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--accent-warm)]">
                <span>◆</span>
                关键节点
              </div>
              <div className="space-y-2">
                {detail.keyNodes.map((node) => (
                  <div
                    key={node.locationId}
                    className="rounded-sm bg-[var(--paper-inset)] px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ink)]">
                        {node.title}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                        {node.sectionNumber
                          ? `${String(node.sectionNumber).padStart(2, "0")}节`
                          : "整章"}
                      </span>
                    </div>
                    {node.content.trim() && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--ink-muted)]">
                        {node.content}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrackChapterDialog({
  track,
  details,
  startOrdinal,
  endOrdinal,
  onClose,
  onOpenChapter,
  onOpenTrack,
}: {
  readonly track: GanttTrack;
  readonly details: readonly TrackChapterDetail[];
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly onClose: () => void;
  readonly onOpenChapter: (nodeId: string) => void;
  readonly onOpenTrack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useCloseLayer(() => {
    onCloseRef.current();
    return true;
  }, 260);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    searchRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredDetails = useMemo(
    () =>
      normalizedQuery
        ? details.filter(
            (detail) =>
              String(detail.ordinal).includes(normalizedQuery) ||
              detail.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
          )
        : details,
    [details, normalizedQuery],
  );

  return (
    <DraggableDialogFrame
      ariaLabel={`${track.title}的关联章节`}
      className="h-[min(42rem,calc(100vh-3rem))] w-[min(48rem,calc(100vw-2rem))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-14 items-center gap-3 px-4">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[var(--paper-inset)]"
            style={{ color: track.color }}
          >
            <ListTree className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-[var(--ink)]">
              {track.title} · 关联章节
            </h2>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              第 {startOrdinal}-{endOrdinal} 章 · {details.length} 个关联章节
            </p>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            title="打开线路或故事弧"
            aria-label="打开线路或故事弧"
            onClick={onOpenTrack}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="ns-icon-button border-0"
            title="关闭"
            aria-label="关闭关联章节"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="shrink-0 border-b border-[var(--line-subtle)] px-4 py-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-subtle)]" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按章节序号或标题搜索"
            aria-label="搜索关联章节"
            className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] py-2 pl-9 pr-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1">
        {filteredDetails.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--ink-muted)]">
            当前搜索没有匹配的关联章节
          </div>
        ) : (
          <Virtuoso
            data={filteredDetails}
            style={{ height: "100%" }}
            increaseViewportBy={240}
            computeItemKey={(_index, detail) => detail.id}
            itemContent={(_index, detail) => (
              <TrackChapterRow
                detail={detail}
                expanded={detail.id === expandedId}
                onToggle={() =>
                  setExpandedId((current) =>
                    current === detail.id ? null : detail.id,
                  )
                }
                onOpenChapter={() => {
                  if (detail.nodeId) onOpenChapter(detail.nodeId);
                }}
              />
            )}
          />
        )}
      </div>
    </DraggableDialogFrame>
  );
}

export default function NarrativeGantt({
  library,
  chapters,
  onSelect,
}: NarrativeGanttProps) {
  const [showLines, setShowLines] = useState(true);
  const [showArcs, setShowArcs] = useState(true);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [storyRoleFilter, setStoryRoleFilter] =
    useState<StoryRoleFilter>("all");
  const chapterColumns = useMemo(
    () => chapterSequence(library, chapters),
    [chapters, library],
  );
  const [viewport, setViewport] = useState<GanttViewportState>(() =>
    defaultViewport(chapterColumns.length),
  );
  const [selectedBar, setSelectedBar] = useState<SelectedBar | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState({ left: 0, width: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const chapterCount = chapterColumns.length;
  const resolvedViewport = resolveViewport(viewport, chapterCount);
  const rangeStart =
    chapterCount === 0 ? 1 : clamp(resolvedViewport.start, 1, chapterCount);
  const rangeEnd =
    chapterCount === 0
      ? 1
      : clamp(resolvedViewport.end, rangeStart, chapterCount);
  const granularity = clamp(
    resolvedViewport.granularity,
    MIN_GRANULARITY,
    MAX_GRANULARITY,
  );

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const updateMetrics = () => {
      setScrollMetrics({
        left: scrollElement.scrollLeft,
        width: scrollElement.clientWidth,
      });
    };
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(scrollElement);
    updateMetrics();
    return () => observer.disconnect();
  }, [chapterCount]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollLeft = 0;
  }, [granularity, rangeStart]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  const handleTimelineScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      setScrollMetrics({
        left: scrollElement.scrollLeft,
        width: scrollElement.clientWidth,
      });
    });
  }, []);

  const tracks = useMemo(
    () =>
      buildTracks(
        library,
        chapterColumns,
        showLines,
        showArcs,
        storyRoleFilter,
      ).filter((track) => !onlyGaps || track.hasGap),
    [chapterColumns, library, onlyGaps, showArcs, showLines, storyRoleFilter],
  );
  const buckets = useMemo(
    () => buildBuckets(chapterColumns, rangeStart, rangeEnd, granularity),
    [chapterColumns, granularity, rangeEnd, rangeStart],
  );
  const linkedCharacterIds = useMemo(
    () =>
      new Set(
        library.arcs.flatMap((arc) =>
          arc.characterId ? [arc.characterId] : [],
        ),
      ),
    [library.arcs],
  );

  const availableTimelineWidth = Math.max(
    0,
    (scrollMetrics.width || 1_200) - TRACK_LABEL_WIDTH,
  );
  const bucketWidth =
    buckets.length === 0
      ? MIN_BUCKET_WIDTH
      : Math.max(MIN_BUCKET_WIDTH, availableTimelineWidth / buckets.length);
  const visibleStartIndex = clamp(
    Math.floor(scrollMetrics.left / bucketWidth) - VIRTUAL_OVERSCAN,
    0,
    Math.max(0, buckets.length - 1),
  );
  const visibleEndIndex = clamp(
    Math.ceil(
      (scrollMetrics.left +
        Math.max(availableTimelineWidth, MIN_BUCKET_WIDTH)) /
        bucketWidth,
    ) + VIRTUAL_OVERSCAN,
    0,
    buckets.length,
  );
  const visibleBuckets = buckets.slice(visibleStartIndex, visibleEndIndex);
  const leadingSpacerWidth = visibleStartIndex * bucketWidth;
  const trailingSpacerWidth =
    Math.max(0, buckets.length - visibleEndIndex) * bucketWidth;
  const gridTemplateColumns = `${TRACK_LABEL_WIDTH}px ${leadingSpacerWidth}px repeat(${Math.max(visibleBuckets.length, 1)}, ${bucketWidth}px) ${trailingSpacerWidth}px`;
  const timelineWidth = TRACK_LABEL_WIDTH + buckets.length * bucketWidth;

  const selectedTrack = selectedBar
    ? (tracks.find(
        (track) =>
          track.id === selectedBar.trackId &&
          track.kind === selectedBar.trackKind,
      ) ?? null)
    : null;
  const selectedDetails = useMemo(
    () =>
      selectedBar && selectedTrack
        ? buildTrackChapterDetails(
            selectedTrack,
            chapterColumns,
            selectedBar.startOrdinal,
            selectedBar.endOrdinal,
          )
        : [],
    [chapterColumns, selectedBar, selectedTrack],
  );

  const updateStart = (nextValue: number) => {
    if (chapterCount === 0) return;
    const nextStart = clamp(
      normalizeInteger(nextValue, rangeStart),
      1,
      chapterCount,
    );
    setViewport({
      ...resolvedViewport,
      start: nextStart,
      end: Math.max(clamp(resolvedViewport.end, 1, chapterCount), nextStart),
      chapterCount,
      customized: true,
    });
  };

  const updateEnd = (nextValue: number) => {
    if (chapterCount === 0) return;
    const nextEnd = clamp(
      normalizeInteger(nextValue, rangeEnd),
      1,
      chapterCount,
    );
    setViewport({
      ...resolvedViewport,
      start: Math.min(clamp(resolvedViewport.start, 1, chapterCount), nextEnd),
      end: nextEnd,
      chapterCount,
      customized: true,
    });
  };

  const updateGranularity = (nextValue: number) => {
    const nextGranularity = clamp(
      normalizeInteger(nextValue, granularity),
      MIN_GRANULARITY,
      MAX_GRANULARITY,
    );
    setViewport({
      ...resolvedViewport,
      granularity: nextGranularity,
      chapterCount,
      customized: true,
    });
  };

  const fitTargetColumns = () => {
    const rangeLength = Math.max(1, rangeEnd - rangeStart + 1);
    updateGranularity(suggestedGranularity(rangeLength));
  };

  const startPercent =
    chapterCount <= 1 ? 0 : ((rangeStart - 1) / (chapterCount - 1)) * 100;
  const endPercent =
    chapterCount <= 1 ? 100 : ((rangeEnd - 1) / (chapterCount - 1)) * 100;
  const unplannedTracks = tracks.filter((track) => track.linkedCount === 0);
  const gapTracks = tracks.filter(
    (track) => track.hasGap && track.linkedCount > 0,
  );

  return (
    <div className="ne-gantt-shell ne-panel-scroll">
      <div className="ne-gantt-toolbar border-b border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)] text-[var(--accent-warm)]">
              <ChartGantt className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--ink)]">
                故事编排
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--ink-muted)]">
                横轴始终显示章节序号；泳道同时投影章、节关联与关键节点，点击色条查看实际关联章节和节。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={`ns-button ${showLines ? "is-primary" : ""}`}
              onClick={() => setShowLines((value) => !value)}
            >
              <Route className="h-3.5 w-3.5" />
              线路
            </button>
            <button
              type="button"
              className={`ns-button ${showArcs ? "is-primary" : ""}`}
              onClick={() => setShowArcs((value) => !value)}
            >
              <GitBranch className="h-3.5 w-3.5" />
              故事弧
            </button>
            <button
              type="button"
              className={`ns-button ${onlyGaps ? "is-primary" : ""}`}
              onClick={() => setOnlyGaps((value) => !value)}
              title="只显示存在空档或尚未排入章节的轨道"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              只看缺口
            </button>
            <span className="mx-1 h-5 w-px bg-[var(--line)]" />
            <div
              className="flex rounded-md bg-[var(--paper-inset)] p-0.5"
              aria-label="A/B Story 筛选"
            >
              {(
                [
                  ["all", "全部"],
                  ["a", "A"],
                  ["b", "B"],
                  ["none", "未标记"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`h-8 rounded px-2.5 text-xs font-medium ${
                    storyRoleFilter === id
                      ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
                  }`}
                  onClick={() => setStoryRoleFilter(id)}
                  title={
                    id === "all" ? "显示全部线路" : `筛选 ${label} Story 线路`
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="ne-gantt-range-panel mt-4 border-t border-[var(--line-subtle)] pt-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <label className="ne-gantt-number-control">
              <span>起始章</span>
              <input
                type="number"
                min={1}
                max={Math.max(chapterCount, 1)}
                step={1}
                value={rangeStart}
                disabled={chapterCount === 0}
                onChange={(event) =>
                  updateStart(event.currentTarget.valueAsNumber)
                }
              />
            </label>
            <div className="ne-gantt-dual-range min-w-48 flex-1">
              <div className="ne-gantt-range-rail" />
              <div
                className="ne-gantt-range-selection"
                style={{
                  left: `${startPercent}%`,
                  right: `${100 - endPercent}%`,
                }}
              />
              <input
                className="ne-gantt-range-input"
                type="range"
                min={1}
                max={Math.max(chapterCount, 1)}
                step={1}
                value={rangeStart}
                disabled={chapterCount <= 1}
                aria-label="选择起始章节"
                style={{ zIndex: rangeStart >= rangeEnd - 1 ? 4 : 3 }}
                onChange={(event) =>
                  updateStart(event.currentTarget.valueAsNumber)
                }
              />
              <input
                className="ne-gantt-range-input"
                type="range"
                min={1}
                max={Math.max(chapterCount, 1)}
                step={1}
                value={rangeEnd}
                disabled={chapterCount <= 1}
                aria-label="选择结束章节"
                style={{ zIndex: 3 }}
                onChange={(event) =>
                  updateEnd(event.currentTarget.valueAsNumber)
                }
              />
            </div>
            <label className="ne-gantt-number-control">
              <span>结束章</span>
              <input
                type="number"
                min={1}
                max={Math.max(chapterCount, 1)}
                step={1}
                value={rangeEnd}
                disabled={chapterCount === 0}
                onChange={(event) =>
                  updateEnd(event.currentTarget.valueAsNumber)
                }
              />
            </label>
            <span className="hidden h-6 w-px bg-[var(--line)] xl:block" />
            <label className="ne-gantt-number-control">
              <span>粒度</span>
              <input
                type="number"
                min={MIN_GRANULARITY}
                max={MAX_GRANULARITY}
                step={1}
                value={granularity}
                disabled={chapterCount === 0}
                onChange={(event) =>
                  updateGranularity(event.currentTarget.valueAsNumber)
                }
              />
              <span>章/格</span>
            </label>
            <button
              type="button"
              className="ns-button"
              disabled={chapterCount === 0}
              title="根据当前章节范围重新计算粒度"
              onClick={fitTargetColumns}
            >
              <Columns3 className="h-3.5 w-3.5" />
              适配 10 格
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--ink-muted)]">
          <span>
            共 <strong className="text-[var(--ink)]">{chapterCount}</strong> 章
          </span>
          <span>
            当前{" "}
            <strong className="text-[var(--ink)]">
              {rangeStart}-{rangeEnd}
            </strong>
          </span>
          <span>
            <strong className="text-[var(--ink)]">{buckets.length}</strong>{" "}
            个横轴格
          </span>
          <span>
            <strong className="text-[var(--ink)]">{tracks.length}</strong>{" "}
            条叙事轨道
          </span>
          <span className="text-[var(--warning)]">
            <strong>{gapTracks.length}</strong> 条存在中断
          </span>
          <span className="text-[var(--accent-cool)]">
            <strong>{unplannedTracks.length}</strong> 条尚未排入
          </span>
        </div>
      </div>

      {chapterColumns.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <FileText className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
            <h3 className="mt-4 text-sm font-semibold text-[var(--ink)]">
              还没有章节横轴
            </h3>
            <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
              先创建章节计划，或继续写正文；章节出现后，线路和故事弧会自动投影到这里。
            </p>
          </div>
        </div>
      ) : tracks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <CircleHelp className="mx-auto h-8 w-8 text-[var(--ink-subtle)]" />
            <h3 className="mt-4 text-sm font-semibold text-[var(--ink)]">
              没有符合当前筛选的轨道
            </h3>
            <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
              打开线路或故事弧筛选，或先创建对应的叙事对象。
            </p>
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="ne-gantt-scroll ne-panel-scroll"
          onScroll={handleTimelineScroll}
        >
          <div
            className="ne-gantt-canvas"
            style={{ minWidth: `${timelineWidth}px` }}
          >
            <div
              className="ne-gantt-grid-row ne-gantt-header"
              style={{ gridTemplateColumns }}
            >
              <div className="ne-gantt-label ne-gantt-header-label px-3">
                <span className="text-xs font-semibold text-[var(--ink-muted)]">
                  叙事轨道
                </span>
              </div>
              <div aria-hidden="true" />
              {visibleBuckets.map((bucket) => (
                <div
                  key={`${bucket.startOrdinal}-${bucket.endOrdinal}`}
                  className="ne-gantt-column-head flex items-center justify-center border-b border-l border-[var(--line)] px-2 text-center"
                  title={`第 ${bucket.startOrdinal}-${bucket.endOrdinal} 章`}
                >
                  <span className="text-xs font-semibold tabular-nums text-[var(--ink)]">
                    {bucketLabel(bucket)}
                  </span>
                </div>
              ))}
              <div aria-hidden="true" />
            </div>
            {tracks.map((track) => (
              <div
                key={`${track.kind}-${track.id}`}
                className="ne-gantt-grid-row ne-gantt-track-row"
                style={{ gridTemplateColumns }}
              >
                <TrackLabel
                  track={track}
                  onClick={() => onSelect({ kind: track.kind, id: track.id })}
                />
                <div aria-hidden="true" />
                {visibleBuckets.map((bucket) => (
                  <div
                    key={`${track.id}-cell-${bucket.index}`}
                    className={`ne-gantt-cell ${bucket.hasPlannedChapter ? "is-planned" : ""}`}
                  />
                ))}
                <div aria-hidden="true" />
                {visibleBuckets.map((bucket, visibleIndex) => {
                  const bucketState = buildBucketTrackState(track, bucket);
                  if (bucketState.linkedCount === 0) return null;
                  const rangeLength =
                    bucket.endOrdinal - bucket.startOrdinal + 1;
                  return (
                    <button
                      key={`${track.id}-bar-${bucket.index}`}
                      type="button"
                      className={`ne-gantt-bar ${bucketState.hasInternalGap ? "has-internal-gap" : ""}`}
                      style={{
                        gridColumn: visibleIndex + 3,
                        backgroundColor: track.color,
                        opacity: 0.58 + bucketState.density * 0.42,
                      }}
                      onClick={() =>
                        setSelectedBar({
                          trackId: track.id,
                          trackKind: track.kind,
                          startOrdinal: bucket.startOrdinal,
                          endOrdinal: bucket.endOrdinal,
                        })
                      }
                      title={`${track.title} · 第 ${bucket.startOrdinal}-${bucket.endOrdinal} 章中关联 ${bucketState.linkedCount} 章`}
                      aria-label={`${track.title}，第 ${bucket.startOrdinal}-${bucket.endOrdinal} 章中关联 ${bucketState.linkedCount} 章，打开章节列表`}
                    >
                      <span className="truncate tabular-nums">
                        {bucketState.keyNodeCount > 0
                          ? `◆${bucketState.keyNodeCount > 1 ? bucketState.keyNodeCount : ""}`
                          : rangeLength > 1
                            ? `${bucketState.linkedCount}/${rangeLength}`
                            : ""}
                      </span>
                    </button>
                  );
                })}
                {track.linkedCount === 0 && visibleBuckets.length > 0 && (
                  <button
                    type="button"
                    className="ne-gantt-unplanned"
                    style={{ gridColumn: `3 / span ${visibleBuckets.length}` }}
                    onClick={() => onSelect({ kind: track.kind, id: track.id })}
                  >
                    尚未关联章节 · 点击回到编辑
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <footer className="ne-gantt-footer flex flex-wrap items-center gap-4 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3 text-xs text-[var(--ink-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--accent-warm)]" />
          颜色深浅表示覆盖密度
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--warning)]" />
          斜纹表示格内存在断档
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-dashed border-[var(--accent-cool)]" />
          待写章节
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-semibold text-[var(--accent-warm)]">◆</span>
          关键节点关联
        </span>
        {linkedCharacterIds.size > 0 && (
          <span className="ml-auto text-[var(--accent-cool)]">
            {linkedCharacterIds.size} 条角色弧已关联人物库
          </span>
        )}
      </footer>

      {selectedBar && selectedTrack && (
        <TrackChapterDialog
          key={`${selectedBar.trackKind}-${selectedBar.trackId}-${selectedBar.startOrdinal}-${selectedBar.endOrdinal}`}
          track={selectedTrack}
          details={selectedDetails}
          startOrdinal={selectedBar.startOrdinal}
          endOrdinal={selectedBar.endOrdinal}
          onClose={() => setSelectedBar(null)}
          onOpenChapter={(nodeId) => {
            setSelectedBar(null);
            onSelect({ kind: "chapter", id: nodeId });
          }}
          onOpenTrack={() => {
            setSelectedBar(null);
            onSelect({ kind: selectedTrack.kind, id: selectedTrack.id });
          }}
        />
      )}
    </div>
  );
}
