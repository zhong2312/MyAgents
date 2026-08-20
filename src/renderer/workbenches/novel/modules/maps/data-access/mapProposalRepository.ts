import type { WorkbenchStorage } from "@/workbench-sdk";

import { createNovelMapRepository } from "./mapRepository";
import {
  mapDocumentSchema,
  parseMapDocument,
  serializeMapDocument,
  type MapDocument,
} from "../entities/mapSchema";
import {
  mapProposalCandidatePath,
  mapProposalManifestPath,
  MAP_PROPOSALS_DIRECTORY,
  parseLegacyMapProposalManifest,
  parseMapProposalManifest,
  serializeMapProposalManifest,
  type MapProposalManifest,
  type MapProposalOperation,
} from "../entities/mapProposalSchema";

export interface LoadedMapProposal {
  readonly manifest: MapProposalManifest;
  readonly operations: readonly MapProposalOperation[];
  readonly manifestPath: string;
  readonly manifestContent: string;
  readonly legacy: boolean;
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

function decodeUtf8(content: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

async function readLargeText(
  storage: WorkbenchStorage,
  path: string,
): Promise<string> {
  return decodeUtf8(await storage.readBinary(path));
}

function withStatus(
  operation: MapProposalOperation,
  status: "applied" | "rejected",
): MapProposalOperation {
  return { ...operation, status };
}

function proposalManifestFromOperations(
  proposal: LoadedMapProposal,
  operations: readonly MapProposalOperation[],
): MapProposalManifest {
  return {
    ...proposal.manifest,
    schemaVersion: 2,
    operations: operations.map(({ value: _value, ...operation }) => ({
      ...operation,
      valuePath: `candidates/${operation.candidateId}.json`,
    })),
  };
}

function decodeSvgDataUrl(value: string): string | null {
  const prefix = "data:image/svg+xml;base64,";
  if (!value.startsWith(prefix)) return null;
  const binary = atob(value.slice(prefix.length));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/<svg[\s>]/iu.test(svg)) throw new Error("地图候选内嵌的 SVG 底图无效");
  return svg;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<void> {
  const [info] = await storage.stat([path]);
  if (!info?.exists) {
    await storage.createText(path, content, { createParents: true });
    return;
  }
  if (info.kind !== "file")
    throw new Error(`地图提案迁移路径不是文件：${path}`);
  const existing = await storage.readText(path);
  if (existing.content !== content)
    throw new Error(`地图提案迁移文件发生冲突：${path}`);
}

async function migrateLegacyProposal(
  storage: WorkbenchStorage,
  proposal: LoadedMapProposal,
): Promise<LoadedMapProposal> {
  if (!proposal.legacy) return proposal;
  const operations: MapProposalOperation[] = [];
  for (const operation of proposal.operations) {
    const map = parseMapValue(operation.value);
    let nextMap = map;
    if (map.canvas.backgroundImage) {
      const svg = decodeSvgDataUrl(map.canvas.backgroundImage);
      if (svg) {
        const assetPath = `${MAP_PROPOSALS_DIRECTORY}/${proposal.manifest.proposalId}/assets/${operation.candidateId}.svg`;
        await ensureTextFile(storage, assetPath, svg);
        nextMap = {
          ...map,
          canvas: {
            ...map.canvas,
            backgroundImage: null,
            backgroundAssetPath: assetPath,
          },
        };
      }
    }
    await ensureTextFile(
      storage,
      mapProposalCandidatePath(
        proposal.manifest.proposalId,
        operation.candidateId,
      ),
      serializeMapDocument(nextMap),
    );
    operations.push({ ...operation, value: nextMap });
  }
  const manifest = proposalManifestFromOperations(proposal, operations);
  const content = serializeMapProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseMapProposalManifest(proposal.manifestPath, file.content),
    operations,
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
    legacy: false,
  };
}

async function writeProposalState(
  storage: WorkbenchStorage,
  proposal: LoadedMapProposal,
  operations: readonly MapProposalOperation[],
): Promise<LoadedMapProposal> {
  const manifest = proposalManifestFromOperations(proposal, operations);
  const content = serializeMapProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseMapProposalManifest(proposal.manifestPath, file.content),
    operations,
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
    legacy: false,
  };
}

