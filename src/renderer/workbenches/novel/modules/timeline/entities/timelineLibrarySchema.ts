import { z } from "zod";

import {
  timelineEntityTypeSchema,
  timelineEventKindSchema,
  timelineEventSchema,
  timelineForeshadowingSchema,
  timelineForeshadowingStatusSchema,
  timelineKnowledgeScopeSchema,
  timelineScopeSchema,
  timelineStateChangeSchema,
  timelineTimeExpressionSchema,
  timelineTimePrecisionSchema,
  type TimelineEntityType,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineForeshadowing,
  type TimelineForeshadowingStatus,
  type TimelineKnowledgeScope,
  type TimelineScope,
  type TimelineStateChange,
  type TimelineTimeExpression,
  type TimelineTimePrecision,
} from "../../../../../../shared/workbenches/novel/timelineEventSchema";

export {
  timelineEntityTypeSchema,
  timelineEventKindSchema,
  timelineEventSchema,
  timelineForeshadowingSchema,
  timelineForeshadowingStatusSchema,
  timelineKnowledgeScopeSchema,
  timelineScopeSchema,
  timelineStateChangeSchema,
  timelineTimeExpressionSchema,
  timelineTimePrecisionSchema,
};
export type {
  TimelineEntityType,
  TimelineEvent,
  TimelineEventKind,
  TimelineForeshadowing,
  TimelineForeshadowingStatus,
  TimelineKnowledgeScope,
  TimelineScope,
  TimelineStateChange,
  TimelineTimeExpression,
  TimelineTimePrecision,
};

export const TIMELINE_LIBRARY_SCHEMA_VERSION = 1 as const;
export const TIMELINE_LIBRARY_PATH = "timeline/index.json";
export const MAIN_TIMELINE_BRANCH_ID = "branch-main";

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const textSchema = z.string();

export const timelineCalendarSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    unit: z.string().trim().min(1),
    description: textSchema,
  })
  .strict();

export type TimelineCalendar = z.infer<typeof timelineCalendarSchema>;

export const timelinePeriodKindSchema = z.enum([
  "era",
  "epoch",
  "age",
  "phase",
]);

export type TimelinePeriodKind = z.infer<typeof timelinePeriodKindSchema>;

export const timelinePeriodSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    parentPeriodId: idSchema.nullable(),
    kind: timelinePeriodKindSchema,
    scope: timelineScopeSchema,
    startSortKey: z.number().finite().nullable(),
    endSortKey: z.number().finite().nullable(),
    precision: timelineTimePrecisionSchema,
    description: textSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TimelinePeriod = z.infer<typeof timelinePeriodSchema>;

export const timelineViewKindSchema = z.enum(["chronological", "narrative"]);

export type TimelineViewKind = z.infer<typeof timelineViewKindSchema>;

export const timelineViewScopeSchema = z.enum([
  "all",
  "universe",
  "local",
  "story",
]);

export type TimelineViewScope = z.infer<typeof timelineViewScopeSchema>;

export const timelineViewSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    kind: timelineViewKindSchema,
    scope: timelineViewScopeSchema,
    calendarId: idSchema,
    rootPeriodId: idSchema.nullable(),
  })
  .strict();

export type TimelineView = z.infer<typeof timelineViewSchema>;

export const timelineBranchSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    parentBranchId: idSchema.nullable(),
    forkEventId: idSchema.nullable(),
    description: textSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TimelineBranch = z.infer<typeof timelineBranchSchema>;

