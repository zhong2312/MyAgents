import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  characterProposalManifestPath,
  CHARACTER_PROPOSALS_DIRECTORY,
  parseCharacterProposalManifest,
  serializeCharacterProposalManifest,
  type CharacterProposalManifest,
  type CharacterProposalOperation,
} from "../entities/characterProposalSchema";
import {
  createNovelCharacterLibraryRepository,
  loadCharacterRecords,
  validateCharacterLibraryReferences,
  type LoadedCharacterLibrary,
} from "./characterLibraryRepository";
import {
  parseCharacterLibraryMeta,
  serializeCharacterLibraryFile,
  type CharacterGroupDefinition,
  type CharacterRecord,
  type CharacterSoulDefinition,
  type RaceDefinition,
} from "../entities/characterLibrarySchema";

export interface LoadedCharacterProposal {
  readonly manifest: CharacterProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface CharacterProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface CharacterProposalListResult {
  readonly proposals: readonly LoadedCharacterProposal[];
  readonly errors: readonly CharacterProposalLoadError[];
}

export interface NovelCharacterProposalRepository {
  list(): Promise<CharacterProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedCharacterProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedCharacterProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseMeta(value: unknown): LoadedCharacterLibrary["meta"] {
  return parseCharacterLibraryMeta(serializeCharacterLibraryFile(value));
}

function applyDefinition<T extends { id: string }>(
  current: readonly T[],
  operation: CharacterProposalOperation,
): T[] {
  const value = operation.value as unknown as T;
  if (operation.action === "create") {
    if (current.some((entry) => entry.id === value.id)) {
      throw new Error(`候选要创建的 id 已存在：${value.id}`);
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
  if (!found) throw new Error(`候选要更新的 id 不存在：${targetId}`);
  return next;
}

function buildCandidateLibrary(
  library: LoadedCharacterLibrary,
  sourceCharacters: readonly CharacterRecord[],
  operations: readonly CharacterProposalOperation[],
): {
  readonly meta: LoadedCharacterLibrary["meta"];
  readonly characters: readonly CharacterRecord[];
  readonly hasMetaChanges: boolean;
  readonly changedCharacters: readonly CharacterRecord[];
} {
  let races: readonly RaceDefinition[] = library.meta.races;
  let groups: readonly CharacterGroupDefinition[] = library.meta.groups;
  let souls: readonly CharacterSoulDefinition[] = library.meta.souls;
  let characters: readonly CharacterRecord[] = sourceCharacters;
  let hasMetaChanges = false;
  const changedCharacterIds = new Set<string>();

  for (const operation of operations) {
    if (operation.kind === "race") {
      races = applyDefinition(races, operation);
      hasMetaChanges = true;
    } else if (operation.kind === "group") {
      groups = applyDefinition(groups, operation);
      hasMetaChanges = true;
    } else if (operation.kind === "soul") {
      souls = applyDefinition(souls, operation);
      hasMetaChanges = true;
    } else {
      characters = applyDefinition(characters, operation);
      const changedId =
        operation.action === "update" ? operation.targetId : operation.value.id;
      if (typeof changedId === "string") changedCharacterIds.add(changedId);
    }
  }

  const meta = parseMeta({ ...library.meta, races, groups, souls });
  return {
    meta,
    characters,
    hasMetaChanges,
    changedCharacters: characters.filter((character) =>
      changedCharacterIds.has(character.id),
    ),
  };
}

function characterOperationTargetId(
  operation: CharacterProposalOperation,
): string | null {
  const value = operation.action === "update" ? operation.targetId : operation.value.id;
  return typeof value === "string" ? value : null;
}

function characterOperationConflicts(
  operation: CharacterProposalOperation,
  library: LoadedCharacterLibrary,
  current: readonly CharacterRecord[],
): boolean {
  const targetId = characterOperationTargetId(operation);
  if (!targetId) return true;
  const record =
    operation.kind === "character"
      ? current.find((item) => item.id === targetId)
      : operation.kind === "race"
        ? library.meta.races.find((item) => item.id === targetId)
        : operation.kind === "group"
          ? library.meta.groups.find((item) => item.id === targetId)
          : library.meta.souls.find((item) => item.id === targetId);
  if (operation.action === "create") return record !== undefined;
  if (!record || operation.baseValue === undefined) return true;
  return (
    JSON.stringify(record) !==
    JSON.stringify({ ...operation.baseValue, id: targetId })
  );
}

function updateOperations(
  manifest: CharacterProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): CharacterProposalManifest {
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
  proposal: LoadedCharacterProposal,
  manifest: CharacterProposalManifest,
): Promise<LoadedCharacterProposal> {
  const content = serializeCharacterProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseCharacterProposalManifest(
      proposal.manifestPath,
      file.content,
    ),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

export function createNovelCharacterProposalRepository(
  storage: WorkbenchStorage,
): NovelCharacterProposalRepository {
  const characterRepository = createNovelCharacterLibraryRepository(storage);

  const load = async (proposalId: string): Promise<LoadedCharacterProposal> => {
    const manifestPath = characterProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseCharacterProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error("角色提案目录与 proposalId 不一致");
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  return {
    async list() {
      const [info] = await storage.stat([CHARACTER_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") throw new Error("角色提案路径不是目录");
      const entries = await storage.list(CHARACTER_PROPOSALS_DIRECTORY);
      const proposals: LoadedCharacterProposal[] = [];
      const errors: CharacterProposalLoadError[] = [];
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
      if (operations.length === 0) throw new Error("没有可采纳的角色候选");

      const library = await characterRepository.load();
      const sourceCharacters = await loadCharacterRecords(
        characterRepository,
        library,
      );
      const conflict = operations.find((operation) =>
        characterOperationConflicts(operation, library, sourceCharacters),
      );
      if (conflict) {
        throw new Error(`角色候选“${conflict.summary}”的正式内容已变化，请先解决冲突`);
      }
      const candidate = buildCandidateLibrary(
        library,
        sourceCharacters,
        operations,
      );
      validateCharacterLibraryReferences(candidate.meta, candidate.characters);
      let saved = library;
      let metaSaved = false;
      let charactersSaved = false;
      try {
        if (candidate.hasMetaChanges) {
          saved = await characterRepository.saveMeta(saved, candidate.meta);
          metaSaved = true;
        }
        if (candidate.changedCharacters.length > 0) {
          saved = await characterRepository.saveCharacters(
            saved,
            candidate.changedCharacters,
          );
          charactersSaved = true;
        }
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
          if (charactersSaved) {
            const changedIds = new Set(
              candidate.changedCharacters.map((character) => character.id),
            );
            const previousCharacters = sourceCharacters.filter((character) =>
              changedIds.has(character.id),
            );
            if (previousCharacters.length > 0) {
              saved = await characterRepository.saveCharacters(
                saved,
                previousCharacters,
              );
            }
            const previousIds = new Set(
              previousCharacters.map((character) => character.id),
            );
            for (const character of candidate.changedCharacters) {
              if (!previousIds.has(character.id)) {
                saved = await characterRepository.deleteCharacter(
                  saved,
                  character.id,
                );
              }
            }
          }
          if (metaSaved) {
            await characterRepository.saveMeta(saved, library.meta);
          }
        } catch (rollbackError) {
          throw new Error(
            `角色提案采纳失败，且人物库回滚失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
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
      if (pendingIds.size === 0) throw new Error("没有可拒绝的角色候选");
      return writeManifest(
        storage,
        proposal,
        updateOperations(proposal.manifest, pendingIds, "rejected"),
      );
    },

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${CHARACTER_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}
