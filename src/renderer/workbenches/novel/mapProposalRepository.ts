import type { WorkbenchStorage } from "@/workbench-sdk";

import { createNovelMapRepository } from "./mapRepository";
import {
  mapDocumentSchema,
  parseMapDocument,
  serializeMapDocument,
  type MapDocument,
} from "./mapSchema";
import {
  mapProposalManifestPath,
  MAP_PROPOSALS_DIRECTORY,
  parseMapProposalManifest,
  serializeMapProposalManifest,
  type MapProposalManifest,
} from "./mapProposalSchema";

export interface LoadedMapProposal {
  readonly manifest: MapProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface MapProposalListResult {
  readonly proposals: readonly LoadedMapProposal[];
  readonly errors: readonly { proposalId: string; message: string }[];
}

export interface NovelMapProposalRepository {
  list(): Promise<MapProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedMapProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedMapProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMapValue(value: unknown): MapDocument {
  return mapDocumentSchema.parse(value);
}

function updateOperations(
  manifest: MapProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): MapProposalManifest {
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
  proposal: LoadedMapProposal,
  manifest: MapProposalManifest,
): Promise<LoadedMapProposal> {
  const content = serializeMapProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseMapProposalManifest(proposal.manifestPath, file.content),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

export function createNovelMapProposalRepository(
  storage: WorkbenchStorage,
): NovelMapProposalRepository {
  const mapRepository = createNovelMapRepository(storage);

  const load = async (proposalId: string): Promise<LoadedMapProposal> => {
    const manifestPath = mapProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseMapProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error("地图提案目录与 proposalId 不一致");
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  return {
    async list() {
      const [info] = await storage.stat([MAP_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") throw new Error("地图提案路径不是目录");
      const entries = await storage.list(MAP_PROPOSALS_DIRECTORY);
      const proposals: LoadedMapProposal[] = [];
      const errors: { proposalId: string; message: string }[] = [];
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
      if (operations.length === 0) throw new Error("没有可采纳的地图候选");

      const index = await mapRepository.loadIndex();
      for (const operation of operations) {
        const value = parseMapValue(operation.value);
        const targetId = operation.targetId;
        if (operation.action === "create") {
          if (index.index.maps.some((entry) => entry.id === value.id)) {
            throw new Error(`候选要创建的地图 id 已存在：${value.id}`);
          }
          await mapRepository.createMap({
            id: value.id,
            name: value.name,
            projectionType: value.projectionType,
          });
          const created = await mapRepository.loadMap(value.id);
          await mapRepository.saveMap(created, {
            ...value,
            id: created.map.id,
            layers: value.layers.length > 0 ? value.layers : created.map.layers,
          });
        } else {
          if (!targetId) throw new Error("更新候选缺少 targetId");
          const current = await mapRepository.loadMap(targetId);
          const merged: MapDocument = {
            ...current.map,
            ...value,
            id: targetId,
          };
          await mapRepository.saveMap(current, merged);
        }
      }

      return writeManifest(
        storage,
        proposal,
        updateOperations(
          proposal.manifest,
          new Set(operations.map((operation) => operation.candidateId)),
          "applied",
        ),
      );
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
      if (pendingIds.size === 0) throw new Error("没有可拒绝的地图候选");
      return writeManifest(
        storage,
        proposal,
        updateOperations(proposal.manifest, pendingIds, "rejected"),
      );
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${MAP_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}

// 保持 parseMapDocument/serializeMapDocument 引用（服务端提案路径复用）
export { parseMapDocument, serializeMapDocument };
