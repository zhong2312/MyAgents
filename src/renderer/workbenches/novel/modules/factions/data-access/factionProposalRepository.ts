import type { WorkbenchStorage } from "@/workbench-sdk";

import { factionRecordPath } from "../../../../../../shared/workbenches/novel/factionStorage";
import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalRepository,
} from "../../../shared/business/fileProposal";
import { validateFactionCrossReferences } from "../../../shared/business/crossLibraryReferences";
import {
  createNovelFactionLibraryRepository,
  type LoadedFactionLibrary,
} from "./factionLibraryRepository";
import {
  factionProposalManifestPath,
  FACTION_PROPOSALS_DIRECTORY,
  parseFactionProposalManifest,
  serializeFactionProposalManifest,
  type FactionProposalManifest,
  type FactionProposalOperation,
} from "../entities/factionProposalSchema";
import {
  factionRecordSchema,
  parseFactionLibrary,
  type FactionRecord,
} from "../entities/factionLibrarySchema";

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
  delete(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedFactionProposal | null>;
  resolveConflict(
    proposalId: string,
    candidateId: string,
    resolution: FileProposalConflictResolution,
  ): Promise<LoadedFactionProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

const LEGACY_FACTION_HELPER_KEYS = new Set([
  "aliases",
  "location",
  "coreGoals",
  "hierarchy",
  "keyMembers",
  "authority",
  "evolutionHook",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 早期势力提示词同时生成了用于预览的说明字段和正式字段。说明信息已经
 * 落在 summary、links、members、organizationUnits 与 rights 中，不能再把
 * 这些临时字段写入严格的正式势力记录。
 */
function withoutLegacyHelperKeys(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !LEGACY_FACTION_HELPER_KEYS.has(key),
    ),
  );
}

function operationTargetId(operation: FactionProposalOperation): string {
  if (operation.action === "update") {
    if (!operation.targetId) throw new Error("更新候选缺少 targetId");
    return operation.targetId;
  }
  const id = operation.value.id;
  if (typeof id !== "string") throw new Error("新建候选缺少势力 id");
  return id;
}

function operationTargetPath(
  operation: FactionProposalOperation,
  targetId: string,
): string {
  try {
    return factionRecordPath(targetId);
  } catch {
    return factionRecordPath(operation.candidateId);
  }
}

function parseFactionCandidate(
  operation: FactionProposalOperation,
  fallback: FactionRecord | undefined,
  override?: unknown,
): FactionRecord {
  let source: unknown = override;
  if (source === undefined) {
    const value = withoutLegacyHelperKeys(operation.value);
    const base =
      operation.action === "update" && operation.baseValue
        ? withoutLegacyHelperKeys(operation.baseValue)
        : fallback;
    source = base ? { ...base, ...value } : value;
  }
  const parsed = factionRecordSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `势力候选“${operation.summary}”格式无效：${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  const targetId = operationTargetId(operation);
  if (parsed.data.id !== targetId) {
    throw new Error(
      `势力候选“${operation.summary}”不能把稳定 ID 从 ${targetId} 改为 ${parsed.data.id}`,
    );
  }
  return parsed.data;
}

function parseBaseRecord(
  operation: FactionProposalOperation,
): FactionRecord | null | undefined {
  if (operation.action === "create") return null;
  if (operation.baseValue === undefined) return undefined;
  if (operation.baseValue === null) {
    throw new Error(`更新候选“${operation.summary}”的生成基准不能为空`);
  }
  return parseFactionCandidate(operation, undefined, operation.baseValue);
}

function findCurrentRecord(
  operation: FactionProposalOperation,
  current: LoadedFactionLibrary,
): FactionRecord | undefined {
  const targetId = operationTargetId(operation);
  return current.library.factions.find((faction) => faction.id === targetId);
}

function operationConflicts(
  operation: FactionProposalOperation,
  currentRecord: FactionRecord | undefined,
): boolean {
  if (operation.action === "create") return currentRecord !== undefined;
  const base = parseBaseRecord(operation);
  if (base === undefined || currentRecord === undefined) return true;
  return JSON.stringify(currentRecord) !== JSON.stringify(base);
}

function updateOperations(
  manifest: FactionProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): FactionProposalManifest {
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

function selectedPendingOperations(
  manifest: FactionProposalManifest,
  candidateIds: readonly string[],
): readonly FactionProposalOperation[] {
  const selectedIds = new Set(candidateIds);
  return manifest.operations.filter(
    (operation) =>
      operation.status === "pending" && selectedIds.has(operation.candidateId),
  );
}

function asFileProposal(
  proposal: LoadedFactionProposal,
  current: LoadedFactionLibrary,
): FileProposal {
  const changes: FileProposalChange[] = proposal.manifest.operations.map(
    (operation) => {
      let targetId = operation.candidateId;
      let currentRecord: FactionRecord | undefined;
      let beforeContent = "";
      let afterContent = json(withoutLegacyHelperKeys(operation.value));
      let conflict = false;
      let loadError: string | null = null;
      try {
        targetId = operationTargetId(operation);
        currentRecord = findCurrentRecord(operation, current);
        const base = parseBaseRecord(operation);
        const after = parseFactionCandidate(operation, base ?? currentRecord);
        beforeContent = base ? json(base) : "";
        afterContent = json(after);
        conflict =
          operation.status === "pending" &&
          operationConflicts(operation, currentRecord);
      } catch (error) {
        loadError = errorMessage(error);
      }
      return {
        id: operation.candidateId,
        targetPath: operationTargetPath(operation, targetId),
        operation: operation.action === "create" ? "create" : "modify",
        summary: operation.summary,
        status: operation.status,
        beforeContent,
        afterContent,
        currentContent: currentRecord ? json(currentRecord) : null,
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

function referencesFactionId(
  operation: FactionProposalOperation,
  targetId: string,
): boolean {
  const value = withoutLegacyHelperKeys(operation.value);
  const relations = Array.isArray(value.relations) ? value.relations : [];
  const resources = Array.isArray(value.resources) ? value.resources : [];
  const rights = Array.isArray(value.rights) ? value.rights : [];
  return (
    relations.some(
      (relation) =>
        !!relation &&
        typeof relation === "object" &&
        (relation as { targetFactionId?: unknown }).targetFactionId ===
          targetId,
    ) ||
    resources.some(
      (resource) =>
        !!resource &&
        typeof resource === "object" &&
        Array.isArray(
          (resource as { competingFactionIds?: unknown }).competingFactionIds,
        ) &&
        (
          resource as { competingFactionIds: readonly unknown[] }
        ).competingFactionIds.includes(targetId),
    ) ||
    rights.some(
      (right) =>
        !!right &&
        typeof right === "object" &&
        (right as { issuerFactionId?: unknown }).issuerFactionId === targetId,
    )
  );
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

  const applyOperations = async (
    proposal: LoadedFactionProposal,
    operations: readonly FactionProposalOperation[],
    current: LoadedFactionLibrary,
    overrides: ReadonlyMap<string, FactionRecord> = new Map(),
    resolvedConflictIds: ReadonlySet<string> = new Set(),
  ): Promise<LoadedFactionProposal> => {
    let factions = [...current.library.factions];
    for (const operation of operations) {
      const targetId = operationTargetId(operation);
      const existing = factions.find((faction) => faction.id === targetId);
      const value =
        overrides.get(operation.candidateId) ??
        parseFactionCandidate(operation, existing);
      if (operation.action === "create") {
        if (existing) {
          if (!resolvedConflictIds.has(operation.candidateId)) {
            throw new Error(`候选要创建的势力 id 已存在：${targetId}`);
          }
          factions = factions.map((faction) =>
            faction.id === targetId ? value : faction,
          );
        } else {
          factions.push(value);
        }
      } else {
        if (!existing)
          throw new Error(`候选要更新的势力 id 不存在：${targetId}`);
        factions = factions.map((faction) =>
          faction.id === targetId ? value : faction,
        );
      }
    }

    const candidateLibrary = parseFactionLibrary(
      JSON.stringify({ schemaVersion: 2, factions }),
    );
    await validateFactionCrossReferences(storage, candidateLibrary);
    const saved = await factionRepository.save(current, candidateLibrary);
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
        await factionRepository.save(saved, current.library);
      } catch (rollbackError) {
        throw new Error(
          `势力提案采纳失败，且势力库回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
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
      const operations = selectedPendingOperations(
        proposal.manifest,
        candidateIds,
      );
      if (operations.length === 0) throw new Error("没有可采纳的势力候选");
      const current = await factionRepository.load();
      for (const operation of operations) {
        if (
          operationConflicts(operation, findCurrentRecord(operation, current))
        ) {
          throw new Error(
            `势力候选“${operation.summary}”的正式内容已变化，请先解决冲突`,
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
      if (!operation) throw new Error("势力候选不存在");
      if (operation.status !== "pending") {
        throw new Error("已处理的势力候选不能再次解决冲突");
      }
      const current = await factionRepository.load();
      const currentRecord = findCurrentRecord(operation, current);
      const currentContent = currentRecord ? json(currentRecord) : null;
      if (currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式势力在冲突处理期间再次变化，请重新读取后再处理");
      }
      if (!operationConflicts(operation, currentRecord)) {
        throw new Error("正式势力当前没有冲突，请直接应用提案");
      }

      let value: FactionRecord;
      if (resolution.strategy === "merge") {
        let merged: unknown;
        try {
          merged = JSON.parse(resolution.content) as unknown;
        } catch (error) {
          throw new Error(`合并结果不是有效 JSON：${errorMessage(error)}`);
        }
        value = parseFactionCandidate(operation, currentRecord, merged);
      } else {
        value = parseFactionCandidate(operation, currentRecord);
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
      if (operations.length === 0) throw new Error("没有可拒绝的势力候选");
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
      if (operations.length === 0) throw new Error("没有可删除的势力候选");
      const selectedIds = new Set(
        operations.map((operation) => operation.candidateId),
      );
      const current = await factionRepository.load();
      const formalIds = new Set(
        current.library.factions.map((faction) => faction.id),
      );
      const removedTransientIds = operations
        .filter(
          (operation) =>
            operation.action === "create" &&
            !formalIds.has(operationTargetId(operation)),
        )
        .map(operationTargetId);
      const remaining = proposal.manifest.operations.filter(
        (operation) => !selectedIds.has(operation.candidateId),
      );
      for (const targetId of removedTransientIds) {
        const dependent = remaining.find(
          (operation) =>
            operation.status !== "rejected" &&
            referencesFactionId(operation, targetId),
        );
        if (dependent) {
          throw new Error(
            `不能删除势力候选 ${targetId}：候选“${dependent.summary}”仍引用它`,
          );
        }
      }
      if (remaining.length === 0) {
        await storage.remove(`${FACTION_PROPOSALS_DIRECTORY}/${proposalId}`, {
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
      if (ids.length === 0) throw new Error("请至少选择一份待删除的势力提案");
      ids.forEach(factionProposalManifestPath);
      for (const proposalId of ids) {
        await storage.remove(`${FACTION_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}

/** 将势力对象候选投影到世界架构使用的统一文件提案审阅契约。 */
export function createFactionFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const proposalRepository = createNovelFactionProposalRepository(storage);
  const factionRepository = createNovelFactionLibraryRepository(storage);

  const materialize = async (
    proposal: LoadedFactionProposal,
  ): Promise<FileProposal> =>
    asFileProposal(proposal, await factionRepository.load());

  const repository: FileProposalRepository = {
    async list() {
      const [result, current] = await Promise.all([
        proposalRepository.list(),
        factionRepository.load(),
      ]);
      return {
        proposals: result.proposals.map((proposal) =>
          asFileProposal(proposal, current),
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
