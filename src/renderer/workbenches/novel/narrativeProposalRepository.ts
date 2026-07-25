import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNarrativeEngineeringRepository,
  type LoadedNarrativeEngineering,
} from "./narrativeEngineeringRepository";
import {
  narrativeProposalManifestPath,
  NARRATIVE_PROPOSALS_DIRECTORY,
  parseNarrativeProposalManifest,
  serializeNarrativeProposalManifest,
  type NarrativeProposalManifest,
} from "./narrativeProposalSchema";

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
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
      if ((await sha256(current.content)) !== proposal.manifest.baseSourceHash) {
        throw new Error("剧情事实源已变化，请重新读取后再审阅提案");
      }
      const lineIds = new Set(current.library.lines.map((line) => line.id));
      selectedLines.forEach((candidate) => {
        if (lineIds.has(candidate.value.id)) throw new Error(`线路 id 已存在：${candidate.value.id}`);
        lineIds.add(candidate.value.id);
      });
      selectedArcs.forEach((candidate) => {
        if (current.library.arcs.some((arc) => arc.id === candidate.value.id)) {
          throw new Error(`故事弧 id 已存在：${candidate.value.id}`);
        }
        const missing = candidate.value.lineIds.filter((lineId) => !lineIds.has(lineId));
        if (missing.length > 0) throw new Error(`故事弧“${candidate.value.title}”引用了未采纳线路：${missing.join(", ")}`);
      });
      const nextLibrary = {
        ...current.library,
        lines: [...current.library.lines, ...selectedLines.map((candidate) => candidate.value)],
        arcs: [...current.library.arcs, ...selectedArcs.map((candidate) => candidate.value)],
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
          baseSourceHash: await sha256(saved.content),
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

    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds)) {
        await storage.remove(`${NARRATIVE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },
  };
}
