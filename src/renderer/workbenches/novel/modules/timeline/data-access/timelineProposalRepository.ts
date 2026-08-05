import type { WorkbenchStorage } from "@/workbench-sdk";

import { validateTimelineCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createNovelTimelineLibraryRepository,
} from "./timelineLibraryRepository";
import {
  type TimelineEvent,
  type TimelineLibrary,
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
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyEventOperation(
  current: readonly TimelineEvent[],
  operation: TimelineProposalOperation,
): TimelineEvent[] {
  const value = operation.value as unknown as TimelineEvent;
  if (operation.action === "create") {
    if (current.some((entry) => entry.id === value.id)) {
      throw new Error(`候选要创建的事件 id 已存在：${value.id}`);
    }
    return [...current, value];
  }
  const targetId = operation.targetId;
  if (!targetId) throw new Error("更新候选缺少 targetId");
  let found = false;
  const next = current.map((entry) => {
    if (entry.id !== targetId) return entry;
    found = true;
    return { ...entry, ...value, id: targetId };
  });
  if (!found) throw new Error(`候选要更新的事件 id 不存在：${targetId}`);
  return next;
}

function updateOperations(
  manifest: TimelineProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): TimelineProposalManifest {
  return {
    ...manifest,
    operations: manifest.operations.map((operation) =>
      candidateIds.has(operation.candidateId)
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
    manifest: parseTimelineProposalManifest(proposal.manifestPath, file.content),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
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
      const selectedIds = new Set(candidateIds);
      const operations = proposal.manifest.operations.filter(
        (operation) =>
          operation.status === "pending" &&
          selectedIds.has(operation.candidateId),
      );
      if (operations.length === 0) throw new Error("没有可采纳的时间线候选");

      const library = await timelineRepository.load();
      let events = library.library.events;
      for (const operation of operations) {
        events = applyEventOperation(events, operation);
      }
      // 采纳前做跨库引用校验，防止把悬空引用写入正式库
      const candidateLibrary: TimelineLibrary = {
        ...library.library,
        events,
      };
      await validateTimelineCrossReferences(storage, candidateLibrary);
      const saved = await timelineRepository.save(library, candidateLibrary);
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
        // 正式库已写入但 manifest 更新失败：回滚正式库
        try {
          await timelineRepository.save(saved, library.library);
        } catch (rollbackError) {
          throw new Error(
            `时间线提案采纳失败，且时间线回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
    },

    async reject(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const selectedIds = new Set(candidateIds);
      const pendingIds = new Set(
        proposal.manifest.operations
          .filter(
            (operation) =>
              operation.status === "pending" &&
              selectedIds.has(operation.candidateId),
          )
          .map((operation) => operation.candidateId),
      );
      if (pendingIds.size === 0) throw new Error("没有可拒绝的时间线候选");
      return writeManifest(
        storage,
        proposal,
        updateOperations(proposal.manifest, pendingIds, "rejected"),
      );
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${TIMELINE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}
