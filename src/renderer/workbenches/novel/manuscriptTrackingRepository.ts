import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  MANUSCRIPT_TRACKING_INDEX_PATH,
  MANUSCRIPT_TRACKING_LEGACY_PATH,
  createManuscriptTrackingFiles,
  loadManuscriptTrackingFiles,
  manuscriptTrackingFileMap,
  serializeManuscriptTrackingFileSnapshot,
} from "../../../shared/workbenches/novel/manuscriptTrackingStorage";
import {
  createEmptyManuscriptTrackingLedger,
  parseManuscriptTrackingLedger,
  serializeManuscriptTrackingLedger,
  type ManuscriptTrackingBatch,
  type ManuscriptTrackingChange,
  type ManuscriptTrackingLedger,
  type ManuscriptTrackingMutation,
} from "./manuscriptTrackingSchema";
import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";
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
  /** 已读取的完整账本目录快照，用于保存时的 CAS。 */
  readonly content: string;
  readonly files: ReadonlyMap<string, string>;
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

export function createManuscriptTrackingInitializationFiles(
  now = new Date().toISOString(),
): readonly { readonly path: string; readonly content: string }[] {
  return createManuscriptTrackingFiles(
    createEmptyManuscriptTrackingLedger(now),
  );
}

export function createManuscriptTrackingRepository(storage: WorkbenchStorage) {
  const projection = createManuscriptTrackingProjection(storage);

  const loadFiles = async (): Promise<LoadedManuscriptTrackingLedger> => {
    const loaded = await loadManuscriptTrackingFiles(
      async (path) => (await storage.readText(path)).content,
    );
    return Object.freeze({
      ledger: parseManuscriptTrackingLedger(JSON.stringify(loaded.ledger)),
      content: serializeManuscriptTrackingFileSnapshot(loaded.files),
      files: loaded.files,
    });
  };

  const load = async (): Promise<LoadedManuscriptTrackingLedger> => {
    const [index, legacy] = await storage.stat([
      MANUSCRIPT_TRACKING_INDEX_PATH,
      MANUSCRIPT_TRACKING_LEGACY_PATH,
    ]);
    if (!index?.exists) {
      if (legacy?.exists) {
        throw new Error(
          `${MANUSCRIPT_TRACKING_LEGACY_PATH} 是旧单文件正文状态账本；当前目录协议不兼容且不迁移`,
        );
      }
      const transaction = createStorageTransaction(storage);
      for (const file of createManuscriptTrackingInitializationFiles()) {
        transaction.createText(file.path, file.content);
      }
      await transaction.commit();
    } else if (index.kind !== "file") {
      throw new Error(`${MANUSCRIPT_TRACKING_INDEX_PATH} 不是文件`);
    }
    return loadFiles();
  };

  const save = async (
    current: LoadedManuscriptTrackingLedger,
    ledger: ManuscriptTrackingLedger,
  ): Promise<LoadedManuscriptTrackingLedger> => {
    const normalized: ManuscriptTrackingLedger = {
      ...ledger,
      updatedAt: new Date().toISOString(),
    };
    const parsed = parseManuscriptTrackingLedger(
      serializeManuscriptTrackingLedger(normalized),
    );
    const onDisk = await loadManuscriptTrackingFiles(
      async (path) => (await storage.readText(path)).content,
    );
    if (
      serializeManuscriptTrackingFileSnapshot(onDisk.files) !== current.content
    ) {
      throw new Error("正文状态账本已被外部修改，请重新加载后再保存");
    }
    const nextFiles = manuscriptTrackingFileMap(
      createManuscriptTrackingFiles(parsed),
    );
    const transaction = createStorageTransaction(storage);
    const orderedPaths = [...nextFiles.keys()].sort((left, right) => {
      if (left === MANUSCRIPT_TRACKING_INDEX_PATH) return 1;
      if (right === MANUSCRIPT_TRACKING_INDEX_PATH) return -1;
      return left.localeCompare(right);
    });
    for (const path of orderedPaths) {
      const content = nextFiles.get(path);
      if (content === undefined) continue;
      const previous = onDisk.files.get(path);
      if (previous === content) continue;
      if (previous === undefined) transaction.createText(path, content);
      else transaction.writeText(path, content, previous);
    }
    await transaction.commit();
    const removedPaths = [...onDisk.files.keys()].filter(
      (path) => !nextFiles.has(path),
    );
    await Promise.allSettled(
      removedPaths.map((path) => storage.remove(path, { permanent: true })),
    );
    return loadFiles();
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
