import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  parsePowerSystemIndex,
  parsePowerSystemInteractions,
  parsePowerSystemMeta,
  parsePowerSystemRecord,
  type PowerSystemIndex,
  type PowerSystemInteractions,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "./powerSystemSchema";
import {
  parsePowerSystemProposalManifest,
  POWER_SYSTEM_PROPOSALS_DIRECTORY,
  powerSystemProposalManifestPath,
  powerSystemProposalSnapshotPath,
  serializePowerSystemProposalManifest,
  type PowerSystemProposalChange,
  type PowerSystemProposalManifest,
} from "./powerSystemProposalSchema";

export interface LoadedPowerSystemProposalChange
  extends PowerSystemProposalChange {
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly currentContent: string | null;
  readonly conflict: boolean;
  readonly loadError: string | null;
}

export interface LoadedPowerSystemProposal {
  readonly manifest: PowerSystemProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
  readonly changes: readonly LoadedPowerSystemProposalChange[];
}

export interface PowerSystemProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface PowerSystemProposalListResult {
  readonly proposals: readonly LoadedPowerSystemProposal[];
  readonly errors: readonly PowerSystemProposalLoadError[];
}

export type PowerSystemProposalStatus =
  | "pending"
  | "partially-applied"
  | "applied"
  | "rejected";

