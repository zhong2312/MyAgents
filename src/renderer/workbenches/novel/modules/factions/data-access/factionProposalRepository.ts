import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  validateFactionCrossReferences,
} from "../../../shared/business/crossLibraryReferences";
import {
  createNovelFactionLibraryRepository,
} from "./factionLibraryRepository";
import {
  factionProposalManifestPath,
  FACTION_PROPOSALS_DIRECTORY,
  parseFactionProposalManifest,
  serializeFactionProposalManifest,
  type FactionProposalManifest,
  type FactionProposalOperation,
} from "../entities/factionProposalSchema";
import type { FactionRecord } from "../entities/factionLibrarySchema";

export interface LoadedFactionProposal {
  readonly manifest: FactionProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface FactionProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface FactionProposalListResult {
  readonly proposals: readonly LoadedFactionProposal[];
  readonly errors: readonly FactionProposalLoadError[];
}

export interface NovelFactionProposalRepository {
  list(): Promise<FactionProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedFactionProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedFactionProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyFactionOperation(
  current: readonly FactionRecord[],
  operation: FactionProposalOperation,
): FactionRecord[] {
  const value = operation.value as unknown as FactionRecord;
  if (operation.action === "create") {
    if (current.some((entry) => entry.id === value.id)) {
      throw new Error(`候选要创建的势力 id 已存在：${value.id}`);
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
  if (!found) throw new Error(`候选要更新的势力 id 不存在：${targetId}`);
  return next;
}

function updateOperations(
  manifest: FactionProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): FactionProposalManifest {
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
  proposal: LoadedFactionProposal,
  manifest: FactionProposalManifest,
): Promise<LoadedFactionProposal> {
  const content = serializeFactionProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseFactionProposalManifest(proposal.manifestPath, file.content),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

export function createNovelFactionProposalRepository(
  storage: WorkbenchStorage,
): NovelFactionProposalRepository {
  const factionRepository = createNovelFactionLibraryRepository(storage);

  const load = async (proposalId: string): Promise<LoadedFactionProposal> => {
    const manifestPath = factionProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseFactionProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error("势力提案目录与 proposalId 不一致");
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  return {
    async list() {
      const [info] = await storage.stat([FACTION_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") throw new Error("势力提案路径不是目录");
      const entries = await storage.list(FACTION_PROPOSALS_DIRECTORY);
      const proposals: LoadedFactionProposal[] = [];
      const errors: FactionProposalLoadError[] = [];
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
      if (operations.length === 0) throw new Error("没有可采纳的势力候选");

      const library = await factionRepository.load();
      let factions = library.library.factions;
      for (const operation of operations) {
        factions = applyFactionOperation(factions, operation);
      }
      // 采纳前做跨库引用校验，防止把悬空引用写入正式库
      const candidateLibrary = { schemaVersion: 2 as const, factions };
      await validateFactionCrossReferences(storage, candidateLibrary);
      const saved = await factionRepository.save(library, candidateLibrary);
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
        // 正式库已写入但 manifest 更新失败：回滚正式库到采纳前状态
        try {
          await factionRepository.save(saved, library.library);
        } catch (rollbackError) {
          throw new Error(
            `势力提案采纳失败，且势力库回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
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
      if (pendingIds.size === 0) throw new Error("没有可拒绝的势力候选");
      return writeManifest(
        storage,
        proposal,
        updateOperations(proposal.manifest, pendingIds, "rejected"),
      );
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${FACTION_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}
