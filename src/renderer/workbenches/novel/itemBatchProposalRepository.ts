import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  ITEM_BATCH_PROPOSALS_DIRECTORY,
  itemBatchProposalManifestPath,
  parseItemBatchProposalManifest,
  serializeItemBatchProposalManifest,
  type ItemBatchProposalCandidate,
  type ItemBatchProposalManifest,
} from "./itemBatchProposalSchema";
import {
  createNovelItemLibraryRepository,
  ITEM_LIBRARY_PATHS,
  type LoadedItemLibrary,
} from "./itemLibraryRepository";
import {
  getEffectiveCategoryFields,
  type CategoryFieldDefinition,
  type ItemFieldValue,
} from "./itemLibrarySchema";

export interface LoadedItemBatchProposal {
  readonly manifest: ItemBatchProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface ItemBatchProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface ItemBatchProposalListResult {
  readonly proposals: readonly LoadedItemBatchProposal[];
  readonly errors: readonly ItemBatchProposalLoadError[];
}

export interface NovelItemBatchProposalRepository {
  list(): Promise<ItemBatchProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedItemBatchProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedItemBatchProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateCandidates(
  manifest: ItemBatchProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: ItemBatchProposalCandidate["status"],
): ItemBatchProposalManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) =>
      candidateIds.has(item.candidateId) ? { ...item, status } : item,
    ),
  };
}

function valueIsPresent(value: ItemFieldValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "boolean" || Number.isFinite(value);
}

function validateFieldValue(
  field: CategoryFieldDefinition,
  value: ItemFieldValue,
): string | null {
  if (value === null) return null;
  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : `字段“${field.label}”必须是有效数字`;
  }
  if (field.type === "boolean") {
    return typeof value === "boolean" ? null : `字段“${field.label}”必须是开关值`;
  }
  if (field.type === "multi-select") {
    if (!Array.isArray(value)) return `字段“${field.label}”必须是多选数组`;
    const invalid = value.find(
      (item) => field.options.length > 0 && !field.options.includes(item),
    );
    return invalid ? `字段“${field.label}”包含非法选项：${invalid}` : null;
  }
  if (typeof value !== "string") return `字段“${field.label}”必须是文本`;
  if (
    field.type === "single-select" &&
    field.options.length > 0 &&
    !field.options.includes(value)
  ) {
    return `字段“${field.label}”包含非法选项：${value}`;
  }
  return null;
}

function validateCandidatesAgainstLibrary(
  library: LoadedItemLibrary,
  proposal: ItemBatchProposalManifest,
  candidates: readonly ItemBatchProposalCandidate[],
): void {
  const category = library.meta.categories.find(
    (item) => item.id === proposal.categoryId,
  );
  if (!category) throw new Error(`物品分类不存在：${proposal.categoryId}`);
  if (category.archived) throw new Error("不能向已归档分类创建物品");
  const fields = getEffectiveCategoryFields(library.meta, proposal.categoryId);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const names = new Set(
    library.index.items.map((item) =>
      item.name.trim().toLocaleLowerCase("zh-CN"),
    ),
  );
  for (const candidate of candidates) {
    const normalizedName = candidate.name
      .trim()
      .toLocaleLowerCase("zh-CN");
    if (names.has(normalizedName)) {
      throw new Error(`物品名称已经存在：${candidate.name}`);
    }
    names.add(normalizedName);
    for (const [fieldId, value] of Object.entries(candidate.values)) {
      const field = fieldsById.get(fieldId);
      if (!field) {
        throw new Error(
          `物品“${candidate.name}”使用了当前分类不允许的字段：${fieldId}`,
        );
      }
      const validationError = validateFieldValue(field, value);
      if (validationError) {
        throw new Error(`物品“${candidate.name}”${validationError}`);
      }
    }
    for (const field of fields) {
      const value = candidate.values[field.id] ?? field.defaultValue;
      if (field.required && !valueIsPresent(value)) {
        throw new Error(`物品“${candidate.name}”缺少必填字段“${field.label}”`);
      }
    }
  }
}

