import type { WorkbenchStorage } from "@/workbench-sdk";

import type {
  FileProposal,
  FileProposalChange,
  FileProposalRepository,
} from "../../../shared/business/fileProposal";
import {
  ITEM_BATCH_PROPOSALS_DIRECTORY,
  itemBatchProposalManifestPath,
  parseItemBatchProposalManifest,
  serializeItemBatchProposalManifest,
  type ItemBatchProposalCandidate,
  type ItemBatchProposalManifest,
} from "../entities/itemBatchProposalSchema";
import { createNovelItemBatchProposalRepository } from "./itemBatchProposalRepository";
import {
  createNovelItemLibraryRepository,
  ITEM_LIBRARY_PATHS,
} from "./itemLibraryRepository";
import type { ItemRecord } from "../entities/itemLibrarySchema";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetPath(candidateId: string): string {
  return `${ITEM_LIBRARY_PATHS.records}/item-${candidateId}.json`;
}

function candidateChange(
  manifest: ItemBatchProposalManifest,
  candidate: ItemBatchProposalCandidate,
  current: ReadonlyMap<string, string>,
): FileProposalChange {
  const path = targetPath(candidate.candidateId);
  const currentContent = current.get(path) ?? null;
  const afterContent = json({
    id: `item-${candidate.candidateId}`,
    name: candidate.name,
    categoryId: manifest.categoryId,
    aliases: candidate.aliases,
    tags: candidate.tags,
    summary: candidate.summary,
    values: candidate.values,
    description: candidate.description,
  });
  return {
    id: candidate.candidateId,
    targetPath: path,
    operation: "create",
    summary: `新建物品：${candidate.name}`,
    status: candidate.status,
    beforeContent: "",
    afterContent,
    currentContent,
    baseContentAvailable: true,
    conflict: candidate.status === "pending" && currentContent !== null,
    loadError: null,
    inferred: false,
  };
}

async function loadCurrentContent(
  storage: WorkbenchStorage,
): Promise<ReadonlyMap<string, string>> {
  const repository = createNovelItemLibraryRepository(storage);
  const library = await repository.load();
  const result = new Map<string, string>([
    [ITEM_LIBRARY_PATHS.index, library.indexContent],
    [ITEM_LIBRARY_PATHS.meta, library.metaContent],
  ]);
  await Promise.all(
    library.index.items.map(async (entry) => {
      try {
        result.set(
          entry.recordPath,
          (await storage.readText(entry.recordPath)).content,
        );
      } catch {
        // Orphaned index entries are reported by the domain repository when applied.
      }
    }),
  );
  return result;
}