export interface NovelPowerSystemProposalRepository {
  list(): Promise<PowerSystemProposalListResult>;
  load(proposalId: string): Promise<LoadedPowerSystemProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
  apply(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<LoadedPowerSystemProposal>;
  reject(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<LoadedPowerSystemProposal>;
  delete(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<LoadedPowerSystemProposal | null>;
}

const POWER_SYSTEM_ROOT = "world/power-systems";
const META_PATH = `${POWER_SYSTEM_ROOT}/meta.json`;
const INDEX_PATH = `${POWER_SYSTEM_ROOT}/index.json`;
const INTERACTIONS_PATH = `${POWER_SYSTEM_ROOT}/interactions.json`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptionalText(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [info] = await storage.stat([path]);
  return info?.exists ? (await storage.readText(path)).content : null;
}

function updateManifestChanges(
  manifest: PowerSystemProposalManifest,
  changeIds: ReadonlySet<string>,
  status: PowerSystemProposalChange["status"],
): PowerSystemProposalManifest {
  return {
    ...manifest,
    changes: manifest.changes.map((change) =>
      changeIds.has(change.id) ? { ...change, status } : change,
    ),
  };
}

function validateCoreReferences(
  meta: PowerSystemMeta,
  index: PowerSystemIndex,
  interactions: PowerSystemInteractions,
  records: ReadonlyMap<string, PowerSystemRecord>,
): void {
  const typeIds = new Set<string>();
  for (const type of meta.systemTypes) {
    if (typeIds.has(type.id)) {
      throw new Error(`力量体系类型 id 重复：${type.id}`);
    }
    typeIds.add(type.id);
  }

  const systemIds = new Set<string>();
  const targets = new Map<string, Set<string>>();
  for (const entry of index.systems) {
    if (systemIds.has(entry.id)) {
      throw new Error(`力量体系索引 id 重复：${entry.id}`);
    }
    systemIds.add(entry.id);
    if (!typeIds.has(entry.typeId)) {
      throw new Error(`力量体系“${entry.name}”引用了不存在的类型`);
    }
    const record = records.get(entry.id);
    if (!record) throw new Error(`力量体系“${entry.name}”缺少结构化记录`);
    if (
      record.name !== entry.name ||
      record.typeId !== entry.typeId ||
      record.status !== entry.status ||
      record.summary !== entry.summary ||
      record.updatedAt !== entry.updatedAt
    ) {
      throw new Error(`力量体系“${entry.name}”的索引摘要与记录不一致`);
    }
    const ids = new Set<string>([record.id]);
    record.elements.forEach((item) => ids.add(item.id));
    record.tracks.forEach((track) => {
      ids.add(track.id);
      track.states.forEach((state) => ids.add(state.id));
    });
    record.rules.forEach((item) => ids.add(item.id));
    record.dimensions.forEach((item) => ids.add(item.id));
    targets.set(entry.id, ids);
  }

  for (const interaction of interactions.interactions) {
    for (const reference of [interaction.left, interaction.right]) {
      if (!systemIds.has(reference.systemId)) {
        throw new Error(`跨体系交互“${interaction.name}”引用了不存在的体系`);
      }
      if (!targets.get(reference.systemId)?.has(reference.targetId)) {
        throw new Error(`跨体系交互“${interaction.name}”引用了不存在的目标`);
      }
      if (
        reference.kind === "system" &&
        reference.targetId !== reference.systemId
      ) {
        throw new Error(`跨体系交互“${interaction.name}”的体系引用不一致`);
      }
    }
  }
}

async function validateProspectiveLibrary(
  storage: WorkbenchStorage,
  selectedChanges: readonly LoadedPowerSystemProposalChange[],
  allowSnapshots: boolean,
): Promise<void> {
  const selectedByPath = new Map(
    selectedChanges.map((change) => [change.targetPath, change] as const),
  );
  const candidateContent = async (path: string): Promise<string | null> => {
    const selected = selectedByPath.get(path);
    if (selected) return selected.afterContent;
    return readOptionalText(storage, path);
  };
  const [metaContent, indexContent, interactionsContent] = await Promise.all([
    candidateContent(META_PATH),
    candidateContent(INDEX_PATH),
    candidateContent(INTERACTIONS_PATH),
  ]);
  if (!metaContent || !indexContent || !interactionsContent) {
    throw new Error("应用后的力量体系库缺少核心索引文件");
  }
  const meta = parsePowerSystemMeta(metaContent);
  const index = parsePowerSystemIndex(indexContent);
  const interactions = parsePowerSystemInteractions(interactionsContent);
  const records = new Map<string, PowerSystemRecord>();
  for (const entry of index.systems) {
    const expectedRecordPath = `${POWER_SYSTEM_ROOT}/records/${entry.id}.json`;
    const expectedPagePath = `${POWER_SYSTEM_ROOT}/pages/${entry.id}.md`;
    if (
      entry.recordPath !== expectedRecordPath ||
      entry.pagePath !== expectedPagePath
    ) {
      throw new Error(`力量体系“${entry.name}”的文件路径与 id 不一致`);
    }
    const [recordContent, pageContent] = await Promise.all([
      candidateContent(expectedRecordPath),
      candidateContent(expectedPagePath),
    ]);
    if (recordContent === null || pageContent === null) {
      throw new Error(`力量体系“${entry.name}”的记录或说明页不存在`);
    }
    const record = parsePowerSystemRecord(expectedRecordPath, recordContent);
    if (record.id !== entry.id) {
      throw new Error(`力量体系“${entry.name}”的记录 id 与索引不一致`);
    }
    records.set(record.id, record);
  }
  for (const change of selectedChanges) {
    const match =
      /^world\/power-systems\/(?:records|pages)\/([a-z0-9-]+)\.(?:json|md)$/u.exec(
        change.targetPath,
      );
    if (match && !index.systems.some((entry) => entry.id === match[1])) {
      throw new Error(`提案文件未被最终 index.json 引用：${change.targetPath}`);
    }
  }
  validateCoreReferences(meta, index, interactions, records);

  if (!allowSnapshots) {
    for (const change of selectedChanges) {
      const current = await readOptionalText(storage, change.targetPath);
      if (current !== change.afterContent) {
        throw new Error(`提案目标在写入后发生变化：${change.targetPath}`);
      }
    }
  }
}

async function rollbackAppliedChanges(
  storage: WorkbenchStorage,
  changes: readonly LoadedPowerSystemProposalChange[],
): Promise<void> {
  const failures: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      if (change.operation === "create") {
        const current = await readOptionalText(storage, change.targetPath);
        if (current !== change.afterContent) {
          throw new Error("目标文件已变化，无法自动回滚");
        }
        await storage.remove(change.targetPath, { permanent: true });
      } else {
        await storage.writeText(change.targetPath, change.beforeContent, {
          expectedContent: change.afterContent,
        });
      }
    } catch (error) {
      failures.push(`${change.targetPath}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`提案回滚失败：${failures.join("；")}`);
  }
}

async function removeChangeSnapshots(
  storage: WorkbenchStorage,
  proposalId: string,
  changes: readonly LoadedPowerSystemProposalChange[],
): Promise<void> {
  for (const change of changes) {
    for (const side of ["before", "after"] as const) {
      if (side === "before" && change.operation === "create") continue;
      const path = powerSystemProposalSnapshotPath(
        proposalId,
        side,
        change.targetPath,
      );
      const [info] = await storage.stat([path]);
      if (info?.exists) await storage.remove(path, { permanent: true });
    }
  }
}

export function getPowerSystemProposalStatus(
  proposal: Pick<LoadedPowerSystemProposal, "manifest">,
): PowerSystemProposalStatus {
  const statuses = proposal.manifest.changes.map((change) => change.status);
  if (statuses.every((status) => status === "applied")) return "applied";
  if (statuses.every((status) => status === "rejected")) return "rejected";
  if (statuses.some((status) => status === "applied")) {
    return "partially-applied";
  }
  return "pending";
}

export function createNovelPowerSystemProposalRepository(
  storage: WorkbenchStorage,
): NovelPowerSystemProposalRepository {
  const load = async (
    proposalId: string,
  ): Promise<LoadedPowerSystemProposal> => {
    const manifestPath = powerSystemProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const manifest = parsePowerSystemProposalManifest(
      manifestFile.content,
      manifestPath,
    );
    if (manifest.proposalId !== proposalId) {
      throw new Error(`提案目录与 proposalId 不一致：${proposalId}`);
    }
    const changes = await Promise.all(
      manifest.changes.map(
        async (change): Promise<LoadedPowerSystemProposalChange> => {
          const currentContent = await readOptionalText(
            storage,
            change.targetPath,
          );
          try {
            const beforeContent =
              change.operation === "modify"
                ? (
                    await storage.readText(
                      powerSystemProposalSnapshotPath(
                        proposalId,
                        "before",
                        change.targetPath,
                      ),
                    )
                  ).content
                : "";
            const afterContent = (
              await storage.readText(
                powerSystemProposalSnapshotPath(
                  proposalId,
                  "after",
                  change.targetPath,
                ),
              )
            ).content;
            return {
              ...change,
              beforeContent,
              afterContent,
              currentContent,
              conflict:
                change.status === "pending" &&
                (change.operation === "create"
                  ? currentContent !== null
                  : currentContent !== beforeContent),
              loadError: null,
            };
          } catch (error) {
            return {
              ...change,
              beforeContent: "",
              afterContent: "",
              currentContent,
              conflict: false,
              loadError: errorMessage(error),
            };
          }
        },
      ),
    );
    return Object.freeze({
      manifest,
      manifestPath,
      manifestContent: manifestFile.content,
      changes: Object.freeze(changes),
    });
  };

  const repository: NovelPowerSystemProposalRepository = {
    async list() {
      const [directory] = await storage.stat([
        POWER_SYSTEM_PROPOSALS_DIRECTORY,
      ]);
      if (!directory?.exists) {
        return Object.freeze({
          proposals: Object.freeze([]),
          errors: Object.freeze([]),
        });
      }
      const entries = (
        await storage.list(POWER_SYSTEM_PROPOSALS_DIRECTORY)
      ).filter((entry) => entry.kind === "directory");
      const settled = await Promise.allSettled(
        entries.map((entry) => load(entry.name)),
      );
      const proposals: LoadedPowerSystemProposal[] = [];
      const errors: PowerSystemProposalLoadError[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") proposals.push(result.value);
        else {
          errors.push({
            proposalId: entries[index]?.name ?? "unknown",
            message: errorMessage(result.reason),
          });
        }
      });
      proposals.sort(
        (left, right) =>
          Date.parse(right.manifest.createdAt) -
          Date.parse(left.manifest.createdAt),
      );
      return Object.freeze({
        proposals: Object.freeze(proposals),
        errors: Object.freeze(errors),
      });
    },

    load,

    async deleteProposals(proposalIds) {
      const ids = [...new Set(proposalIds)];
      if (ids.length === 0) throw new Error("请至少选择一份待删除提案");
      for (const id of ids) {
        if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
          throw new Error(`提案 ID 非法：${id}`);
        }
      }
      for (const id of ids) {
        await storage.remove(`${POWER_SYSTEM_PROPOSALS_DIRECTORY}/${id}`, {
          permanent: true,
        });
      }
    },

    async apply(proposalId, changeIds) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待应用变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (selected.length !== selectedIds.size) {
        throw new Error("选择中包含不存在的提案变更");
      }
      const unavailable = selected.find(
        (change) =>
          change.status !== "pending" || change.conflict || change.loadError,
      );
      if (unavailable) {
        throw new Error(
          unavailable.loadError ??
            (unavailable.conflict
              ? `目标文件已变化，无法应用：${unavailable.targetPath}`
              : `变更已处理：${unavailable.id}`),
        );
      }
      await validateProspectiveLibrary(storage, selected, true);

      const applied: LoadedPowerSystemProposalChange[] = [];
      try {
        for (const change of selected) {
          if (change.operation === "create") {
            await storage.createText(change.targetPath, change.afterContent, {
              createParents: true,
            });
          } else {
            await storage.writeText(change.targetPath, change.afterContent, {
              expectedContent: change.beforeContent,
            });
          }
          applied.push(change);
        }
        await validateProspectiveLibrary(storage, selected, false);
        const nextManifest = updateManifestChanges(
          proposal.manifest,
          selectedIds,
          "applied",
        );
        await storage.writeText(
          proposal.manifestPath,
          serializePowerSystemProposalManifest(nextManifest),
          { expectedContent: proposal.manifestContent },
        );
      } catch (error) {
        try {
          await rollbackAppliedChanges(storage, applied);
        } catch (rollbackError) {
          throw new Error(
            `${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
      return load(proposalId);
    },

    async reject(proposalId, changeIds) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待拒绝变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (
        selected.length !== selectedIds.size ||
        selected.some((change) => change.status !== "pending")
      ) {
        throw new Error("只能拒绝存在且尚未处理的变更");
      }
      const nextManifest = updateManifestChanges(
        proposal.manifest,
        selectedIds,
        "rejected",
      );
      await storage.writeText(
        proposal.manifestPath,
        serializePowerSystemProposalManifest(nextManifest),
        { expectedContent: proposal.manifestContent },
      );
      return load(proposalId);
    },

    async delete(proposalId, changeIds) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待删除变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (
        selected.length !== selectedIds.size ||
        selected.some((change) => change.status !== "pending")
      ) {
        throw new Error("只能删除存在且尚未处理的变更");
      }
      if (selected.length === proposal.changes.length) {
        await storage.remove(
          `${POWER_SYSTEM_PROPOSALS_DIRECTORY}/${proposalId}`,
          { permanent: true },
        );
        return null;
      }
      const nextManifest: PowerSystemProposalManifest = {
        ...proposal.manifest,
        changes: proposal.manifest.changes.filter(
          (change) => !selectedIds.has(change.id),
        ),
      };
      await storage.writeText(
        proposal.manifestPath,
        serializePowerSystemProposalManifest(nextManifest),
        { expectedContent: proposal.manifestContent },
      );
      await removeChangeSnapshots(storage, proposalId, selected);
      return load(proposalId);
    },
  };
  return Object.freeze(repository);
}
