import type { WorkbenchStorage } from "@/workbench-sdk";

import { timelineRecordPath } from "../../../../../../shared/workbenches/novel/timelineStorage";
import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalRepository,
} from "../../../shared/business/fileProposal";
import { validateTimelineCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createNovelTimelineLibraryRepository,
  type LoadedTimelineLibrary,
} from "./timelineLibraryRepository";
import {
  parseTimelineLibrary,
  timelineEventSchema,
  type TimelineEvent,
} from "../entities/timelineLibrarySchema";
import {
  parseTimelineProposalManifest,
  serializeTimelineProposalManifest,
  timelineProposalManifestPath,
  TIMELINE_PROPOSALS_DIRECTORY,
  type TimelineProposalManifest,
  type TimelineProposalOperation,
} from "../entities/timelineProposalSchema";

export interface LoadedTimelineProposal {
  readonly manifest: TimelineProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface TimelineProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface TimelineProposalListResult {
  readonly proposals: readonly LoadedTimelineProposal[];
  readonly errors: readonly TimelineProposalLoadError[];
}

export interface NovelTimelineProposalRepository {
  list(): Promise<TimelineProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedTimelineProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedTimelineProposal>;
  delete(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedTimelineProposal | null>;
  resolveConflict(
    proposalId: string,
    candidateId: string,
    resolution: FileProposalConflictResolution,
  ): Promise<LoadedTimelineProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function operationTargetId(operation: TimelineProposalOperation): string {
  if (operation.action === "update") {
    if (!operation.targetId) throw new Error("更新候选缺少 targetId");
    return operation.targetId;
  }
  const id = operation.value.id;
  if (typeof id !== "string") throw new Error("新建候选缺少事件 id");
  return id;
}

function operationTargetPath(
  operation: TimelineProposalOperation,
  targetId: string,
): string {
  try {
    return timelineRecordPath("events", targetId);
  } catch {
    return timelineRecordPath("events", operation.candidateId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTimelineCandidate(
  operation: TimelineProposalOperation,
  fallback: TimelineEvent | undefined,
  proposalCreatedAt?: string,
  override?: unknown,
): TimelineEvent {
  let source: unknown = override;
  if (source === undefined) {
    const base =
      operation.action === "update" && operation.baseValue
        ? operation.baseValue
        : fallback;
    source = base ? { ...base, ...operation.value } : operation.value;
  }
  if (isRecord(source)) {
    if (operation.action === "create") {
      source = {
        ...source,
        createdAt: source.createdAt ?? proposalCreatedAt,
        updatedAt: source.updatedAt ?? proposalCreatedAt,
      };
    } else {
      const auditSource =
        fallback ??
        (isRecord(operation.baseValue) ? operation.baseValue : undefined);
      source = {
        ...source,
        createdAt:
          auditSource?.createdAt ?? source.createdAt ?? proposalCreatedAt,
        updatedAt:
          auditSource?.updatedAt ?? source.updatedAt ?? proposalCreatedAt,
      };
    }
  }
  const parsed = timelineEventSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `时间线候选“${operation.summary}”格式无效：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  const targetId = operationTargetId(operation);
  if (parsed.data.id !== targetId) {
    throw new Error(
      `时间线候选“${operation.summary}”不能把稳定 ID 从 ${targetId} 改为 ${parsed.data.id}`,
    );
  }
  return parsed.data;
}

function parseBaseEvent(
  operation: TimelineProposalOperation,
  proposalCreatedAt?: string,
): TimelineEvent | null | undefined {
  if (operation.action === "create") return null;
  if (operation.baseValue === undefined) return undefined;
  if (operation.baseValue === null) {
    throw new Error(`更新候选“${operation.summary}”的生成基准不能为空`);
  }
  return parseTimelineCandidate(
    operation,
    undefined,
    proposalCreatedAt,
    operation.baseValue,
  );
}

function findCurrentEvent(
  operation: TimelineProposalOperation,
  current: LoadedTimelineLibrary,
): TimelineEvent | undefined {
  const targetId = operationTargetId(operation);
  return current.library.events.find((event) => event.id === targetId);
}

function operationConflicts(
  operation: TimelineProposalOperation,
  currentEvent: TimelineEvent | undefined,
): boolean {
  if (operation.action === "create") return currentEvent !== undefined;
  const base = parseBaseEvent(operation);
  if (base === undefined || currentEvent === undefined) return true;
  return JSON.stringify(currentEvent) !== JSON.stringify(base);
}

function updateOperations(
  manifest: TimelineProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): TimelineProposalManifest {
  return {
    ...manifest,
    operations: manifest.operations.map((operation) =>
      operation.status === "pending" && candidateIds.has(operation.candidateId)
        ? { ...operation, status }
        : operation,
    ),
  };
}

async function writeManifest(
  storage: WorkbenchStorage,
  proposal: LoadedTimelineProposal,
  manifest: TimelineProposalManifest,
): Promise<LoadedTimelineProposal> {
  const content = serializeTimelineProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseTimelineProposalManifest(
      proposal.manifestPath,
      file.content,
    ),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

function selectedPendingOperations(
  manifest: TimelineProposalManifest,
  candidateIds: readonly string[],
): readonly TimelineProposalOperation[] {
  const selectedIds = new Set(candidateIds);
  return manifest.operations.filter(
    (operation) =>
      operation.status === "pending" && selectedIds.has(operation.candidateId),
  );
}

function asFileProposal(
  proposal: LoadedTimelineProposal,
  current: LoadedTimelineLibrary,
  dependencyError: string | null = null,
): FileProposal {
  const changes: FileProposalChange[] = proposal.manifest.operations.map(
    (operation) => {
      let targetId = operation.candidateId;
      let currentEvent: TimelineEvent | undefined;
      let beforeContent = "";
      let afterContent = json(operation.value);
      let conflict = false;
      let loadError: string | null = null;
      try {
        targetId = operationTargetId(operation);
        currentEvent = findCurrentEvent(operation, current);
        const base = parseBaseEvent(operation, proposal.manifest.createdAt);
        const after = parseTimelineCandidate(
          operation,
          base ?? currentEvent,
          proposal.manifest.createdAt,
        );
        beforeContent = base ? json(base) : "";
        afterContent = json(after);
        conflict =
          operation.status === "pending" &&
          operationConflicts(operation, currentEvent);
      } catch (error) {
        loadError = errorMessage(error);
      }
      if (!loadError && operation.status === "pending" && dependencyError) {
        loadError = dependencyError;
      }
      return {
        id: operation.candidateId,
        targetPath: operationTargetPath(operation, targetId),
        operation: operation.action === "create" ? "create" : "modify",
        summary: operation.summary,
        status: operation.status,
        beforeContent,
        afterContent,
        currentContent: currentEvent ? json(currentEvent) : null,
        baseContentAvailable:
          operation.action === "create" || operation.baseValue !== undefined,
        conflict,
        loadError,
        inferred: false,
      };
    },
  );
  return {
    manifest: {
      proposalId: proposal.manifest.proposalId,
      title: proposal.manifest.title,
      description: proposal.manifest.description,
      createdAt: proposal.manifest.createdAt,
      changes: changes.map((change) => ({ status: change.status })),
    },
    changes,
  };
}

function operationEventReferenceIds(
  operation: TimelineProposalOperation,
): readonly string[] {
  const causes = Array.isArray(operation.value.causeEventIds)
    ? operation.value.causeEventIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const foreshadowings = Array.isArray(operation.value.foreshadowings)
    ? operation.value.foreshadowings
    : [];
  const payoffIds = foreshadowings.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const payoffEventId = (entry as { payoffEventId?: unknown }).payoffEventId;
    return typeof payoffEventId === "string" ? [payoffEventId] : [];
  });
  return [...new Set([...causes, ...payoffIds])];
}

function referencesEventId(
  operation: TimelineProposalOperation,
  targetId: string,
): boolean {
  return operationEventReferenceIds(operation).includes(targetId);
}

function assertEventReferencesExist(events: readonly TimelineEvent[]): void {
  const eventIds = new Set(events.map((event) => event.id));
  const missing = new Set<string>();
  for (const event of events) {
    for (const referenceId of [
      ...event.causeEventIds,
      ...event.foreshadowings.flatMap((item) =>
        item.payoffEventId ? [item.payoffEventId] : [],
      ),
    ]) {
      if (!eventIds.has(referenceId)) missing.add(referenceId);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `时间线提案依赖的事件尚未采纳或不存在：${[...missing].join("、")}。请先审阅并应用包含这些事件的前置提案`,
    );
  }
}

function analyzeProposalDependencies(
  proposals: readonly LoadedTimelineProposal[],
  current: LoadedTimelineLibrary,
): {
  readonly ordered: readonly LoadedTimelineProposal[];
  readonly errors: ReadonlyMap<string, string>;
} {
  const formalIds = new Set(current.library.events.map((event) => event.id));
  const providers = new Map<
    string,
    { readonly proposalId: string; readonly title: string }
  >();
  for (const proposal of proposals) {
    for (const operation of proposal.manifest.operations) {
      if (operation.status !== "pending" || operation.action !== "create") {
        continue;
      }
      const id = operation.value.id;
      if (typeof id === "string") {
        providers.set(id, {
          proposalId: proposal.manifest.proposalId,
          title: proposal.manifest.title,
        });
      }
    }
  }

  const dependencies = new Map<string, Set<string>>();
  const errors = new Map<string, string>();
  for (const proposal of proposals) {
    const ownPendingIds = new Set(
      proposal.manifest.operations.flatMap((operation) => {
        const id = operation.value.id;
        return operation.status === "pending" &&
          operation.action === "create" &&
          typeof id === "string"
          ? [id]
          : [];
      }),
    );
    const dependencyTitles = new Map<string, Set<string>>();
    const missingIds = new Set<string>();
    for (const operation of proposal.manifest.operations) {
      if (operation.status !== "pending") continue;
      for (const referenceId of operationEventReferenceIds(operation)) {
        if (formalIds.has(referenceId) || ownPendingIds.has(referenceId)) {
          continue;
        }
        const provider = providers.get(referenceId);
        if (provider && provider.proposalId !== proposal.manifest.proposalId) {
          const ids = dependencyTitles.get(provider.title) ?? new Set<string>();
          ids.add(referenceId);
          dependencyTitles.set(provider.title, ids);
          const proposalDependencies =
            dependencies.get(proposal.manifest.proposalId) ?? new Set<string>();
          proposalDependencies.add(provider.proposalId);
          dependencies.set(proposal.manifest.proposalId, proposalDependencies);
        } else {
          missingIds.add(referenceId);
        }
      }
    }

    const messages: string[] = [];
    if (dependencyTitles.size > 0) {
      messages.push(
        `该提案依赖尚未采纳的前置提案：${[...dependencyTitles.entries()]
          .map(([title, ids]) => `“${title}”（${[...ids].join("、")}）`)
          .join("；")}。请先审阅并应用前置提案`,
      );
    }
    if (missingIds.size > 0) {
      messages.push(`该提案引用了不存在的事件：${[...missingIds].join("、")}`);
    }
    if (messages.length > 0) {
      errors.set(proposal.manifest.proposalId, messages.join("；"));
    }
  }

  const byId = new Map(
    proposals.map((proposal) => [proposal.manifest.proposalId, proposal]),
  );
  const ordered: LoadedTimelineProposal[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (proposal: LoadedTimelineProposal) => {
    const proposalId = proposal.manifest.proposalId;
    if (visited.has(proposalId) || visiting.has(proposalId)) return;
    visiting.add(proposalId);
    for (const dependencyId of dependencies.get(proposalId) ?? []) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(proposalId);
    visited.add(proposalId);
    ordered.push(proposal);
  };
  proposals.forEach(visit);
  return { ordered, errors };
}

export function createNovelTimelineProposalRepository(
  storage: WorkbenchStorage,
): NovelTimelineProposalRepository {
  const timelineRepository = createNovelTimelineLibraryRepository(storage);

  const load = async (proposalId: string): Promise<LoadedTimelineProposal> => {
    const manifestPath = timelineProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseTimelineProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error("时间线提案目录与 proposalId 不一致");
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  const applyOperations = async (
    proposal: LoadedTimelineProposal,
    operations: readonly TimelineProposalOperation[],
    current: LoadedTimelineLibrary,
    overrides: ReadonlyMap<string, TimelineEvent> = new Map(),
    resolvedConflictIds: ReadonlySet<string> = new Set(),
  ): Promise<LoadedTimelineProposal> => {
    let events = [...current.library.events];
    for (const operation of operations) {
      const targetId = operationTargetId(operation);
      const existing = events.find((event) => event.id === targetId);
      const candidate =
        overrides.get(operation.candidateId) ??
        parseTimelineCandidate(
          operation,
          existing,
          proposal.manifest.createdAt,
        );
      const value =
        operation.action === "update" && existing
          ? {
              ...candidate,
              createdAt: existing.createdAt,
              updatedAt: new Date().toISOString(),
            }
          : candidate;
      if (operation.action === "create") {
        if (existing) {
          if (!resolvedConflictIds.has(operation.candidateId)) {
            throw new Error(`候选要创建的事件 id 已存在：${targetId}`);
          }
          events = events.map((event) =>
            event.id === targetId ? value : event,
          );
        } else {
          events.push(value);
        }
      } else {
        if (!existing) {
          throw new Error(`候选要更新的事件 id 不存在：${targetId}`);
        }
        events = events.map((event) => (event.id === targetId ? value : event));
      }
    }

    assertEventReferencesExist(events);
    const candidateLibrary = parseTimelineLibrary(
      JSON.stringify({ ...current.library, events }),
    );
    await validateTimelineCrossReferences(storage, candidateLibrary);
    const saved = await timelineRepository.save(current, candidateLibrary);
    try {
      return await writeManifest(
        storage,
        proposal,
        updateOperations(
          proposal.manifest,
          new Set(operations.map((operation) => operation.candidateId)),
          "applied",
        ),
      );
    } catch (error) {
      try {
        await timelineRepository.save(saved, current.library);
      } catch (rollbackError) {
        throw new Error(
          `时间线提案采纳失败，且时间线回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
  };

  return {
    async list() {
      const [info] = await storage.stat([TIMELINE_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") throw new Error("时间线提案路径不是目录");
      const entries = await storage.list(TIMELINE_PROPOSALS_DIRECTORY);
      const proposals: LoadedTimelineProposal[] = [];
      const errors: TimelineProposalLoadError[] = [];
      for (const entry of entries) {
        if (entry.kind !== "directory") continue;
        try {
          proposals.push(await load(entry.name));
        } catch (error) {
          errors.push({ proposalId: entry.name, message: errorMessage(error) });
        }
      }
      proposals.sort((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt),
      );
      return { proposals, errors };
    },

    async apply(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const operations = selectedPendingOperations(
        proposal.manifest,
        candidateIds,
      );
      if (operations.length === 0) throw new Error("没有可采纳的时间线候选");
      const current = await timelineRepository.load();
      for (const operation of operations) {
        if (
          operationConflicts(operation, findCurrentEvent(operation, current))
        ) {
          throw new Error(
            `时间线候选“${operation.summary}”的正式内容已变化，请先解决冲突`,
          );
        }
      }
      return applyOperations(proposal, operations, current);
    },

    async resolveConflict(proposalId, candidateId, resolution) {
      const proposal = await load(proposalId);
      const operation = proposal.manifest.operations.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      if (!operation) throw new Error("时间线候选不存在");
      if (operation.status !== "pending") {
        throw new Error("已处理的时间线候选不能再次解决冲突");
      }
      const current = await timelineRepository.load();
      const currentEvent = findCurrentEvent(operation, current);
      const currentContent = currentEvent ? json(currentEvent) : null;
      if (currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式时间线在冲突处理期间再次变化，请重新读取后再处理");
      }
      if (!operationConflicts(operation, currentEvent)) {
        throw new Error("正式时间线当前没有冲突，请直接应用提案");
      }

      let value: TimelineEvent;
      if (resolution.strategy === "merge") {
        let merged: unknown;
        try {
          merged = JSON.parse(resolution.content) as unknown;
        } catch (error) {
          throw new Error(`合并结果不是有效 JSON：${errorMessage(error)}`);
        }
        value = parseTimelineCandidate(
          operation,
          currentEvent,
          proposal.manifest.createdAt,
          merged,
        );
      } else {
        value = parseTimelineCandidate(
          operation,
          currentEvent,
          proposal.manifest.createdAt,
        );
      }
      return applyOperations(
        proposal,
        [operation],
        current,
        new Map([[operation.candidateId, value]]),
        new Set([operation.candidateId]),
      );
    },

    async reject(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const operations = selectedPendingOperations(
        proposal.manifest,
        candidateIds,
      );
      if (operations.length === 0) throw new Error("没有可拒绝的时间线候选");
      return writeManifest(
        storage,
        proposal,
        updateOperations(
          proposal.manifest,
          new Set(operations.map((operation) => operation.candidateId)),
          "rejected",
        ),
      );
    },

    async delete(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const operations = selectedPendingOperations(
        proposal.manifest,
        candidateIds,
      );
      if (operations.length === 0) throw new Error("没有可删除的时间线候选");
      const selectedIds = new Set(
        operations.map((operation) => operation.candidateId),
      );
      const current = await timelineRepository.load();
      const formalIds = new Set(
        current.library.events.map((event) => event.id),
      );
      const removedTransientIds = operations.flatMap((operation) => {
        const id = operation.value.id;
        return operation.action === "create" &&
          typeof id === "string" &&
          !formalIds.has(id)
          ? [id]
          : [];
      });
      const remaining = proposal.manifest.operations.filter(
        (operation) => !selectedIds.has(operation.candidateId),
      );
      for (const targetId of removedTransientIds) {
        const dependent = remaining.find(
          (operation) =>
            operation.status !== "rejected" &&
            referencesEventId(operation, targetId),
        );
        if (dependent) {
          throw new Error(
            `不能删除时间线候选 ${targetId}：候选“${dependent.summary}”仍引用它`,
          );
        }
      }
      if (remaining.length === 0) {
        await storage.remove(`${TIMELINE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
        return null;
      }
      return writeManifest(storage, proposal, {
        ...proposal.manifest,
        operations: remaining,
      });
    },

    async deleteProposals(proposalIds) {
      const ids = [...new Set(proposalIds)];
      if (ids.length === 0) throw new Error("请至少选择一份待删除的时间线提案");
      ids.forEach(timelineProposalManifestPath);
      for (const proposalId of ids) {
        await storage.remove(`${TIMELINE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}

/** 将事件对象候选投影到世界架构使用的统一文件提案审阅契约。 */
export function createTimelineFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const proposalRepository = createNovelTimelineProposalRepository(storage);
  const timelineRepository = createNovelTimelineLibraryRepository(storage);

  const materialize = async (
    proposal: LoadedTimelineProposal,
  ): Promise<FileProposal> =>
    asFileProposal(proposal, await timelineRepository.load());

  const repository: FileProposalRepository = {
    async list() {
      const [result, current] = await Promise.all([
        proposalRepository.list(),
        timelineRepository.load(),
      ]);
      const analyzed = analyzeProposalDependencies(result.proposals, current);
      return {
        proposals: analyzed.ordered.map((proposal) =>
          asFileProposal(
            proposal,
            current,
            analyzed.errors.get(proposal.manifest.proposalId) ?? null,
          ),
        ),
        errors: result.errors,
      };
    },
    async deleteProposals(proposalIds) {
      await proposalRepository.deleteProposals(proposalIds);
    },
    async apply(proposalId, changeIds, projectTitle) {
      void projectTitle;
      return materialize(await proposalRepository.apply(proposalId, changeIds));
    },
    async reject(proposalId, changeIds) {
      return materialize(
        await proposalRepository.reject(proposalId, changeIds),
      );
    },
    async delete(proposalId, changeIds) {
      const proposal = await proposalRepository.delete(proposalId, changeIds);
      return proposal ? materialize(proposal) : null;
    },
    async resolveConflict(proposalId, changeId, resolution, projectTitle) {
      void projectTitle;
      return materialize(
        await proposalRepository.resolveConflict(
          proposalId,
          changeId,
          resolution,
        ),
      );
    },
  };
  return Object.freeze(repository);
}
