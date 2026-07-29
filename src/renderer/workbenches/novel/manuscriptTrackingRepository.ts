import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createEmptyManuscriptTrackingLedger,
  MANUSCRIPT_TRACKING_PATH,
  parseManuscriptTrackingLedger,
  serializeManuscriptTrackingLedger,
  type ManuscriptTrackingBatch,
  type ManuscriptTrackingChange,
  type ManuscriptTrackingLedger,
  type ManuscriptTrackingMutation,
} from "./manuscriptTrackingSchema";
import {
  createManuscriptTrackingProjection,
  type ManuscriptProjectionChapter,
  type ProjectionSnapshotUpdate,
} from "./manuscriptTrackingProjection";
import {
  manuscriptChapterOrderMap,
  parseNovelChapterIndex,
  type NovelChapterIndex,
} from "./projectSchema";

const MANUSCRIPT_INDEX_PATH = "manuscript/index.json";
type ChapterOrder = ReadonlyMap<string, number>;

export interface LoadedManuscriptTrackingLedger {
  readonly ledger: ManuscriptTrackingLedger;
  readonly content: string;
}

export interface CreateTrackingBatchInput {
  readonly chapterId: string;
  readonly chapterContentHash: string;
  readonly summary: string;
  readonly changes: readonly Omit<ManuscriptTrackingChange, "id">[];
}

