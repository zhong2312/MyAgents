import { manuscriptTrackingBatchPath } from "../../../shared/workbenches/novel/manuscriptTrackingStorage";

import {
  getManuscriptTrackingReferenceIssue,
  type ManuscriptTrackingBatch,
} from "./manuscriptTrackingSchema";
import { isManuscriptTrackingEvidenceGrounded } from "./manuscriptTrackingEvidence";
import { hashManuscriptContent } from "./manuscriptTrackingRepository";
import {
  timelineEventSchema,
  type TimelineEvent,
} from "./timelineLibrarySchema";
import { createWorldInstant } from "./worldSimulationTime";
import type {
  ChapterFactProjection,
  SimulationDiagnostic,
  SimulationSourceRef,
  WorldSimulationScenario,
} from "./worldSimulationV2Schema";

export interface ChapterFactCompilationChapter {
  readonly id: string;
  readonly title: string;
  readonly displayNumber: number;
  readonly order: number;
  readonly path: string;
  readonly content: string;
  readonly sourceHash: string;
}

export interface ChapterFactCompilationInput {
  readonly chapters: readonly ChapterFactCompilationChapter[];
  /** 未创建正文连续性账本时为 null，投影编译不得为只读操作创建账本。 */
  readonly ledger: {
    readonly batches: readonly ManuscriptTrackingBatch[];
  } | null;
  readonly batchSourceHashes: ReadonlyMap<string, string>;
  readonly timelineEvents: readonly TimelineEvent[];
  readonly calendar: WorldSimulationScenario["calendar"];
  readonly entityIds: {
    readonly characterIds: ReadonlySet<string>;
    readonly factionIds: ReadonlySet<string>;
    readonly itemIds: ReadonlySet<string>;
    readonly locationIds: ReadonlySet<string>;
    readonly foreshadowingIds: ReadonlySet<string>;
  };
}

export interface ChapterFactCompilationResult {
  readonly facts: readonly ChapterFactProjection[];
  readonly diagnostics: readonly SimulationDiagnostic[];
}

function sourceRefsFor(
  chapter: ChapterFactCompilationChapter,
  batch: ManuscriptTrackingBatch,
  batchSourceHashes: ReadonlyMap<string, string>,
): readonly SimulationSourceRef[] {
  return [
    {
      path: chapter.path,
      sourceHash: chapter.sourceHash,
      authority: "actual",
      entityId: chapter.id,
      excerpt: batch.summary,
    },
    {
      path: manuscriptTrackingBatchPath(batch.id),
      sourceHash: batchSourceHashes.get(batch.id) ?? "missing",
      authority: "actual",
      entityId: batch.id,
      excerpt: batch.summary,
    },
  ];
}

function diagnostic(
  id: string,
  title: string,
  detail: string,
  sourceRefs: readonly SimulationSourceRef[],
  severity: SimulationDiagnostic["severity"] = "warning",
): SimulationDiagnostic {
  return { id, severity, title, detail, sourceRefs };
}

function stableValuesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameTimelineEvent(left: TimelineEvent, right: TimelineEvent): boolean {
  return (
    left.worldSortKey === right.worldSortKey &&
    left.sortKey === right.sortKey &&
    left.timePrecision === right.timePrecision &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.description === right.description &&
    stableValuesEqual(left.characterIds, right.characterIds) &&
    stableValuesEqual(left.locationIds, right.locationIds) &&
    stableValuesEqual(left.factionIds, right.factionIds) &&
    stableValuesEqual(left.itemIds, right.itemIds) &&
    JSON.stringify(left.stateChanges) === JSON.stringify(right.stateChanges)
  );
}

function trackedTimelineEvent(
  batch: ManuscriptTrackingBatch,
): TimelineEvent | null {
  const mutation = batch.mutations.find(
    (candidate) =>
      candidate.targetKind === "timeline-event" &&
      candidate.entityId === `event-${batch.id}`,
  );
  if (!mutation?.after) return null;
  const parsed = timelineEventSchema.safeParse(mutation.after);
  return parsed.success ? parsed.data : null;
}

/**
 * 将已由作者应用、且正文证据仍有效的追踪批次转换为基线事实。
 * 不做自然语言推断；缺少明确时间、实体引用或证据时一律不进入沙盒。
 */
