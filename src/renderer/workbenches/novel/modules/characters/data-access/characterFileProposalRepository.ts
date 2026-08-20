import type { WorkbenchStorage } from "@/workbench-sdk";

import type {
  FileProposal,
  FileProposalChange,
  FileProposalRepository,
} from "../../../shared/business/fileProposal";
import {
  CHARACTER_PROPOSALS_DIRECTORY,
  characterProposalManifestPath,
  parseCharacterProposalManifest,
  serializeCharacterProposalManifest,
  type CharacterProposalManifest,
  type CharacterProposalOperation,
} from "../entities/characterProposalSchema";
import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
} from "./characterLibraryRepository";
import { createNovelCharacterProposalRepository } from "./characterProposalRepository";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetId(operation: CharacterProposalOperation): string | null {
  const value =
    operation.action === "update" ? operation.targetId : operation.value.id;
  return typeof value === "string" ? value : null;
}

function targetPath(operation: CharacterProposalOperation): string {
  const id = targetId(operation) ?? operation.candidateId;
  if (operation.kind === "character") return `characters/records/${id}.json`;
  // Metadata is stored in the aggregate file; the fragment keeps conflicts object-scoped.
  return `characters/library.json#${operation.kind}/${id}`;
}

function operationChange(
  operation: CharacterProposalOperation,
  current: ReadonlyMap<string, string>,
): FileProposalChange {
  const path = targetPath(operation);
  const currentContent = current.get(path) ?? null;
  const beforeContent =
    operation.action === "update" && operation.baseValue
      ? json(operation.baseValue)
      : "";
  const afterContent = json(operation.value);
  const conflict =
    operation.status === "pending" &&
    (operation.action === "create"
      ? currentContent !== null
      : operation.baseValue === undefined || currentContent !== beforeContent);
  return {
    id: operation.candidateId,
    targetPath: path,
    operation: operation.action === "create" ? "create" : "modify",
    summary: operation.summary,
    status: operation.status,
    beforeContent,
    afterContent,
    currentContent,
    baseContentAvailable:
      operation.action === "create" || operation.baseValue !== undefined,
    conflict,
    loadError: null,
    inferred: false,
  };
}

function asFileProposal(
  manifest: CharacterProposalManifest,
  current: ReadonlyMap<string, string>,
): FileProposal {
  const changes = manifest.operations.map((operation) =>
    operationChange(operation, current),
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

async function loadCurrentContent(
  storage: WorkbenchStorage,
): Promise<ReadonlyMap<string, string>> {
  const repository = createNovelCharacterLibraryRepository(storage);
  const library = await repository.load();
  const records = await loadCharacterRecords(repository, library);
  const content = new Map<string, string>([
    ["characters/index.json", library.indexContent],
    ["characters/library.json", library.metaContent],
  ]);
  records.forEach((record) =>
    content.set(`characters/records/${record.id}.json`, json(record)),
  );
  for (const race of library.meta.races) {
    content.set(`characters/library.json#race/${race.id}`, json(race));
  }
  for (const group of library.meta.groups) {
    content.set(`characters/library.json#group/${group.id}`, json(group));
  }
  for (const soul of library.meta.souls) {
    content.set(`characters/library.json#soul/${soul.id}`, json(soul));
  }
  return content;
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

export function createCharacterFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const domain = createNovelCharacterProposalRepository(storage);
  const load = async (proposalId: string) => {
    const path = characterProposalManifestPath(proposalId);
    const file = await storage.readText(path);
    return {
      manifest: parseCharacterProposalManifest(path, file.content),
      path,
      content: file.content,
    };
  };
  const materialize = async (proposalId: string): Promise<FileProposal> => {
    const [proposal, current] = await Promise.all([
      load(proposalId),
      loadCurrentContent(storage),
    ]);
    return asFileProposal(proposal.manifest, current);
  };
  const repository: FileProposalRepository = {
    async list() {
      const [result, current] = await Promise.all([
        domain.list(),
        loadCurrentContent(storage),
      ]);
      return {
        proposals: result.proposals.map((proposal) =>
          asFileProposal(proposal.manifest, current),
        ),
        errors: result.errors.map((error) => ({
          proposalId: error.proposalId,
          message: error.message,
        })),
      };
    },
    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${CHARACTER_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
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
          `正式内容已变化，不能直接应用：${conflicted.targetPath}`,
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
      const selectedOperations = proposal.manifest.operations.filter(
        (operation) => selected.has(operation.candidateId),
      );
      if (
        selectedOperations.length !== selected.size ||
        selectedOperations.some((operation) => operation.status !== "pending")
      ) {
        throw new Error("只能删除尚未处理的角色提案变更");
      }
      const remaining = proposal.manifest.operations.filter(
        (operation) => !selected.has(operation.candidateId),
      );
      if (remaining.length === proposal.manifest.operations.length) {
        throw new Error("没有可删除的角色提案变更");
      }
      if (remaining.length === 0) {
        await storage.remove(`${CHARACTER_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
        return null;
      }
      await storage.writeText(
        proposal.path,
        serializeCharacterProposalManifest({
          ...proposal.manifest,
          operations: remaining,
        }),
        { expectedContent: proposal.content },
      );
      return materialize(proposalId);
    },
    async resolveConflict(proposalId, changeId, resolution, projectTitle) {
      void projectTitle;
      const loaded = await load(proposalId);
      const proposal = asFileProposal(
        loaded.manifest,
        await loadCurrentContent(storage),
      );
      const change = proposal.changes.find((item) => item.id === changeId);
      if (!change) throw new Error("角色提案变更不存在");
      if (change.currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式内容再次变化，请重新读取后解决冲突");
      }
      const operation = loaded.manifest.operations.find(
        (item) => item.candidateId === changeId,
      );
      if (!operation || operation.status !== "pending") {
        throw new Error("已处理的角色提案不能再次解决冲突");
      }
      const value = parseObject(
        resolution.strategy === "merge"
          ? resolution.content
          : change.afterContent,
      );
      const currentValue =
        change.currentContent === null
          ? undefined
          : parseObject(change.currentContent);
      const resolvedOperation: CharacterProposalOperation = {
        ...operation,
        action: currentValue ? "update" : operation.action,
        targetId:
          currentValue && operation.action === "create"
            ? (targetId(operation) ?? operation.candidateId)
            : operation.targetId,
        baseValue: currentValue ?? operation.baseValue,
        value,
      };
      const resolvedManifestContent = serializeCharacterProposalManifest({
        ...loaded.manifest,
        operations: loaded.manifest.operations.map((item) =>
          item.candidateId === changeId ? resolvedOperation : item,
        ),
      });
      const resolvedManifest = await storage.writeText(
        loaded.path,
        resolvedManifestContent,
        { expectedContent: loaded.content },
      );
      try {
        await domain.apply(proposalId, [changeId]);
      } catch (error) {
        try {
          await storage.writeText(loaded.path, loaded.content, {
            expectedContent: resolvedManifest.content,
          });
        } catch (rollbackError) {
          throw new Error(
            `角色提案冲突解决失败，且无法恢复提案清单：${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
      return materialize(proposalId);
    },
  };
  return Object.freeze(repository);
}