export const timelineLibrarySchema = z
  .object({
    schemaVersion: z.literal(TIMELINE_LIBRARY_SCHEMA_VERSION),
    calendars: z.array(timelineCalendarSchema).default([]),
    periods: z.array(timelinePeriodSchema).default([]),
    views: z.array(timelineViewSchema).default([]),
    storyStartEventId: idSchema.nullable().default(null),
    factsThroughEventId: idSchema.nullable().default(null),
    branches: z.array(timelineBranchSchema).min(1),
    events: z.array(timelineEventSchema),
  })
  .strict()
  .superRefine((library, context) => {
    const branchesById = new Map<string, TimelineBranch>();
    const eventsById = new Map<string, TimelineEvent>();
    const calendarsById = new Map<string, TimelineCalendar>();
    const periodsById = new Map<string, TimelinePeriod>();
    const viewsById = new Map<string, TimelineView>();

    library.calendars.forEach((calendar, index) => {
      if (calendarsById.has(calendar.id)) {
        context.addIssue({
          code: "custom",
          path: ["calendars", index, "id"],
          message: "历法 id 不得重复",
        });
      }
      calendarsById.set(calendar.id, calendar);
    });

    library.periods.forEach((period, index) => {
      if (periodsById.has(period.id)) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "id"],
          message: "纪元 id 不得重复",
        });
      }
      if (
        period.startSortKey !== null &&
        period.endSortKey !== null &&
        period.endSortKey < period.startSortKey
      ) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "endSortKey"],
          message: "纪元结束时间不能早于开始时间",
        });
      }
      periodsById.set(period.id, period);
    });

    library.views.forEach((view, index) => {
      if (viewsById.has(view.id)) {
        context.addIssue({
          code: "custom",
          path: ["views", index, "id"],
          message: "时间线视图 id 不得重复",
        });
      }
      viewsById.set(view.id, view);
      if (!calendarsById.has(view.calendarId)) {
        context.addIssue({
          code: "custom",
          path: ["views", index, "calendarId"],
          message: "视图关联的历法不存在",
        });
      }
      if (view.rootPeriodId && !periodsById.has(view.rootPeriodId)) {
        context.addIssue({
          code: "custom",
          path: ["views", index, "rootPeriodId"],
          message: "视图关联的纪元不存在",
        });
      }
    });

    library.branches.forEach((branch, index) => {
      if (branchesById.has(branch.id)) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "id"],
          message: "时间线分支 id 不得重复",
        });
      }
      branchesById.set(branch.id, branch);
    });

    library.events.forEach((event, index) => {
      if (eventsById.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: "时间线事件 id 不得重复",
        });
      }
      eventsById.set(event.id, event);
      if (!branchesById.has(event.branchId)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "branchId"],
          message: "事件所属分支不存在",
        });
      }
      if (event.endSortKey !== null && event.endSortKey < event.sortKey) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "endSortKey"],
          message: "事件结束时间不能早于开始时间",
        });
      }
      if (event.periodId && !periodsById.has(event.periodId)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "periodId"],
          message: "事件所属纪元不存在",
        });
      }
      event.timeExpressions.forEach((expression, expressionIndex) => {
        if (!calendarsById.has(expression.calendarId)) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              index,
              "timeExpressions",
              expressionIndex,
              "calendarId",
            ],
            message: "时间表达关联的历法不存在",
          });
        }
        if (
          expression.startValue !== null &&
          expression.endValue !== null &&
          expression.endValue < expression.startValue
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              index,
              "timeExpressions",
              expressionIndex,
              "endValue",
            ],
            message: "时间表达的结束值不能早于开始值",
          });
        }
      });
    });

    if (
      library.storyStartEventId &&
      !eventsById.has(library.storyStartEventId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["storyStartEventId"],
        message: "故事起点事件不存在",
      });
    }

    if (
      library.factsThroughEventId &&
      !eventsById.has(library.factsThroughEventId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["factsThroughEventId"],
        message: "事实截止事件不存在",
      });
    } else if (
      library.factsThroughEventId &&
      eventsById.get(library.factsThroughEventId)?.branchId !==
        MAIN_TIMELINE_BRANCH_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["factsThroughEventId"],
        message: "事实截止事件必须位于主时间线",
      });
    }

    const foreshadowingIds = new Set<string>();
    library.events.forEach((event, eventIndex) => {
      event.causeEventIds.forEach((causeEventId, causeIndex) => {
        if (causeEventId === event.id) {
          context.addIssue({
            code: "custom",
            path: ["events", eventIndex, "causeEventIds", causeIndex],
            message: "事件不能将自身设为前因",
          });
        } else if (!eventsById.has(causeEventId)) {
          context.addIssue({
            code: "custom",
            path: ["events", eventIndex, "causeEventIds", causeIndex],
            message: "前因事件不存在",
          });
        }
      });

      const stateChangeIds = new Set<string>();
      event.stateChanges.forEach((change, changeIndex) => {
        if (stateChangeIds.has(change.id)) {
          context.addIssue({
            code: "custom",
            path: ["events", eventIndex, "stateChanges", changeIndex, "id"],
            message: "同一事件内的状态变化 id 不得重复",
          });
        }
        stateChangeIds.add(change.id);
      });

      event.foreshadowings.forEach((foreshadowing, foreshadowingIndex) => {
        if (foreshadowingIds.has(foreshadowing.id)) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              eventIndex,
              "foreshadowings",
              foreshadowingIndex,
              "id",
            ],
            message: "伏笔 id 不得重复",
          });
        }
        foreshadowingIds.add(foreshadowing.id);
        if (
          foreshadowing.payoffEventId &&
          !eventsById.has(foreshadowing.payoffEventId)
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              eventIndex,
              "foreshadowings",
              foreshadowingIndex,
              "payoffEventId",
            ],
            message: "伏笔回收事件不存在",
          });
        }
        if (
          foreshadowing.status === "paid-off" &&
          !foreshadowing.payoffEventId
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "events",
              eventIndex,
              "foreshadowings",
              foreshadowingIndex,
              "payoffEventId",
            ],
            message: "已回收伏笔必须关联回收事件",
          });
        }
      });
    });

    if (library.periods.length > 0) {
      const rootPeriods = library.periods.filter(
        (period) => period.parentPeriodId === null,
      );
      if (rootPeriods.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["periods"],
          message: "纪元树必须且只能有一个根节点",
        });
      }
    }

    library.periods.forEach((period, index) => {
      if (!period.parentPeriodId) return;
      const parent = periodsById.get(period.parentPeriodId);
      if (!parent) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "parentPeriodId"],
          message: "上级纪元不存在",
        });
        return;
      }
      if (parent.id === period.id) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "parentPeriodId"],
          message: "纪元不能以自身为上级",
        });
      }
      if (
        parent.startSortKey !== null &&
        period.startSortKey !== null &&
        period.startSortKey < parent.startSortKey
      ) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "startSortKey"],
          message: "子纪元开始时间不能早于上级纪元",
        });
      }
      if (
        parent.endSortKey !== null &&
        period.endSortKey !== null &&
        period.endSortKey > parent.endSortKey
      ) {
        context.addIssue({
          code: "custom",
          path: ["periods", index, "endSortKey"],
          message: "子纪元结束时间不能晚于上级纪元",
        });
      }
    });

    library.periods.forEach((period, index) => {
      const visited = new Set<string>([period.id]);
      let parentId = period.parentPeriodId;
      while (parentId) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["periods", index, "parentPeriodId"],
            message: "纪元树不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId = periodsById.get(parentId)?.parentPeriodId ?? null;
      }
    });

    const rootBranches = library.branches.filter(
      (branch) => branch.parentBranchId === null,
    );
    if (rootBranches.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["branches"],
        message: "时间线必须且只能有一个主分支",
      });
    }

    library.branches.forEach((branch, index) => {
      const isRoot = branch.parentBranchId === null;
      if (isRoot && branch.forkEventId !== null) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "forkEventId"],
          message: "主分支不能设置分歧事件",
        });
      }
      if (!isRoot && !branch.forkEventId) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "forkEventId"],
          message: "子分支必须设置分歧事件",
        });
      }
      if (!branch.parentBranchId) return;

      if (!branchesById.has(branch.parentBranchId)) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "parentBranchId"],
          message: "上级分支不存在",
        });
        return;
      }
      if (branch.parentBranchId === branch.id) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "parentBranchId"],
          message: "分支不能以自身为上级",
        });
      }

      const forkEvent = branch.forkEventId
        ? eventsById.get(branch.forkEventId)
        : undefined;
      if (!forkEvent) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "forkEventId"],
          message: "分歧事件不存在",
        });
      } else if (forkEvent.branchId !== branch.parentBranchId) {
        context.addIssue({
          code: "custom",
          path: ["branches", index, "forkEventId"],
          message: "分歧事件必须属于上级分支",
        });
      }
    });

    library.branches.forEach((branch, index) => {
      const visited = new Set<string>([branch.id]);
      let parentId = branch.parentBranchId;
      while (parentId) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["branches", index, "parentBranchId"],
            message: "时间线分支不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId = branchesById.get(parentId)?.parentBranchId ?? null;
      }
    });
  });