function parseObject(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("冲突解决内容必须是有效的 JSON 对象");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("冲突解决内容必须是有效的 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function materialized(
  manifest: ItemBatchProposalManifest,
  current: ReadonlyMap<string, string>,
): FileProposal {
  const changes = manifest.items.map((candidate) =>
    candidateChange(manifest, candidate, current),
  );
  return {
    manifest: {
      proposalId: manifest.proposalId,
      title: manifest.title,
      description: manifest.description,
      createdAt: manifest.createdAt,
      changes: changes.map((change) => ({ status: change.status })),
    },
    changes,
  };
}

export function createItemFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const domain = createNovelItemBatchProposalRepository(storage);
  const itemRepository = createNovelItemLibraryRepository(storage);
  const load = async (proposalId: string) => {
    const path = itemBatchProposalManifestPath(proposalId);
    const file = await storage.readText(path);
    return {
      manifest: parseItemBatchProposalManifest(path, file.content),
      path,
      content: file.content,
    };
  };
  const materialize = async (proposalId: string): Promise<FileProposal> => {
    const [proposal, current] = await Promise.all([
      load(proposalId),
      loadCurrentContent(storage),
    ]);
    return materialized(proposal.manifest, current);
  };
  const repository: FileProposalRepository = {
    async list() {
      const [result, current] = await Promise.all([
        domain.list(),
        loadCurrentContent(storage),
      ]);
      return {
        proposals: result.proposals.map((proposal) =>
          materialized(proposal.manifest, current),
        ),
        errors: result.errors,
      };
    },
    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(
          `${ITEM_BATCH_PROPOSALS_DIRECTORY}/${proposalId}`,
          {
            permanent: true,
          },
        );
      }
    },
    async apply(proposalId, changeIds, projectTitle) {
      void projectTitle;
      const proposal = await materialize(proposalId);
      const selected = new Set(changeIds);
      const conflicted = proposal.changes.find(
        (change) => selected.has(change.id) && change.conflict,
      );
      if (conflicted) {
        throw new Error(
          `正式物品记录已变化，不能直接应用：${conflicted.targetPath}`,
        );
      }
      await domain.apply(proposalId, changeIds);
      return materialize(proposalId);
    },
    async reject(proposalId, changeIds) {
      await domain.reject(proposalId, changeIds);
      return materialize(proposalId);
    },
    async delete(proposalId, changeIds) {
      const proposal = await load(proposalId);
      const selected = new Set(changeIds);
      const selectedCandidates = proposal.manifest.items.filter((candidate) =>
        selected.has(candidate.candidateId),
      );
      if (
        selectedCandidates.length !== selected.size ||
        selectedCandidates.some((candidate) => candidate.status !== "pending")
      ) {
        throw new Error("只能删除尚未处理的物品提案变更");
      }
      const remaining = proposal.manifest.items.filter(
        (candidate) => !selected.has(candidate.candidateId),
      );
      if (remaining.length === proposal.manifest.items.length) {
        throw new Error("没有可删除的物品提案变更");
      }
      if (remaining.length === 0) {
        await storage.remove(
          `${ITEM_BATCH_PROPOSALS_DIRECTORY}/${proposalId}`,
          {
            permanent: true,
          },
        );
        return null;
      }
      await storage.writeText(
        proposal.path,
        serializeItemBatchProposalManifest({
          ...proposal.manifest,
          items: remaining,
        }),
        { expectedContent: proposal.content },
      );
      return materialize(proposalId);
    },
    async resolveConflict(proposalId, changeId, resolution, projectTitle) {
      void projectTitle;
      const loaded = await load(proposalId);
      const proposal = await materialize(proposalId);
      const change = proposal.changes.find((item) => item.id === changeId);
      if (!change) throw new Error("物品提案变更不存在");
      if (change.currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式物品再次变化，请重新读取后解决冲突");
      }
      const candidate = loaded.manifest.items.find(
        (item) => item.candidateId === changeId,
      );
      if (!candidate || candidate.status !== "pending") {
        throw new Error("已处理的物品提案不能再次解决冲突");
      }
      const object = parseObject(
        resolution.strategy === "merge"
          ? resolution.content
          : change.afterContent,
      );
      const itemId = `item-${candidate.candidateId}`;
      const library = await itemRepository.load();
      const entry = library.index.items.find((item) => item.id === itemId);
      if (entry) {
        const currentItem = await itemRepository.loadItem(entry);
        const record: ItemRecord = {
          ...currentItem.record,
          id: currentItem.record.id,
          name: typeof object.name === "string" ? object.name : candidate.name,
          categoryId:
            typeof object.categoryId === "string"
              ? object.categoryId
              : loaded.manifest.categoryId,
          aliases: Array.isArray(object.aliases)
            ? object.aliases.filter(
                (value): value is string => typeof value === "string",
              )
            : candidate.aliases,
          tags: Array.isArray(object.tags)
            ? object.tags.filter(
                (value): value is string => typeof value === "string",
              )
            : candidate.tags,
          summary:
            typeof object.summary === "string"
              ? object.summary
              : candidate.summary,
          values:
            object.values &&
            typeof object.values === "object" &&
            !Array.isArray(object.values)
              ? (object.values as ItemRecord["values"])
              : candidate.values,
        };
        const saved = await itemRepository.saveItem(
          library,
          currentItem,
          record,
          typeof object.description === "string"
            ? object.description
            : currentItem.pageContent,
        );
        try {
          await storage.writeText(
            loaded.path,
            serializeItemBatchProposalManifest({
              ...loaded.manifest,
              items: loaded.manifest.items.map((item) =>
                item.candidateId === changeId
                  ? { ...item, status: "applied" }
                  : item,
              ),
            }),
            { expectedContent: loaded.content },
          );
        } catch (error) {
          try {
            await itemRepository.saveItem(
              saved.library,
              saved.item,
              currentItem.record,
              currentItem.pageContent,
            );
          } catch (rollbackError) {
            throw new Error(
              `物品提案冲突解决失败，且物品正式内容回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
            );
          }
          throw error;
        }
        return materialize(proposalId);
      }

      // No formal record exists anymore; use the normal domain path after the
      // explicit CAS check above so schema and category validation stay shared.
      await domain.apply(proposalId, [changeId]);
      return materialize(proposalId);
    },
  };
  return Object.freeze(repository);
}
