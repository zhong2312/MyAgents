import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNarrativeEngineeringRepository,
  type LoadedNarrativeEngineering,
} from "./narrativeEngineeringRepository";
import type { NarrativeEngineering } from "./narrativeEngineeringSchema";
import {
  narrativeProposalManifestPath,
  NARRATIVE_PROPOSALS_DIRECTORY,
  parseNarrativeProposalManifest,
  serializeNarrativeProposalManifest,
  type NarrativeProposalManifest,
} from "./narrativeProposalSchema";
import type {
  NarrativeArcProposalCandidate,
  NarrativeLineProposalCandidate,
} from "./narrativeProposalSchema";
import type {
  FileProposal,
  FileProposalChange,
  FileProposalRepository,
} from "./WorldProposalReview";

export interface LoadedNarrativeProposal {
  readonly manifest: NarrativeProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
}

export interface NarrativeProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface NarrativeProposalListResult {
  readonly proposals: readonly LoadedNarrativeProposal[];
  readonly errors: readonly NarrativeProposalLoadError[];
}

export interface NarrativeProposalRepository {
  list(): Promise<NarrativeProposalListResult>;
  apply(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedNarrativeProposal>;
  reject(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedNarrativeProposal>;
  delete(
    proposalId: string,
    candidateIds: readonly string[],
  ): Promise<LoadedNarrativeProposal | null>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function narrativeProposalContentHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type NarrativeProposalCandidate =
  | ({ readonly kind: "line" } & NarrativeLineProposalCandidate)
  | ({ readonly kind: "arc" } & NarrativeArcProposalCandidate);

function proposalCandidates(
  proposal: LoadedNarrativeProposal,
): readonly NarrativeProposalCandidate[] {
  return [
    ...proposal.manifest.lines.map((candidate) => ({
      ...candidate,
      kind: "line" as const,
    })),
    ...proposal.manifest.arcs.map((candidate) => ({
      ...candidate,
      kind: "arc" as const,
    })),
  ];
}

function candidateTargetPath(candidate: NarrativeProposalCandidate): string {
  return `narrative/${candidate.kind === "line" ? "lines" : "arcs"}/${candidate.value.id}.json`;
}

function candidateExistingValue(
  candidate: NarrativeProposalCandidate,
  current: NarrativeEngineering,
): NarrativeEngineering["lines"][number] | NarrativeEngineering["arcs"][number] | undefined {
  return candidate.kind === "line"
    ? current.lines.find((line) => line.id === candidate.value.id)
    : current.arcs.find((arc) => arc.id === candidate.value.id);
}

function candidateBeforeContent(
  candidate: NarrativeProposalCandidate,
  existing: ReturnType<typeof candidateExistingValue>,
): string {
  if (existing) return `${JSON.stringify(existing, null, 2)}\n`;
  return `${JSON.stringify(
    {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      status: "not-applied",
    },
    null,
    2,
  )}\n`;
}

function candidateAfterContent(candidate: NarrativeProposalCandidate): string {
  return `${JSON.stringify(candidate.value, null, 2)}\n`;
}

function asFileProposal(
  proposal: LoadedNarrativeProposal,
  current: LoadedNarrativeEngineering,
  currentHash: string,
): FileProposal {
  const changes: FileProposalChange[] = proposalCandidates(proposal).map(
    (candidate) => {
      const existing = candidateExistingValue(candidate, current.library);
      const beforeContent = candidateBeforeContent(candidate, existing);
      const afterContent = candidateAfterContent(candidate);
      return {
        id: candidate.candidateId,
        targetPath: candidateTargetPath(candidate),
        operation: existing ? "modify" : "create",
        summary: candidate.summary,
        status: candidate.status,
        beforeContent,
        afterContent,
        conflict:
          candidate.status === "pending" &&
          currentHash !== proposal.manifest.baseSourceHash,
        loadError: null,
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

function updateStatuses(
  manifest: NarrativeProposalManifest,
  candidateIds: ReadonlySet<string>,
  status: "applied" | "rejected",
): NarrativeProposalManifest {
  return {
    ...manifest,
    lines: manifest.lines.map((candidate) =>
      candidateIds.has(candidate.candidateId) && candidate.status === "pending"
        ? { ...candidate, status }
        : candidate,
    ),
    arcs: manifest.arcs.map((candidate) =>
      candidateIds.has(candidate.candidateId) && candidate.status === "pending"
        ? { ...candidate, status }
        : candidate,
    ),
  };
}

async function writeManifest(
  storage: WorkbenchStorage,
  proposal: LoadedNarrativeProposal,
  manifest: NarrativeProposalManifest,
): Promise<LoadedNarrativeProposal> {
  const content = serializeNarrativeProposalManifest(manifest);
  const file = await storage.writeText(proposal.manifestPath, content, {
    expectedContent: proposal.manifestContent,
  });
  return {
    manifest: parseNarrativeProposalManifest(proposal.manifestPath, file.content),
    manifestPath: proposal.manifestPath,
    manifestContent: file.content,
  };
}

function selectedCandidates(
  manifest: NarrativeProposalManifest,
  candidateIds: readonly string[],
) {
  const selected = new Set(candidateIds);
  return [
    ...manifest.lines.filter(
      (candidate) => candidate.status === "pending" && selected.has(candidate.candidateId),
    ),
    ...manifest.arcs.filter(
      (candidate) => candidate.status === "pending" && selected.has(candidate.candidateId),
    ),
  ];
}

export function createNarrativeProposalRepository(
  storage: WorkbenchStorage,
): NarrativeProposalRepository {
  const narrativeRepository = createNarrativeEngineeringRepository(storage);

  const load = async (proposalId: string): Promise<LoadedNarrativeProposal> => {
    const manifestPath = narrativeProposalManifestPath(proposalId);
    const file = await storage.readText(manifestPath);
    const manifest = parseNarrativeProposalManifest(manifestPath, file.content);
    if (manifest.proposalId !== proposalId) {
      throw new Error("剧情提案目录与 proposalId 不一致");
    }
    return { manifest, manifestPath, manifestContent: file.content };
  };

  return {
    async list() {
      const [info] = await storage.stat([NARRATIVE_PROPOSALS_DIRECTORY]);
      if (!info?.exists) return { proposals: [], errors: [] };
      if (info.kind !== "directory") throw new Error("剧情提案路径不是目录");
      const entries = await storage.list(NARRATIVE_PROPOSALS_DIRECTORY);
      const proposals: LoadedNarrativeProposal[] = [];
      const errors: NarrativeProposalLoadError[] = [];
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
      const selected = selectedCandidates(proposal.manifest, candidateIds);
      if (selected.length === 0) throw new Error("没有可采纳的剧情候选");
      const selectedLines = proposal.manifest.lines.filter((candidate) =>
        selected.some((item) => item.candidateId === candidate.candidateId),
      );
      const selectedArcs = proposal.manifest.arcs.filter((candidate) =>
        selected.some((item) => item.candidateId === candidate.candidateId),
      );
      const current = await narrativeRepository.load();
      if (
        (await narrativeProposalContentHash(current.content)) !==
        proposal.manifest.baseSourceHash
      ) {
        throw new Error("剧情事实源已变化，请重新读取后再审阅提案");
      }
      const currentLineIds = new Set(current.library.lines.map((line) => line.id));
      const currentArcIds = new Set(current.library.arcs.map((arc) => arc.id));
      const selectedLinesById = new Map<string, (typeof selectedLines)[number]>();
      for (const candidate of selectedLines) {
        if (selectedLinesById.has(candidate.value.id)) {
          throw new Error(`同一提案不能重复变更线路：${candidate.value.id}`);
        }
        selectedLinesById.set(candidate.value.id, candidate);
      }
      const nextLineIds = new Set([
        ...currentLineIds,
        ...selectedLinesById.keys(),
      ]);
      const selectedArcsById = new Map<string, (typeof selectedArcs)[number]>();
      for (const candidate of selectedArcs) {
        if (selectedArcsById.has(candidate.value.id)) {
          throw new Error(`同一提案不能重复变更故事弧：${candidate.value.id}`);
        }
        const missing = candidate.value.lineIds.filter(
          (lineId) => !nextLineIds.has(lineId),
        );
        if (missing.length > 0) {
          throw new Error(
            `故事弧“${candidate.value.title}”引用了不存在的线路：${missing.join(", ")}`,
          );
        }
        selectedArcsById.set(candidate.value.id, candidate);
      }
      const nextLibrary = {
        ...current.library,
        lines: [
          ...current.library.lines.map(
            (line) => selectedLinesById.get(line.id)?.value ?? line,
          ),
          ...selectedLines
            .filter((candidate) => !currentLineIds.has(candidate.value.id))
            .map((candidate) => candidate.value),
        ],
        arcs: [
          ...current.library.arcs.map(
            (arc) => selectedArcsById.get(arc.id)?.value ?? arc,
          ),
          ...selectedArcs
            .filter((candidate) => !currentArcIds.has(candidate.value.id))
            .map((candidate) => candidate.value),
        ],
      };
      let saved: LoadedNarrativeEngineering | null = null;
      try {
        saved = await narrativeRepository.save(current, nextLibrary);
        const nextManifest = updateStatuses(
          proposal.manifest,
          new Set(selected.map((candidate) => candidate.candidateId)),
          "applied",
        );
        return await writeManifest(storage, proposal, {
          ...nextManifest,
          baseSourceHash: await narrativeProposalContentHash(saved.content),
        });
      } catch (error) {
        if (saved) {
          try {
            await narrativeRepository.save(saved, current.library);
          } catch (rollbackError) {
            throw new Error(`剧情提案采纳失败且无法回滚：${errorMessage(error)}；${errorMessage(rollbackError)}`);
          }
        }
        throw error;
      }
    },

    async reject(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const selected = selectedCandidates(proposal.manifest, candidateIds);
      if (selected.length === 0) throw new Error("没有可拒绝的剧情候选");
      return writeManifest(
        storage,
        proposal,
        updateStatuses(
          proposal.manifest,
          new Set(selected.map((candidate) => candidate.candidateId)),
          "rejected",
        ),
      );
    },

    async delete(proposalId, candidateIds) {
      const proposal = await load(proposalId);
      const selected = selectedCandidates(proposal.manifest, candidateIds);
      if (selected.length === 0) {
        throw new Error("没有可删除的剧情候选");
      }

      const selectedIds = new Set(
        selected.map((candidate) => candidate.candidateId),
      );
      const current = await narrativeRepository.load();
      const currentLineIds = new Set(
        current.library.lines.map((line) => line.id),
      );
      const deletedLineIds = new Set(
        proposal.manifest.lines
          .filter(
            (candidate) =>
              selectedIds.has(candidate.candidateId) &&
              !currentLineIds.has(candidate.value.id),
          )
          .map((candidate) => candidate.value.id),
      );
      const dependentArc = proposal.manifest.arcs.find(
        (candidate) =>
          !selectedIds.has(candidate.candidateId) &&
          candidate.status !== "rejected" &&
          candidate.value.lineIds.some((lineId) => deletedLineIds.has(lineId)),
      );
      if (dependentArc) {
        throw new Error(
          `不能删除线路候选：故事弧“${dependentArc.value.title}”仍依赖其中的线路。请先同时删除或拒绝该故事弧候选。`,
        );
      }

      const lines = proposal.manifest.lines.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      const arcs = proposal.manifest.arcs.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      if (lines.length === 0 && arcs.length === 0) {
        await storage.remove(`${NARRATIVE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
        return null;
      }

      return writeManifest(storage, proposal, {
        ...proposal.manifest,
        lines,
        arcs,
      });
    },

    async deleteProposals(proposalIds) {
      const selectedIds = [...new Set(proposalIds)];
      if (selectedIds.length === 0) {
        throw new Error("请至少选择一份待删除的剧情提案");
      }
      for (const proposalId of selectedIds) {
        narrativeProposalManifestPath(proposalId);
      }
      for (const proposalId of selectedIds) {
        await storage.remove(`${NARRATIVE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}

/**
 * 将剧情领域的候选提案投影为通用文件变更提案。
 *
 * 剧情事实仍由 NarrativeProposalRepository 校验并写入 narrative/index.json；
 * 此适配器只复用世界架构的提案列表、差异查看和逐项审阅交互。
 */
export function createNarrativeFileProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const proposalRepository = createNarrativeProposalRepository(storage);
  const narrativeRepository = createNarrativeEngineeringRepository(storage);

  const loadCurrent = async (): Promise<{
    readonly current: LoadedNarrativeEngineering;
    readonly hash: string;
  }> => {
    const current = await narrativeRepository.load();
    return {
      current,
      hash: await narrativeProposalContentHash(current.content),
    };
  };

  const materialize = async (
    proposal: LoadedNarrativeProposal,
  ): Promise<FileProposal> => {
    const snapshot = await loadCurrent();
    return asFileProposal(proposal, snapshot.current, snapshot.hash);
  };

  return Object.freeze({
    async list() {
      const [result, snapshot] = await Promise.all([
        proposalRepository.list(),
        loadCurrent(),
      ]);
      return {
        proposals: result.proposals.map((proposal) =>
          asFileProposal(proposal, snapshot.current, snapshot.hash),
        ),
        errors: result.errors,
      };
    },

    async deleteProposals(proposalIds: readonly string[]) {
      await proposalRepository.deleteProposals(proposalIds);
    },

    async apply(
      proposalId: string,
      changeIds: readonly string[],
      projectTitle: string,
    ) {
      void projectTitle;
      return materialize(await proposalRepository.apply(proposalId, changeIds));
    },

    async reject(proposalId: string, changeIds: readonly string[]) {
      return materialize(await proposalRepository.reject(proposalId, changeIds));
    },

    async delete(proposalId: string, changeIds: readonly string[]) {
      const proposal = await proposalRepository.delete(proposalId, changeIds);
      return proposal ? materialize(proposal) : null;
    },
  });
}