export type TimelineLibrary = z.infer<typeof timelineLibrarySchema>;

export const UNIVERSE_TIMELINE_PERIOD_ID = "period-universe-history";

export function createDefaultTimelineCalendars(): TimelineCalendar[] {
  return [
    {
      id: "cosmic",
      name: "宇宙纪年",
      unit: "年",
      description: "统一世界坐标；可记录百帝元年前后的后世推算纪年。",
    },
    {
      id: "local",
      name: "本地历法",
      unit: "年",
      description: "道星、王朝或宗门等地方历法，不与宇宙纪年强制换算。",
    },
    {
      id: "story",
      name: "故事相对时间",
      unit: "单位",
      description: "以作者标记的故事起点为参照，用于正文进程视图。",
    },
  ];
}

export function createDefaultTimelinePeriods(
  createdAt: string,
): TimelinePeriod[] {
  return [
    {
      id: UNIVERSE_TIMELINE_PERIOD_ID,
      name: "宇宙史",
      parentPeriodId: null,
      kind: "era",
      scope: "universe",
      startSortKey: null,
      endSortKey: null,
      precision: "unknown",
      description: "统一世界时间轴的根容器。",
      createdAt,
      updatedAt: createdAt,
    },
  ];
}

export function createDefaultTimelineViews(
  rootPeriodId = UNIVERSE_TIMELINE_PERIOD_ID,
): TimelineView[] {
  return [
    {
      id: "universe-history",
      name: "宇宙史",
      kind: "chronological",
      scope: "all",
      calendarId: "cosmic",
      rootPeriodId,
    },
    {
      id: "local-history",
      name: "地方史",
      kind: "chronological",
      scope: "local",
      calendarId: "local",
      rootPeriodId: null,
    },
    {
      id: "story-progress",
      name: "故事进程",
      kind: "chronological",
      scope: "story",
      calendarId: "story",
      rootPeriodId: null,
    },
    {
      id: "narrative-reveal",
      name: "叙事揭示",
      kind: "narrative",
      scope: "story",
      calendarId: "story",
      rootPeriodId: null,
    },
  ];
}