export function compileAppliedChapterFacts(
  input: ChapterFactCompilationInput,
): ChapterFactCompilationResult {
  if (!input.ledger) return { facts: [], diagnostics: [] };

  const chaptersById = new Map(
    input.chapters.map((chapter) => [chapter.id, chapter]),
  );
  const timelineById = new Map(
    input.timelineEvents.map((event) => [event.id, event]),
  );
  const facts: ChapterFactProjection[] = [];
  const diagnostics: SimulationDiagnostic[] = [];

  for (const batch of input.ledger.batches) {
    const chapter = chaptersById.get(batch.chapterId);
    const refs = chapter
      ? sourceRefsFor(chapter, batch, input.batchSourceHashes)
      : [
          {
            path: manuscriptTrackingBatchPath(batch.id),
            sourceHash: input.batchSourceHashes.get(batch.id) ?? "missing",
            authority: "actual" as const,
            entityId: batch.id,
            excerpt: batch.summary,
          },
        ];
    if (!chapter) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-chapter-missing-${batch.id}`,
          "章节事实引用的正文不存在",
          `已应用追踪批次“${batch.summary}”引用的章节 ${batch.chapterId} 已不存在，不能进入推演基线。`,
          refs,
        ),
      );
      continue;
    }
    if (batch.status !== "applied") {
      diagnostics.push(
        diagnostic(
          `chapter-fact-batch-not-applied-${batch.id}`,
          "章节事实尚未确认",
          `追踪批次“${batch.summary}”状态为 ${batch.status}，未经过作者采纳，不会成为推演事实。`,
          refs,
          "info",
        ),
      );
      continue;
    }
    if (!batch.changes.length || !batch.mutations.length) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-batch-empty-${batch.id}`,
          "章节事实缺少已应用状态变化",
          `已应用追踪批次“${batch.summary}”没有可编译的变更或状态投影。`,
          refs,
        ),
      );
      continue;
    }
    if (batch.chapterContentHash !== hashManuscriptContent(chapter.content)) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-source-stale-${batch.id}`,
          "章节事实来源已过期",
          `追踪批次“${batch.summary}”对应的正文哈希已变化；正文变化后必须重新执行连续性分析，不能复用旧事实。`,
          refs,
        ),
      );
      continue;
    }
    const invalidEvidence = batch.changes.filter(
      (change) =>
        !isManuscriptTrackingEvidenceGrounded(chapter.content, change.evidence),
    );
    if (invalidEvidence.length > 0) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-evidence-invalid-${batch.id}`,
          "章节事实证据已失效",
          `追踪批次“${batch.summary}”的 ${invalidEvidence.length} 条逐字证据已不在当前正文中；正文变化后必须重新确认，不能继续复用旧事实。`,
          refs,
        ),
      );
      continue;
    }
    const referenceIssues = batch.changes
      .map((change) =>
        getManuscriptTrackingReferenceIssue(change, input.entityIds),
      )
      .filter((issue): issue is string => Boolean(issue));
    if (referenceIssues.length > 0) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-reference-invalid-${batch.id}`,
          "章节事实实体引用失效",
          referenceIssues.join("；"),
          refs,
        ),
      );
      continue;
    }
    const event = trackedTimelineEvent(batch);
    if (!event) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-event-missing-${batch.id}`,
          "章节事实缺少时间线投影",
          `已应用追踪批次“${batch.summary}”没有可解析的时间线状态投影，无法确定事实发生时间。`,
          refs,
        ),
      );
      continue;
    }
    const persistedEvent = timelineById.get(event.id);
    if (persistedEvent && !sameTimelineEvent(event, persistedEvent)) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-timeline-conflict-${batch.id}`,
          "章节事实与正式时间线冲突",
          `追踪批次“${batch.summary}”生成的时间线事件 ${event.id} 已被其它编辑改写；必须先解决两处事实差异。`,
          refs,
          "blocking",
        ),
      );
      continue;
    }
    const sortKey =
      event.worldSortKey ??
      (event.timePrecision === "unknown"
        ? null
        : String(Math.trunc(event.sortKey)));
    if (!sortKey) {
      diagnostics.push(
        diagnostic(
          `chapter-fact-time-unresolved-${batch.id}`,
          "章节事实时间无法解析",
          `追踪批次“${batch.summary}”只有章节顺序，未提供可换算的世界时间。它可能是回忆、插叙或误判，不能自动进入沙盒基线。`,
          refs,
        ),
      );
      continue;
    }
    facts.push({
      id: `chapter-fact-${batch.id}`,
      timelineEventId: event.id,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      batchId: batch.id,
      changeIds: batch.changes.map((change) => change.id),
      title: event.title,
      summary: event.summary || event.description || batch.summary,
      time: createWorldInstant(
        sortKey,
        input.calendar,
        event.timePrecision === "unknown" || event.timePrecision === "range"
          ? "approximate"
          : event.timePrecision,
      ),
      authority: "actual",
      characterIds: [...event.characterIds],
      factionIds: [...event.factionIds],
      locationIds: [...event.locationIds],
      itemIds: [...event.itemIds],
      chapterIds: [chapter.id],
      causeEventIds: [...event.causeEventIds],
      stateChanges: event.stateChanges.map((change) => ({ ...change })),
      sourceRefs: refs,
    });
  }

  return {
    facts: facts.sort((left, right) =>
      BigInt(left.time.sortKey) === BigInt(right.time.sortKey)
        ? left.chapterOrder - right.chapterOrder ||
          left.id.localeCompare(right.id)
        : BigInt(left.time.sortKey) < BigInt(right.time.sortKey)
          ? -1
          : 1,
    ),
    diagnostics,
  };
}