function uniqueItemId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token =
      globalThis.crypto?.randomUUID?.().slice(0, 8) ??
      `${Date.now().toString(36)}-${attempt}`;
    const id = `item-${token.toLocaleLowerCase()}`;
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  throw new Error("无法生成唯一物品 id");
}

async function writeManifest(
  storage: WorkbenchStorage,
  proposal: LoadedItemBatchProposal,
  manifest: ItemBatchProposalManifest,
): Promise<LoadedItemBatchProposal> {
  const content = serializeItemBatchProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseItemBatchProposalManifest(
      proposal.manifestPath,
      file.content,
    ),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

export function createNovelItemBatchProposalRepository(
  storage: WorkbenchStorage,
): NovelItemBatchProposalRepository {
  const itemRepository = createNovelItemLibraryRepository(storage);

  const load = async (proposalId: string): Promise<LoadedItemBatchProposal> => {
    const manifestPath = itemBatchProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseItemBatchProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error(`物品提案目录与 proposalId 不一致：${proposalId}`);
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  return {
    async list() {
      const [info] = await storage.stat([ITEM_BATCH_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") {
        throw new Error("物品提案路径不是目录");
      }
      const entries = await storage.list(ITEM_BATCH_PROPOSALS_DIRECTORY);
      const proposals: LoadedItemBatchProposal[] = [];
      const errors: ItemBatchProposalLoadError[] = [];
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
      const candidates = proposal.manifest.items.filter(
        (item) => item.status === "pending" && selectedIds.has(item.candidateId),
      );
      if (candidates.length === 0) throw new Error("没有可创建的物品候选");
      const appliedIds = new Set(
        candidates.map((candidate) => candidate.candidateId),
      );
      const library = await itemRepository.load();
      validateCandidatesAgainstLibrary(library, proposal.manifest, candidates);
      const existingIds = new Set(library.index.items.map((item) => item.id));
      const created = await itemRepository.createItems(
        library,
        candidates.map((candidate) => ({
          id: uniqueItemId(existingIds),
          name: candidate.name,
          categoryId: proposal.manifest.categoryId,
          aliases: candidate.aliases,
          tags: candidate.tags,
          summary: candidate.summary,
          values: candidate.values,
          pageContent: candidate.description,
        })),
      );
      try {
        return await writeManifest(
          storage,
          proposal,
          updateCandidates(proposal.manifest, appliedIds, "applied"),
        );
      } catch (error) {
        try {
          await storage.writeText(ITEM_LIBRARY_PATHS.index, library.indexContent, {
            expectedContent: created.library.indexContent,
          });
          await Promise.all(
            created.items.flatMap((item) => [
              storage
                .remove(`${ITEM_LIBRARY_PATHS.records}/${item.record.id}.json`, {
                  permanent: true,
                })
                .catch(() => false),
              storage
                .remove(`${ITEM_LIBRARY_PATHS.pages}/${item.record.id}.md`, {
                  permanent: true,
                })
                .catch(() => false),
            ]),
          );
        } catch (rollbackError) {
          throw new Error(
            `物品已创建，但提案状态更新和回滚均失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
    },

    async reject(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const selectedIds = new Set(candidateIds);
      const rejectedIds = new Set(
        proposal.manifest.items
          .filter(
            (item) =>
              item.status === "pending" && selectedIds.has(item.candidateId),
          )
          .map((item) => item.candidateId),
      );
      if (rejectedIds.size === 0) {
        throw new Error("没有可拒绝的物品候选");
      }
      return writeManifest(
        storage,
        proposal,
        updateCandidates(proposal.manifest, rejectedIds, "rejected"),
      );
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(
          `${ITEM_BATCH_PROPOSALS_DIRECTORY}/${proposalId}`,
          { permanent: true },
        );
      }
    },
  };
}