function normalizeTimelineLibrary(library: TimelineLibrary): TimelineLibrary {
  const createdAt = library.branches[0]?.createdAt ?? new Date(0).toISOString();
  const periods =
    library.periods.length > 0
      ? library.periods
      : createDefaultTimelinePeriods(createdAt);
  const rootPeriodId =
    periods.find((period) => period.parentPeriodId === null)?.id ??
    UNIVERSE_TIMELINE_PERIOD_ID;
  return {
    ...library,
    calendars:
      library.calendars.length > 0
        ? library.calendars
        : createDefaultTimelineCalendars(),
    periods,
    views:
      library.views.length > 0
        ? library.views
        : createDefaultTimelineViews(rootPeriodId),
  };
}

export interface TimelineProjectedEvent {
  readonly event: TimelineEvent;
  readonly sourceBranch: TimelineBranch;
  readonly inherited: boolean;
}

function compareEvents(left: TimelineEvent, right: TimelineEvent): number {
  if (left.sortKey !== right.sortKey) return left.sortKey - right.sortKey;
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  return left.id.localeCompare(right.id);
}

export function getTimelineBranchChain(
  library: TimelineLibrary,
  branchId: string,
): readonly TimelineBranch[] {
  const branchesById = new Map(
    library.branches.map((branch) => [branch.id, branch]),
  );
  const result: TimelineBranch[] = [];
  const visited = new Set<string>();
  let current = branchesById.get(branchId);
  while (current) {
    if (visited.has(current.id)) {
      throw new TimelineLibraryFormatError(
        "时间线分支包含循环引用，无法计算继承事件",
      );
    }
    visited.add(current.id);
    result.unshift(current);
    current = current.parentBranchId
      ? branchesById.get(current.parentBranchId)
      : undefined;
  }
  if (!result.length) {
    throw new TimelineLibraryFormatError(`时间线分支不存在：${branchId}`);
  }
  return result;
}