function createStableId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.toLowerCase()}`;
}

export function hashManuscriptContent(content: string): string {
  let hash = 2166136261;
  for (const character of content) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createManuscriptTrackingRepository(storage: WorkbenchStorage) {
  const projection = createManuscriptTrackingProjection(storage);
  const load = async (): Promise<LoadedManuscriptTrackingLedger> => {
    const [info] = await storage.stat([MANUSCRIPT_TRACKING_PATH]);
    if (!info?.exists) {
      const content = serializeManuscriptTrackingLedger(
        createEmptyManuscriptTrackingLedger(),
      );
      try {
        const file = await storage.createText(
          MANUSCRIPT_TRACKING_PATH,
          content,
          { createParents: true },
        );
        return Object.freeze({
          ledger: parseManuscriptTrackingLedger(file.content),
          content: file.content,
        });
      } catch {
        // 另一个页面可能同时完成了初始化。
      }
    }
    const file = await storage.readText(MANUSCRIPT_TRACKING_PATH);
    return Object.freeze({
      ledger: parseManuscriptTrackingLedger(file.content),
      content: file.content,
    });
  };

  const save = async (
    current: LoadedManuscriptTrackingLedger,
    ledger: ManuscriptTrackingLedger,
  ): Promise<LoadedManuscriptTrackingLedger> => {
    const normalized: ManuscriptTrackingLedger = {
      ...ledger,
      updatedAt: new Date().toISOString(),
    };
    const content = serializeManuscriptTrackingLedger(normalized);
    const file = await storage.writeText(MANUSCRIPT_TRACKING_PATH, content, {
      expectedContent: current.content,
    });
    return Object.freeze({
      ledger: parseManuscriptTrackingLedger(file.content),
      content: file.content,
    });
  };

  const loadChapterOrder = async (): Promise<ChapterOrder> => {
    const file = await storage.readText(MANUSCRIPT_INDEX_PATH);
    const index = parseNovelChapterIndex(file.content);
    return manuscriptChapterOrderMap(index.directories, index.chapters);
  };

  const fallbackChapterOrder = (
    chapterId: string,
    order: ChapterOrder,
  ): number => {
    const numeric = Number(chapterId.replace(/^chapter-/u, ""));
    return order.size + (Number.isFinite(numeric) ? numeric : 0);
  };

  const orderedMutations = (
    ledger: ManuscriptTrackingLedger,
    order: ChapterOrder,
  ): readonly {
    readonly batch: ManuscriptTrackingBatch;
    readonly mutation: ManuscriptTrackingMutation;
  }[] =>
    [...ledger.batches]
      .filter((batch) => batch.status === "applied")
      .sort(
        (left, right) =>
          (order.get(left.chapterId) ??
            fallbackChapterOrder(left.chapterId, order)) -
            (order.get(right.chapterId) ??
              fallbackChapterOrder(right.chapterId, order)) ||
          left.createdAt.localeCompare(right.createdAt),
      )
      .flatMap((batch) =>
        batch.mutations.map((mutation) => ({ batch, mutation })),
      );

  const projectionUpdates = (
    current: ManuscriptTrackingLedger,
    next: ManuscriptTrackingLedger,
    affectedTargetKeys: ReadonlySet<string>,
    currentOrder: ChapterOrder,
    nextOrder: ChapterOrder,
  ): ProjectionSnapshotUpdate[] => {
    const currentEntries = orderedMutations(current, currentOrder);
    const nextEntries = orderedMutations(next, nextOrder);
    return [...affectedTargetKeys].flatMap((targetKey) => {
      const currentForTarget = currentEntries.filter(
        (entry) => entry.mutation.targetKey === targetKey,
      );
      const nextForTarget = nextEntries.filter(
        (entry) => entry.mutation.targetKey === targetKey,
      );
      const descriptor =
        currentForTarget.at(-1)?.mutation ?? nextForTarget.at(-1)?.mutation;
      if (!descriptor) return [];
      const baseline = Object.hasOwn(current.baselines, targetKey)
        ? current.baselines[targetKey]
        : Object.hasOwn(next.baselines, targetKey)
          ? next.baselines[targetKey]
          : (currentForTarget[0]?.mutation.before ??
            nextForTarget[0]?.mutation.before ??
            null);
      return [
        {
          mutation: descriptor,
          expected: currentForTarget.at(-1)?.mutation.after ?? baseline,
          value: nextForTarget.at(-1)?.mutation.after ?? baseline,
        },
      ];
    });
  };

  const rebaseAppliedMutations = (
    current: ManuscriptTrackingLedger,
    next: ManuscriptTrackingLedger,
    nextOrder: ChapterOrder,
  ): ManuscriptTrackingLedger => {
    const baselines = { ...current.baselines, ...next.baselines };
    const retimed: ManuscriptTrackingLedger = {
      ...next,
      baselines,
      batches: next.batches.map((batch) => {
        if (batch.status !== "applied") return batch;
        return {
          ...batch,
          mutations: batch.mutations.map((mutation) => {
            if (
              mutation.targetKind !== "timeline-event" ||
              !mutation.after ||
              typeof mutation.after !== "object" ||
              Array.isArray(mutation.after)
            )
              return mutation;
            const after = mutation.after as Record<string, unknown>;
            const eventChapterId =
              Array.isArray(after.chapterIds) &&
              typeof after.chapterIds[0] === "string"
                ? after.chapterIds[0]
                : batch.chapterId;
            const sequence =
              (nextOrder.get(eventChapterId) ??
                fallbackChapterOrder(eventChapterId, nextOrder)) + 1;
            return {
              ...mutation,
              after: {
                ...after,
                sortKey: sequence,
                narrativeOrder: sequence,
              },
            };
          }),
        };
      }),
    };
    const previousAfter = new Map<string, unknown | null>();
    const beforeByMutation = new Map<string, unknown | null>();
    for (const { batch, mutation } of orderedMutations(retimed, nextOrder)) {
      const before = previousAfter.has(mutation.targetKey)
        ? (previousAfter.get(mutation.targetKey) ?? null)
        : Object.hasOwn(baselines, mutation.targetKey)
          ? baselines[mutation.targetKey]
          : (mutation.before ?? null);
      beforeByMutation.set(`${batch.id}\u0000${mutation.targetKey}`, before);
      previousAfter.set(mutation.targetKey, mutation.after);
    }
    return {
      ...retimed,
      batches: retimed.batches.map((batch) =>
        batch.status !== "applied"
          ? batch
          : {
              ...batch,
              mutations: batch.mutations.map((mutation) => ({
                ...mutation,
                before:
                  beforeByMutation.get(
                    `${batch.id}\u0000${mutation.targetKey}`,
                  ) ?? null,
              })),
            },
      ),
    };
  };

  const transition = async (
    current: LoadedManuscriptTrackingLedger,
    requested: ManuscriptTrackingLedger,
    currentOrder: ChapterOrder,
    nextOrder: ChapterOrder,
  ): Promise<LoadedManuscriptTrackingLedger> => {
    const nextLedger = rebaseAppliedMutations(
      current.ledger,
      requested,
      nextOrder,
    );
    const affectedTargetKeys = new Set(
      [...current.ledger.batches, ...nextLedger.batches]
        .filter((batch) => batch.status === "applied")
        .flatMap((batch) =>
          batch.mutations.map((mutation) => mutation.targetKey),
        ),
    );
    const forward = projectionUpdates(
      current.ledger,
      nextLedger,
      affectedTargetKeys,
      currentOrder,
      nextOrder,
    );
    await projection.applySnapshots(forward);
    try {
      return await save(current, nextLedger);
    } catch (error) {
      const reverse = projectionUpdates(
        nextLedger,
        current.ledger,
        affectedTargetKeys,
        nextOrder,
        currentOrder,
      );
      await projection.applySnapshots(reverse).catch((cause) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；状态事务回滚失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
      throw error;
    }
  };

  const changeStatuses = async (
    current: LoadedManuscriptTrackingLedger,
    batchIds: readonly string[],
    status: "applied" | "reverted",
  ): Promise<LoadedManuscriptTrackingLedger> => {
    if (!batchIds.length) return current;
    const selected = new Set(batchIds);
    const now = new Date().toISOString();
    const nextLedger: ManuscriptTrackingLedger = {
      ...current.ledger,
      batches: current.ledger.batches.map((batch) =>
        selected.has(batch.id)
          ? {
              ...batch,
              status,
              appliedAt:
                status === "applied"
                  ? (batch.appliedAt ?? now)
                  : batch.appliedAt,
              revertedAt: status === "reverted" ? now : null,
            }
          : batch,
      ),
    };
    const order = await loadChapterOrder();
    return transition(current, nextLedger, order, order);
  };

  return Object.freeze({
    load,
    save,
    async createProposal(
      current: LoadedManuscriptTrackingLedger,
      input: CreateTrackingBatchInput,
    ) {
      const now = new Date().toISOString();
      const batch: ManuscriptTrackingBatch = {
        id: createStableId("tracking-batch"),
        chapterId: input.chapterId,
        chapterContentHash: input.chapterContentHash,
        summary: input.summary,
        status: "proposed",
        createdAt: now,
        appliedAt: null,
        revertedAt: null,
        changes: input.changes.map((change) => ({
          ...change,
          id: createStableId("tracking-change"),
        })),
        mutations: [],
      };
      const next = await save(current, {
        ...current.ledger,
        batches: [batch, ...current.ledger.batches],
      });
      return Object.freeze({ ...next, batch });
    },
    async setBatchStatus(
      current: LoadedManuscriptTrackingLedger,
      batchId: string,
      status: ManuscriptTrackingBatch["status"],
    ) {
      const batch = current.ledger.batches.find((item) => item.id === batchId);
      if (!batch) {
        throw new Error("状态批次不存在");
      }
      if (status === "applied" && batch.status === "proposed") {
        throw new Error("待审阅批次必须选择变化后再同步");
      }
      if (status === "proposed" && batch.status !== "proposed") {
        throw new Error("已处理批次不能恢复为待审阅状态");
      }
      if (status === "applied" || status === "reverted") {
        return changeStatuses(current, [batchId], status);
      }
      return save(current, {
        ...current.ledger,
        batches: current.ledger.batches.map((batch) =>
          batch.id === batchId
            ? {
                ...batch,
                status,
                revertedAt: null,
              }
            : batch,
        ),
      });
    },
    async applyBatchSelection(
      current: LoadedManuscriptTrackingLedger,
      batchId: string,
      selectedChangeIds: readonly string[],
      chapter: ManuscriptProjectionChapter,
    ) {
      const selected = new Set(selectedChangeIds);
      const batch = current.ledger.batches.find((item) => item.id === batchId);
      if (!batch) throw new Error("状态批次不存在");
      if (batch.status !== "proposed") throw new Error("只能确认待审阅批次");
      if (!batch.changes.some((change) => selected.has(change.id))) {
        throw new Error("请至少选择一项状态变化");
      }
      if (batch.chapterContentHash !== hashManuscriptContent(chapter.content)) {
        throw new Error("章节正文已经变化，请重新执行连续性分析");
      }
      const selectedChanges = batch.changes.filter((change) =>
        selected.has(change.id),
      );
      const order = await loadChapterOrder();
      const sequence =
        (order.get(chapter.id) ?? fallbackChapterOrder(chapter.id, order)) + 1;
      const mutations = await projection.prepareBatch(batch, selectedChanges, {
        ...chapter,
        sequence,
      });
      const now = new Date().toISOString();
      const nextLedger: ManuscriptTrackingLedger = {
        ...current.ledger,
        baselines: mutations.reduce<Record<string, unknown | null>>(
          (baselines, mutation) => {
            if (!(mutation.targetKey in baselines)) {
              baselines[mutation.targetKey] = mutation.before;
            }
            return baselines;
          },
          { ...current.ledger.baselines },
        ),
        batches: current.ledger.batches.map((item) =>
          item.id === batchId
            ? {
                ...item,
                status: "applied",
                appliedAt: now,
                revertedAt: null,
                changes: selectedChanges,
                mutations: [...mutations],
              }
            : item,
        ),
      };
      return transition(current, nextLedger, order, order);
    },
    async revertChapter(chapterId: string): Promise<readonly string[]> {
      const current = await load();
      const ids = current.ledger.batches
        .filter(
          (batch) =>
            batch.chapterId === chapterId && batch.status === "applied",
        )
        .map((batch) => batch.id);
      if (!ids.length) return [];
      await changeStatuses(current, ids, "reverted");
      return ids;
    },
    async restoreBatches(batchIds: readonly string[]): Promise<void> {
      if (!batchIds.length) return;
      const current = await load();
      await changeStatuses(current, batchIds, "applied");
    },
    async revertBatches(batchIds: readonly string[]): Promise<void> {
      if (!batchIds.length) return;
      const current = await load();
      await changeStatuses(current, batchIds, "reverted");
    },
    async replaceLedger(
      current: LoadedManuscriptTrackingLedger,
      ledger: ManuscriptTrackingLedger,
    ): Promise<LoadedManuscriptTrackingLedger> {
      const order = await loadChapterOrder();
      return transition(current, ledger, order, order);
    },
    async reorderAppliedBatches(
      currentIndex: NovelChapterIndex,
      nextIndex: NovelChapterIndex,
    ): Promise<void> {
      const currentOrder = manuscriptChapterOrderMap(
        currentIndex.directories,
        currentIndex.chapters,
      );
      const nextOrder = manuscriptChapterOrderMap(
        nextIndex.directories,
        nextIndex.chapters,
      );
      const currentIds = [...currentOrder.keys()];
      const nextIds = [...nextOrder.keys()];
      if (
        currentIds.length === nextIds.length &&
        currentIds.every((id, index) => id === nextIds[index])
      )
        return;
      const current = await load();
      await transition(current, current.ledger, currentOrder, nextOrder);
    },
  });
}
