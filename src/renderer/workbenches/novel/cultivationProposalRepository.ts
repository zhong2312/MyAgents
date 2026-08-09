import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  loadCultivationEcologyFiles,
  CULTIVATION_ECOLOGY_INDEX_PATH,
} from "../../../shared/workbenches/novel/cultivationEcologyStorage";
import { validateCultivationEcology } from "../../../shared/workbenches/novel/cultivationEcologyValidation";
import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalLoadError,
  FileProposalRepository,
} from "./fileProposal";
import {
  CULTIVATION_PROPOSALS_DIRECTORY,
  cultivationProposalManifestPath,
  cultivationProposalSnapshotPath,
  cultivationProposalManifestSchema,
  type CultivationProposalManifest,
  serializeCultivationProposalManifest,
} from "./cultivationProposalSchema";
import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [entry] = await storage.stat([path]);
  return entry?.exists ? (await storage.readText(path)).content : null;
}

async function itemIdsFromStorage(
  storage: WorkbenchStorage,
): Promise<ReadonlySet<string> | undefined> {
  const content = await readOptional(storage, "world/items/index.json");
  if (content === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`物品索引不是有效 JSON：${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("物品索引不是有效对象");
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("物品索引缺少 items 数组");
  return new Set(
    items.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

async function validateEcologyState(
  storage: WorkbenchStorage,
  overrides: ReadonlyMap<string, string>,
): Promise<void> {
  const loaded = await loadCultivationEcologyFiles(async (path) => {
    const overridden = overrides.get(path);
    if (overridden !== undefined) return overridden;
    const content = await readOptional(storage, path);
    if (content === null) throw new Error(`修行体系模块不存在：${path}`);
    return content;
  });
  const errors = validateCultivationEcology(loaded.ecology, {
    itemIds: await itemIdsFromStorage(storage),
  });
  if (errors.length > 0) throw new Error(errors.slice(0, 100).join("；"));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return (
    leftIds.size === left.length &&
    rightIds.size === right.length &&
    leftIds.size === rightIds.size &&
    [...leftIds].every((id) => rightIds.has(id))
  );
}

export function createNovelCultivationProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const load = async (proposalId: string): Promise<FileProposal> => {
    const manifestPath = cultivationProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const parsed = cultivationProposalManifestSchema.safeParse(
      JSON.parse(manifestFile.content),
    );
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("；"),
      );
    }
    const manifest: CultivationProposalManifest = parsed.data;
    if (manifest.proposalId !== proposalId)
      throw new Error("提案目录与 proposalId 不一致");

    const changes = await Promise.all(
      manifest.changes.map(async (change): Promise<FileProposalChange> => {
        const [beforeContent, afterContent, currentContent] = await Promise.all(
          [
            readOptional(
              storage,
              cultivationProposalSnapshotPath(
                proposalId,
                "before",
                change.targetPath,
              ),
            ),
            readOptional(
              storage,
              cultivationProposalSnapshotPath(
                proposalId,
                "after",
                change.targetPath,
              ),
            ),
            readOptional(storage, change.targetPath),
          ],
        );
        const loadError =
          beforeContent === null || afterContent === null
            ? "提案模块快照缺失"
            : null;
        const baseline = beforeContent ?? "";
        return {
          id: change.id,
          targetPath: change.targetPath,
          operation: change.operation,
          summary: change.summary,
          status: change.status,
          beforeContent: baseline,
          afterContent: afterContent ?? "",
          currentContent,
          baseContentAvailable: beforeContent !== null,
          conflict:
            change.status === "pending" &&
            (change.operation === "create"
              ? currentContent !== null
              : currentContent !== baseline),
          loadError,
        };
      }),
    );

    const proposalOverrides = new Map(
      changes
        .filter((change) => change.status !== "rejected" && !change.loadError)
        .map((change) => [change.targetPath, change.afterContent]),
    );
    let proposalError: string | null = null;
    if (changes.every((change) => !change.loadError)) {
      try {
        await validateEcologyState(storage, proposalOverrides);
      } catch (error) {
        proposalError = `提案目录聚合校验失败：${errorMessage(error)}`;
      }
    }
    const loadedChanges = proposalError
      ? changes.map((change) => ({ ...change, loadError: proposalError }))
      : changes;
    return {
      manifest: {
        proposalId: manifest.proposalId,
        title: manifest.title,
        description: manifest.description,
        createdAt: manifest.createdAt,
        changes: loadedChanges.map((change) => ({ status: change.status })),
      },
      changes: loadedChanges,
    };
  };

  const updateStatuses = async (
    proposalId: string,
    changeIds: readonly string[],
    status: "applied" | "rejected",
  ): Promise<FileProposal> => {
    const manifestPath = cultivationProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const parsed = cultivationProposalManifestSchema.parse(
      JSON.parse(manifestFile.content),
    );
    const ids = new Set(changeIds);
    const next: CultivationProposalManifest = {
      ...parsed,
      changes: parsed.changes.map((change) =>
        ids.has(change.id) ? { ...change, status } : change,
      ),
    };
    await storage.writeText(
      manifestPath,
      serializeCultivationProposalManifest(next),
      { expectedContent: manifestFile.content },
    );
    return load(proposalId);
  };

  return {
    async list() {
      const [directory] = await storage.stat([CULTIVATION_PROPOSALS_DIRECTORY]);
      if (!directory?.exists) {
        return {
          proposals: [] as FileProposal[],
          errors: [] as FileProposalLoadError[],
        };
      }
      const entries = await storage.list(CULTIVATION_PROPOSALS_DIRECTORY);
      const proposalEntries = entries.filter(
        (entry) => entry.kind === "directory",
      );
      const settled = await Promise.allSettled(
        proposalEntries.map((entry) => load(entry.name)),
      );
      const proposals: FileProposal[] = [];
      const errors: FileProposalLoadError[] = [];
      settled.forEach((loaded, index) => {
        if (loaded.status === "fulfilled") proposals.push(loaded.value);
        else {
          errors.push({
            proposalId: proposalEntries[index]?.name ?? "unknown",
            message: errorMessage(loaded.reason),
          });
        }
      });
      proposals.sort(
        (left, right) =>
          Date.parse(right.manifest.createdAt) -
          Date.parse(left.manifest.createdAt),
      );
      return { proposals, errors };
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(
          `${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}`,
          { permanent: true },
        );
      }
    },

    async apply(proposalId, changeIds) {
      const proposal = await load(proposalId);
      const pending = proposal.changes.filter(
        (change) => change.status === "pending",
      );
      if (
        !sameIds(
          changeIds,
          pending.map((change) => change.id),
        )
      ) {
        throw new Error("修行体系目录提案必须一次应用全部待处理模块");
      }
      if (pending.some((change) => change.conflict || change.loadError)) {
        throw new Error(
          pending.some((change) => change.conflict)
            ? "修行体系事实源已变化，无法应用提案"
            : "提案模块不可应用",
        );
      }
      await validateEcologyState(
        storage,
        new Map(
          pending.map((change) => [change.targetPath, change.afterContent]),
        ),
      );
      const transaction = createStorageTransaction(storage);
      const ordered = [...pending].sort((left, right) => {
        if (left.targetPath === CULTIVATION_ECOLOGY_INDEX_PATH) return 1;
        if (right.targetPath === CULTIVATION_ECOLOGY_INDEX_PATH) return -1;
        return left.targetPath.localeCompare(right.targetPath);
      });
      for (const change of ordered) {
        if (change.operation === "create") {
          transaction.createText(change.targetPath, change.afterContent);
        } else {
          transaction.writeText(
            change.targetPath,
            change.afterContent,
            change.beforeContent,
          );
        }
      }
      await transaction.commit();
      return updateStatuses(proposalId, changeIds, "applied");
    },

    async resolveConflict(proposalId, changeId, resolution) {
      const proposal = await load(proposalId);
      const change = proposal.changes.find(
        (candidate) => candidate.id === changeId,
      );
      if (!change) throw new Error("提案变更不存在");
      if (change.status !== "pending")
        throw new Error("已处理的修行体系模块不能重复操作");
      if (!change.conflict) throw new Error("当前模块没有冲突，请直接应用提案");
      if (change.currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式模块在冲突处理期间再次变化，请重新读取后再处理");
      }
      const content =
        resolution.strategy === "merge"
          ? resolution.content
          : change.afterContent;
      const pendingOverrides = new Map(
        proposal.changes
          .filter((candidate) => candidate.status === "pending")
          .map((candidate) => [
            candidate.targetPath,
            candidate.id === changeId ? content : candidate.afterContent,
          ]),
      );
      await validateEcologyState(storage, pendingOverrides);
      if (change.currentContent === null) {
        await storage.createText(change.targetPath, content, {
          createParents: true,
        });
      } else {
        await storage.writeText(change.targetPath, content, {
          expectedContent: change.currentContent,
        });
      }
      return updateStatuses(proposalId, [changeId], "applied");
    },

    async reject(proposalId, changeIds) {
      const proposal = await load(proposalId);
      const pendingIds = proposal.changes
        .filter((change) => change.status === "pending")
        .map((change) => change.id);
      if (!sameIds(changeIds, pendingIds)) {
        throw new Error("修行体系目录提案必须一次拒绝全部待处理模块");
      }
      return updateStatuses(proposalId, changeIds, "rejected");
    },

    async delete(proposalId, changeIds) {
      const proposal = await load(proposalId);
      if (
        !sameIds(
          changeIds,
          proposal.changes.map((change) => change.id),
        )
      ) {
        throw new Error("删除修行体系提案时必须选择全部模块变更");
      }
      await storage.remove(`${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}`, {
        permanent: true,
      });
      return null;
    },
  };
}