export function getTimelineBranchEvents(
  library: TimelineLibrary,
  branchId: string,
): readonly TimelineProjectedEvent[] {
  const branchesById = new Map(
    library.branches.map((branch) => [branch.id, branch]),
  );
  const eventsById = new Map(library.events.map((event) => [event.id, event]));
  const chain = getTimelineBranchChain(library, branchId);
  const projected: TimelineProjectedEvent[] = [];

  chain.forEach((branch, position) => {
    const nextBranch = chain[position + 1];
    const forkEvent = nextBranch?.forkEventId
      ? eventsById.get(nextBranch.forkEventId)
      : undefined;
    library.events
      .filter((event) => event.branchId === branch.id)
      .filter((event) => !forkEvent || compareEvents(event, forkEvent) <= 0)
      .forEach((event) => {
        projected.push({
          event,
          sourceBranch: branchesById.get(event.branchId) ?? branch,
          inherited: event.branchId !== branchId,
        });
      });
  });

  return projected.sort((left, right) =>
    compareEvents(left.event, right.event),
  );
}

export function getTimelinePeriodDescendantIds(
  library: TimelineLibrary,
  periodId: string,
): ReadonlySet<string> {
  const ids = new Set<string>([periodId]);
  const append = (parentId: string) => {
    library.periods
      .filter((period) => period.parentPeriodId === parentId)
      .forEach((period) => {
        ids.add(period.id);
        append(period.id);
      });
  };
  append(periodId);
  return ids;
}

export class TimelineLibraryFormatError extends Error {
  constructor(detail: string) {
    super(`时间线数据格式无效：${detail}`);
    this.name = "TimelineLibraryFormatError";
  }
}

export function createEmptyTimelineLibrary(createdAt: string): TimelineLibrary {
  return {
    schemaVersion: TIMELINE_LIBRARY_SCHEMA_VERSION,
    calendars: createDefaultTimelineCalendars(),
    periods: createDefaultTimelinePeriods(createdAt),
    views: createDefaultTimelineViews(),
    storyStartEventId: null,
    factsThroughEventId: null,
    branches: [
      {
        id: MAIN_TIMELINE_BRANCH_ID,
        name: "主时间线",
        parentBranchId: null,
        forkEventId: null,
        description: "",
        createdAt,
        updatedAt: createdAt,
      },
    ],
    events: [],
  };
}

export function parseTimelineLibrary(content: string): TimelineLibrary {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new TimelineLibraryFormatError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = timelineLibrarySchema.safeParse(value);
  if (!result.success) {
    throw new TimelineLibraryFormatError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return normalizeTimelineLibrary(result.data);
}

export function serializeTimelineLibrary(library: TimelineLibrary): string {
  return `${JSON.stringify(timelineLibrarySchema.parse(library), null, 2)}\n`;
}