async function promoteBackgroundAsset(
  storage: WorkbenchStorage,
  map: MapDocument,
): Promise<MapDocument> {
  const path = map.canvas.backgroundAssetPath;
  if (!path?.startsWith(`${MAP_PROPOSALS_DIRECTORY}/`)) return map;
  const targetDirectory = `world/maps/assets/${map.id}`;
  const fileName = path.split("/").at(-1);
  if (!fileName) throw new Error("地图底图资源路径缺少文件名");
  const targetPath = `${targetDirectory}/${fileName}`;
  await storage.createDirectory(targetDirectory);

  const sameContent = async (leftPath: string, rightPath: string) => {
    const [left, right] = await Promise.all([
      storage.readBinary(leftPath),
      storage.readBinary(rightPath),
    ]);
    if (left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  };

  const [existing] = await storage.stat([targetPath]);
  if (existing?.exists) {
    if (existing.kind !== "file") {
      throw new Error(`地图底图目标路径不是文件：${targetPath}`);
    }
    if (!(await sameContent(path, targetPath))) {
      throw new Error(`地图底图目标路径已存在不同内容：${targetPath}`);
    }
    return {
      ...map,
      canvas: { ...map.canvas, backgroundAssetPath: targetPath },
    };
  }

  const copied = await storage.copy([path], targetDirectory);
  if (copied.errors.length > 0 || copied.transfers.length !== 1) {
    throw new Error(copied.errors.join("；") || "地图底图资源复制失败");
  }
  const copiedPath = copied.transfers[0]!.targetPath;
  if (copiedPath !== targetPath) {
    const reusable = await sameContent(path, targetPath).catch(() => false);
    await storage.remove(copiedPath, { permanent: true }).catch(() => false);
    if (!reusable) {
      throw new Error(`地图底图目标路径在复制时发生冲突：${targetPath}`);
    }
  }
  return {
    ...map,
    canvas: {
      ...map.canvas,
      backgroundAssetPath: targetPath,
    },
  };
}

export function createNovelMapProposalRepository(
  storage: WorkbenchStorage,
): NovelMapProposalRepository {
  const mapRepository = createNovelMapRepository(storage);

  const load = async (proposalId: string): Promise<LoadedMapProposal> => {
    const manifestPath = mapProposalManifestPath(proposalId);
    let manifestContent: string;
    try {
      manifestContent = (await storage.readText(manifestPath)).content;
    } catch (error) {
      if (!/too large|previewable text file/iu.test(errorMessage(error))) {
        throw error;
      }
      manifestContent = await readLargeText(storage, manifestPath);
    }

    const parsed = JSON.parse(manifestContent) as { schemaVersion?: unknown };
    if (parsed.schemaVersion === 1) {
      const legacy = parseLegacyMapProposalManifest(
        manifestPath,
        manifestContent,
      );
      if (legacy.proposalId !== proposalId) {
        throw new Error("地图提案目录与 proposalId 不一致");
      }
      // v1 清单的通用 operation schema 只约束 value 为对象；在返回审阅层
      // 之前就解析成 MapDocument，避免坏候选直到点击采纳才暴露，或让预览
      // 组件把任意对象误当成地图事实。
      const operations = legacy.operations.map((operation) => ({
        ...operation,
        value: parseMapValue(operation.value),
      }));
      const manifest: MapProposalManifest = {
        ...legacy,
        schemaVersion: 2,
        operations: legacy.operations.map(
          ({ value: _value, ...operation }) => ({
            ...operation,
            valuePath: `candidates/${operation.candidateId}.json`,
          }),
        ),
      };
      return {
        manifest,
        operations,
        manifestPath,
        manifestContent,
        legacy: true,
      };
    }

    const manifest = parseMapProposalManifest(manifestPath, manifestContent);
    if (manifest.proposalId !== proposalId) {
      throw new Error("地图提案目录与 proposalId 不一致");
    }
    const operations = await Promise.all(
      manifest.operations.map(async (reference) => {
        const path = `${MAP_PROPOSALS_DIRECTORY}/${proposalId}/${reference.valuePath}`;
        let content: string;
        try {
          content = (await storage.readText(path)).content;
        } catch (error) {
          if (!/too large|previewable text file/iu.test(errorMessage(error))) {
            throw error;
          }
          content = await readLargeText(storage, path);
        }
        return {
          ...reference,
          value: parseMapDocument(path, content),
        } satisfies MapProposalOperation;
      }),
    );
    return {
      manifest,
      operations,
      manifestPath,
      manifestContent,
      legacy: false,
    };
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
      const proposal = await migrateLegacyProposal(
        storage,
        await load(proposalId),
      );
      const selectedIds = new Set(candidateIds);
      const selected = proposal.operations.filter(
        (operation) =>
          operation.status === "pending" &&
          selectedIds.has(operation.candidateId),
      );
      if (selected.length === 0) throw new Error("没有可采纳的地图候选");

      const index = await mapRepository.loadIndex();
      for (const operation of selected) {
        const value = await promoteBackgroundAsset(
          storage,
          parseMapValue(operation.value),
        );
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
          await mapRepository.saveMap(current, {
            ...current.map,
            ...value,
            id: targetId,
          });
        }
      }

      const appliedIds = new Set(
        selected.map((operation) => operation.candidateId),
      );
      return writeProposalState(
        storage,
        proposal,
        proposal.operations.map((operation) =>
          appliedIds.has(operation.candidateId)
            ? withStatus(operation, "applied")
            : operation,
        ),
      );
    },

    async reject(proposalId, candidateIds) {
      const proposal = await migrateLegacyProposal(
        storage,
        await load(proposalId),
      );
      const selectedIds = new Set(candidateIds);
      const pendingIds = new Set(
        proposal.operations
          .filter(
            (operation) =>
              operation.status === "pending" &&
              selectedIds.has(operation.candidateId),
          )
          .map((operation) => operation.candidateId),
      );
      if (pendingIds.size === 0) throw new Error("没有可拒绝的地图候选");
      return writeProposalState(
        storage,
        proposal,
        proposal.operations.map((operation) =>
          pendingIds.has(operation.candidateId)
            ? withStatus(operation, "rejected")
            : operation,
        ),
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

export { parseMapDocument, serializeMapDocument };
