import { describe, expect, it } from "vitest";

import { hashManuscriptContent } from "./manuscriptTrackingRepository";
import type {
  ManuscriptTrackingBatch,
  ManuscriptTrackingChange,
} from "./manuscriptTrackingSchema";
import { compileAppliedChapterFacts } from "./chapterFactCompiler";
import type { TimelineEvent } from "./timelineLibrarySchema";

const createdAt = "2026-08-03T00:00:00.000Z";
const chapter = {
  id: "chapter-000001",
  title: "第一章",
  displayNumber: 1,
  order: 0,
  path: "manuscript/chapters/000001.md",
  content: "沈砚抵达云城。",
  sourceHash: "sha256:chapter",
} as const;

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "event-tracking-batch-1",
    branchId: "branch-main",
    timeLabel: "第十日",
    sortKey: 10,
    worldSortKey: "10",
    sortOrder: 0,
    endSortKey: null,
    timePrecision: "exact",
    timeExpressions: [],
    periodId: null,
    scope: "story",
    knowledgeScope: "public",
    narrativeOrder: 1,
    title: "沈砚抵达云城",
    kind: "event",
    summary: "沈砚已抵达云城。",
    description: "正文明确记载沈砚抵达云城。",
    characterIds: ["character-shen"],
    locationIds: ["cloud-city"],
    chapterIds: [chapter.id],
    factionIds: [],
    itemIds: [],
    causeEventIds: [],
    stateChanges: [],
    foreshadowings: [],
    tags: ["正文同步"],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function change(
  overrides: Partial<ManuscriptTrackingChange> = {},
): ManuscriptTrackingChange {
  return {
    id: "tracking-change-1",
    domain: "timeline",
    entityId: null,
    title: "沈砚抵达云城",
    before: null,
    after: "沈砚已抵达云城。",
    evidence: "沈砚抵达云城",
    operation: {
      kind: "timeline-event",
      eventKind: "event",
      timeLabel: "第十日",
    },
    ...overrides,
  };
}

function batch(
  overrides: Partial<ManuscriptTrackingBatch> = {},
): ManuscriptTrackingBatch {
  const tracked = event();
  return {
    id: "tracking-batch-1",
    chapterId: chapter.id,
    chapterContentHash: hashManuscriptContent(chapter.content),
    summary: "第一章正文事实",
    status: "applied",
    createdAt,
    appliedAt: createdAt,
    revertedAt: null,
    changes: [change()],
    mutations: [
      {
        targetKey: "timeline-event:event-tracking-batch-1",
        targetKind: "timeline-event",
        entityId: tracked.id,
        relatedId: null,
        field: null,
        before: null,
        after: tracked,
      },
    ],
    ...overrides,
  };
}

const input = (batchValue: ManuscriptTrackingBatch, timeline = event()) => ({
  chapters: [chapter],
  ledger: { batches: [batchValue] },
  batchSourceHashes: new Map([[batchValue.id, "sha256:batch"]]),
  timelineEvents: [timeline],
  calendar: {
    id: "cosmic",
    name: "世界纪年",
    daysPerMonth: 30,
    monthsPerYear: 12,
    eraYears: "100000000",
  },
  entityIds: {
    characterIds: new Set(["character-shen"]),
    factionIds: new Set<string>(),
    itemIds: new Set<string>(),
    locationIds: new Set(["cloud-city"]),
    foreshadowingIds: new Set<string>(),
  },
});

describe("章节事实编译", () => {
  it("只把已应用且证据、时间和实体引用有效的批次编译为稳定事实", () => {
    const result = compileAppliedChapterFacts(input(batch()));

    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      id: "chapter-fact-tracking-batch-1",
      timelineEventId: "event-tracking-batch-1",
      chapterId: chapter.id,
      authority: "actual",
      time: { sortKey: "10" },
    });
    expect(result.facts[0]?.sourceRefs.map((ref) => ref.path)).toEqual([
      chapter.path,
      "manuscript/state-ledger/batches/tracking-batch-1.json",
    ]);
  });

  it("拒绝正文哈希漂移、无效逐字证据和未确认批次", () => {
    const stale = compileAppliedChapterFacts(
      input(batch({ chapterContentHash: "fnv1a-stale" })),
    );
    expect(stale.facts).toHaveLength(0);
    expect(stale.diagnostics[0]?.id).toBe(
      "chapter-fact-source-stale-tracking-batch-1",
    );

    const invalidEvidence = compileAppliedChapterFacts(
      input(
        batch({
          changes: [change({ evidence: "正文没有这句话" })],
        }),
      ),
    );
    expect(invalidEvidence.facts).toHaveLength(0);
    expect(invalidEvidence.diagnostics[0]?.id).toBe(
      "chapter-fact-evidence-invalid-tracking-batch-1",
    );

    const proposed = compileAppliedChapterFacts(
      input(batch({ status: "proposed", appliedAt: null })),
    );
    expect(proposed.facts).toHaveLength(0);
    expect(proposed.diagnostics[0]).toMatchObject({
      id: "chapter-fact-batch-not-applied-tracking-batch-1",
      severity: "info",
    });
  });

  it("对无法定位世界时间和正式时间线冲突给出诊断", () => {
    const unknownEvent = event({
      worldSortKey: null,
      timePrecision: "unknown",
    });
    const unknownTime = compileAppliedChapterFacts(
      input(
        batch({
          mutations: [
            {
              targetKey: "timeline-event:event-tracking-batch-1",
              targetKind: "timeline-event",
              entityId: unknownEvent.id,
              relatedId: null,
              field: null,
              before: null,
              after: unknownEvent,
            },
          ],
        }),
        unknownEvent,
      ),
    );
    expect(unknownTime.facts).toHaveLength(0);
    expect(unknownTime.diagnostics[0]?.id).toBe(
      "chapter-fact-time-unresolved-tracking-batch-1",
    );

    const conflict = compileAppliedChapterFacts(
      input(batch(), event({ summary: "正式时间线已被改写" })),
    );
    expect(conflict.facts).toHaveLength(0);
    expect(conflict.diagnostics[0]).toMatchObject({
      id: "chapter-fact-timeline-conflict-tracking-batch-1",
      severity: "blocking",
    });
  });
});
