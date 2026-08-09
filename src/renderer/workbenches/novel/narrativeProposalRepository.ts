import type { WorkbenchStorage } from "@/workbench-sdk";
import { narrativeRecordPath } from "../../../shared/workbenches/novel/narrativeEngineeringStorage";

import {
  createNarrativeEngineeringRepository,
  type LoadedNarrativeEngineering,
} from "./narrativeEngineeringRepository";
import {
  narrativeChapterPlanSchema,
  narrativeDirectorySchema,
  plotLineSchema,
  storyArcSchema,
  type NarrativeEngineering,
} from "./narrativeEngineeringSchema";
import {
  narrativeProposalManifestPath,
  NARRATIVE_PROPOSALS_DIRECTORY,
  parseNarrativeProposalManifest,
  serializeNarrativeProposalManifest,
  type NarrativeProposalManifest,
} from "./narrativeProposalSchema";
import type {
  NarrativeArcProposalCandidate,
  NarrativeChapterProposalCandidate,
  NarrativeDirectoryProposalCandidate,
  NarrativeLineProposalCandidate,
} from "./narrativeProposalSchema";
import type {
  FileProposal,
  FileProposalChange,
  FileProposalConflictResolution,
  FileProposalRepository,
} from "./fileProposal";

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
  resolveConflict(
    proposalId: string,
    candidateId: string,
    resolution: FileProposalConflictResolution,
  ): Promise<LoadedNarrativeProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function narrativeProposalContentHash(
  value: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type NarrativeProposalCandidate =
  | ({ readonly kind: "line" } & NarrativeLineProposalCandidate)
  | ({ readonly kind: "arc" } & NarrativeArcProposalCandidate)
  | ({ readonly kind: "directory" } & NarrativeDirectoryProposalCandidate)
  | ({ readonly kind: "chapter" } & NarrativeChapterProposalCandidate);

type NarrativeLineCandidate = NarrativeProposalManifest["lines"][number];
type NarrativeArcCandidate = NarrativeProposalManifest["arcs"][number];
type NarrativeDirectoryCandidate =
  NarrativeProposalManifest["directories"][number];
type NarrativeChapterCandidate = NarrativeProposalManifest["chapters"][number];

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
    ...proposal.manifest.directories.map((candidate) => ({
      ...candidate,
      kind: "directory" as const,
    })),
    ...proposal.manifest.chapters.map((candidate) => ({
      ...candidate,
      kind: "chapter" as const,
    })),
  ];
}

function candidateTargetPath(candidate: NarrativeProposalCandidate): string {
  const collection =
    candidate.kind === "line"
      ? "lines"
      : candidate.kind === "arc"
        ? "arcs"
        : candidate.kind === "directory"
          ? "directories"
          : "chapters";
  return narrativeRecordPath(collection, candidate.value.id);
}

function candidateExistingValue(
  candidate: NarrativeProposalCandidate,
  current: NarrativeEngineering,
):
  | NarrativeEngineering["lines"][number]
  | NarrativeEngineering["arcs"][number]
  | NarrativeEngineering["directories"][number]
  | NarrativeEngineering["chapters"][number]
  | undefined {
  if (candidate.kind === "line") {
    return current.lines.find((line) => line.id === candidate.value.id);
  }
  if (candidate.kind === "arc") {
    return current.arcs.find((arc) => arc.id === candidate.value.id);
  }
  if (candidate.kind === "directory") {
    return current.directories.find(
      (directory) => directory.id === candidate.value.id,
    );
  }
  return current.chapters.find((chapter) => chapter.id === candidate.value.id);
}

function candidateBeforeContent(
  candidate: NarrativeProposalCandidate,
  existing: ReturnType<typeof candidateExistingValue>,
): string {
  if (candidate.baseValue !== undefined) {
    return candidate.baseValue === null
      ? ""
      : `${JSON.stringify(candidate.baseValue, null, 2)}\n`;
  }
  return existing ? `${JSON.stringify(existing, null, 2)}\n` : "";
}

function candidateAfterContent(candidate: NarrativeProposalCandidate): string {
  return `${JSON.stringify(candidate.value, null, 2)}\n`;
}

function sameNarrativeValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
      const currentContent = existing
        ? `${JSON.stringify(existing, null, 2)}\n`
        : null;
      const baseContentAvailable = candidate.baseValue !== undefined;
      return {
        id: candidate.candidateId,
        targetPath: candidateTargetPath(candidate),
        operation: existing ? "modify" : "create",
        summary: candidate.summary,
        status: candidate.status,
        beforeContent,
        afterContent,
        currentContent,
        baseContentAvailable,
        conflict:
          candidate.status === "pending" &&
          (baseContentAvailable
            ? candidate.baseValue === null
              ? currentContent !== null
              : currentContent !== beforeContent
            : currentHash !== proposal.manifest.baseSourceHash),
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
    directories: manifest.directories.map((candidate) =>
      candidateIds.has(candidate.candidateId) && candidate.status === "pending"
        ? { ...candidate, status }
        : candidate,
    ),
    chapters: manifest.chapters.map((candidate) =>
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
    manifest: parseNarrativeProposalManifest(
      proposal.manifestPath,
      file.content,
    ),
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
      (candidate) =>
        candidate.status === "pending" && selected.has(candidate.candidateId),
    ),
    ...manifest.arcs.filter(
      (candidate) =>
        candidate.status === "pending" && selected.has(candidate.candidateId),
    ),
    ...manifest.directories.filter(
      (candidate) =>
        candidate.status === "pending" && selected.has(candidate.candidateId),
    ),
    ...manifest.chapters.filter(
      (candidate) =>
        candidate.status === "pending" && selected.has(candidate.candidateId),
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

  const applySelectedCandidates = async (
    proposal: LoadedNarrativeProposal,
    selectedLines: readonly NarrativeLineCandidate[],
    selectedArcs: readonly NarrativeArcCandidate[],
    selectedDirectories: readonly NarrativeDirectoryCandidate[],
    selectedChapters: readonly NarrativeChapterCandidate[],
    current: LoadedNarrativeEngineering,
  ): Promise<LoadedNarrativeProposal> => {
    const currentLineIds = new Set(
      current.library.lines.map((line) => line.id),
    );
    const currentArcIds = new Set(current.library.arcs.map((arc) => arc.id));
    const currentDirectoryIds = new Set(
      current.library.directories.map((directory) => directory.id),
    );
    const currentChapterIds = new Set(
      current.library.chapters.map((chapter) => chapter.id),
    );
    const selectedLinesById = new Map<string, NarrativeLineCandidate>();
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
    const selectedArcsById = new Map<string, NarrativeArcCandidate>();
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
    const selectedDirectoriesById = new Map<
      string,
      NarrativeDirectoryCandidate
    >();
    for (const candidate of selectedDirectories) {
      if (selectedDirectoriesById.has(candidate.value.id)) {
        throw new Error(`同一提案不能重复变更目录：${candidate.value.id}`);
      }
      selectedDirectoriesById.set(candidate.value.id, candidate);
    }
    const nextDirectoryIds = new Set([
      ...currentDirectoryIds,
      ...selectedDirectoriesById.keys(),
    ]);
    const nextArcIds = new Set([
      ...currentArcIds,
      ...selectedArcsById.keys(),
    ]);
    const selectedChaptersById = new Map<string, NarrativeChapterCandidate>();
    for (const candidate of selectedChapters) {
      if (selectedChaptersById.has(candidate.value.id)) {
        throw new Error(`同一提案不能重复变更章节：${candidate.value.id}`);
      }
      if (
        candidate.value.directoryId &&
        !nextDirectoryIds.has(candidate.value.directoryId)
      ) {
        throw new Error(
          `章节“${candidate.value.title}”归属的目录不存在：${candidate.value.directoryId}`,
        );
      }
      const missingLineIds = [
        ...new Set([
          ...candidate.value.lineIds,
          ...candidate.value.sections.flatMap((section) => section.lineIds),
        ]),
      ].filter((lineId) => !nextLineIds.has(lineId));
      if (missingLineIds.length > 0) {
        throw new Error(
          `章节“${candidate.value.title}”引用了不存在的线路：${missingLineIds.join(", ")}`,
        );
      }
      const missingArcIds = [
        ...new Set([
          ...candidate.value.arcIds,
          ...candidate.value.sections.flatMap((section) => section.arcIds),
        ]),
      ].filter((arcId) => !nextArcIds.has(arcId));
      if (missingArcIds.length > 0) {
        throw new Error(
          `章节“${candidate.value.title}”引用了不存在的故事弧：${missingArcIds.join(", ")}`,
        );
      }
      selectedChaptersById.set(candidate.value.id, candidate);
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
      directories: [
        ...current.library.directories.map(
          (directory) =>
            selectedDirectoriesById.get(directory.id)?.value ?? directory,
        ),
        ...selectedDirectories
          .filter((candidate) => !currentDirectoryIds.has(candidate.value.id))
          .map((candidate) => candidate.value),
      ],
      chapters: [
        ...current.library.chapters.map(
          (chapter) => selectedChaptersById.get(chapter.id)?.value ?? chapter,
        ),
        ...selectedChapters
          .filter((candidate) => !currentChapterIds.has(candidate.value.id))
          .map((candidate) => candidate.value),
      ],
    };
    const selectedIds = new Set(
      [
        ...selectedLines,
        ...selectedArcs,
        ...selectedDirectories,
        ...selectedChapters,
      ].map((candidate) => candidate.candidateId),
    );
    let saved: LoadedNarrativeEngineering | null = null;
    try {
      saved = await narrativeRepository.save(current, nextLibrary);
      const nextManifest = updateStatuses(
        proposal.manifest,
        selectedIds,
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
          throw new Error(
            `剧情提案采纳失败且无法回滚：${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
      }
      throw error;
    }
  };

  const candidateConflicts = async (
    proposal: LoadedNarrativeProposal,
    candidate:
      | NarrativeLineCandidate
      | NarrativeArcCandidate
      | NarrativeDirectoryCandidate
      | NarrativeChapterCandidate,
    existing: unknown,
    currentContent: string,
  ): Promise<boolean> => {
    if (candidate.baseValue !== undefined) {
      return candidate.baseValue === null
        ? existing !== undefined
        : !sameNarrativeValue(existing, candidate.baseValue);
    }
    return (
      (await narrativeProposalContentHash(currentContent)) !==
      proposal.manifest.baseSourceHash
    );
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
      const selectedDirectories = proposal.manifest.directories.filter(
        (candidate) =>
          selected.some((item) => item.candidateId === candidate.candidateId),
      );
      const selectedChapters = proposal.manifest.chapters.filter((candidate) =>
        selected.some((item) => item.candidateId === candidate.candidateId),
      );
      const current = await narrativeRepository.load();
      for (const candidate of selectedLines) {
        const existing = current.library.lines.find(
          (line) => line.id === candidate.value.id,
        );
        if (
          await candidateConflicts(
            proposal,
            candidate,
            existing,
            current.content,
          )
        ) {
          throw new Error(
            `线路“${candidate.value.title}”的正式内容已变化，请先解决冲突`,
          );
        }
      }
      for (const candidate of selectedArcs) {
        const existing = current.library.arcs.find(
          (arc) => arc.id === candidate.value.id,
        );
        if (
          await candidateConflicts(
            proposal,
            candidate,
            existing,
            current.content,
          )
        ) {
          throw new Error(
            `故事弧“${candidate.value.title}”的正式内容已变化，请先解决冲突`,
          );
        }
      }
      for (const candidate of selectedDirectories) {
        const existing = current.library.directories.find(
          (directory) => directory.id === candidate.value.id,
        );
        if (
          await candidateConflicts(
            proposal,
            candidate,
            existing,
            current.content,
          )
        ) {
          throw new Error(
            `目录“${candidate.value.title}”的正式内容已变化，请先解决冲突`,
          );
        }
      }
      for (const candidate of selectedChapters) {
        const existing = current.library.chapters.find(
          (chapter) => chapter.id === candidate.value.id,
        );
        if (
          await candidateConflicts(
            proposal,
            candidate,
            existing,
            current.content,
          )
        ) {
          throw new Error(
            `章节“${candidate.value.title}”的正式内容已变化，请先解决冲突`,
          );
        }
      }
      return applySelectedCandidates(
        proposal,
        selectedLines,
        selectedArcs,
        selectedDirectories,
        selectedChapters,
        current,
      );
    },

    async resolveConflict(proposalId, candidateId, resolution) {
      const proposal = await load(proposalId);
      const lineCandidate = proposal.manifest.lines.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      const arcCandidate = proposal.manifest.arcs.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      const directoryCandidate = proposal.manifest.directories.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      const chapterCandidate = proposal.manifest.chapters.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      const candidate =
        lineCandidate ?? arcCandidate ?? directoryCandidate ?? chapterCandidate;
      if (!candidate) throw new Error("剧情候选不存在");
      if (candidate.status !== "pending") {
        throw new Error("已处理的剧情候选不能再次解决冲突");
      }

      const current = await narrativeRepository.load();
      const existing = lineCandidate
        ? current.library.lines.find(
            (line) => line.id === lineCandidate.value.id,
          )
        : arcCandidate
          ? current.library.arcs.find((arc) => arc.id === arcCandidate.value.id)
          : directoryCandidate
            ? current.library.directories.find(
                (directory) => directory.id === directoryCandidate.value.id,
              )
            : current.library.chapters.find(
                (chapter) => chapter.id === chapterCandidate?.value.id,
              );
      const currentCandidateContent = existing
        ? `${JSON.stringify(existing, null, 2)}\n`
        : null;
      if (currentCandidateContent !== resolution.expectedCurrentContent) {
        throw new Error("正式内容在冲突处理期间再次变化，请重新读取后再处理");
      }
      if (
        !(await candidateConflicts(
          proposal,
          candidate,
          existing,
          current.content,
        ))
      ) {
        throw new Error("正式内容当前没有冲突，请直接应用提案");
      }

      let mergedValue: unknown = candidate.value;
      if (resolution.strategy === "merge") {
        try {
          mergedValue = JSON.parse(resolution.content);
        } catch (error) {
          throw new Error(`合并结果不是有效 JSON：${errorMessage(error)}`);
        }
      }
      if (lineCandidate) {
        const value = plotLineSchema.parse(mergedValue);
        if (value.id !== lineCandidate.value.id) {
          throw new Error("合并结果不能修改线路的稳定 ID");
        }
        return applySelectedCandidates(
          proposal,
          [{ ...lineCandidate, value }],
          [],
          [],
          [],
          current,
        );
      }
      if (arcCandidate) {
        const value = storyArcSchema.parse(mergedValue);
        if (value.id !== arcCandidate.value.id) {
          throw new Error("合并结果不能修改故事弧的稳定 ID");
        }
        return applySelectedCandidates(
          proposal,
          [],
          [{ ...arcCandidate, value }],
          [],
          [],
          current,
        );
      }
      if (directoryCandidate) {
        const value = narrativeDirectorySchema.parse(mergedValue);
        if (value.id !== directoryCandidate.value.id) {
          throw new Error("合并结果不能修改目录的稳定 ID");
        }
        return applySelectedCandidates(
          proposal,
          [],
          [],
          [{ ...directoryCandidate, value }],
          [],
          current,
        );
      }
      if (!chapterCandidate) throw new Error("剧情候选不存在");
      const value = narrativeChapterPlanSchema.parse(mergedValue);
      if (value.id !== chapterCandidate.value.id) {
        throw new Error("合并结果不能修改章节的稳定 ID");
      }
      return applySelectedCandidates(
        proposal,
        [],
        [],
        [],
        [{ ...chapterCandidate, value }],
        current,
      );
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

      const currentArcIds = new Set(current.library.arcs.map((arc) => arc.id));
      const currentDirectoryIds = new Set(
        current.library.directories.map((directory) => directory.id),
      );
      const deletedArcIds = new Set(
        proposal.manifest.arcs
          .filter(
            (candidate) =>
              selectedIds.has(candidate.candidateId) &&
              !currentArcIds.has(candidate.value.id),
          )
          .map((candidate) => candidate.value.id),
      );
      const deletedDirectoryIds = new Set(
        proposal.manifest.directories
          .filter(
            (candidate) =>
              selectedIds.has(candidate.candidateId) &&
              !currentDirectoryIds.has(candidate.value.id),
          )
          .map((candidate) => candidate.value.id),
      );
      const dependentChapter = proposal.manifest.chapters.find(
        (candidate) =>
          !selectedIds.has(candidate.candidateId) &&
          candidate.status !== "rejected" &&
          (candidate.value.lineIds.some((lineId) => deletedLineIds.has(lineId)) ||
            candidate.value.arcIds.some((arcId) => deletedArcIds.has(arcId)) ||
            (candidate.value.directoryId !== null &&
              deletedDirectoryIds.has(candidate.value.directoryId))),
      );
      if (dependentChapter) {
        throw new Error(
          `不能删除候选：章节“${dependentChapter.value.title}”仍依赖所选线路、故事弧或目录。请先同时删除或拒绝该章节候选。`,
        );
      }

      const lines = proposal.manifest.lines.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      const arcs = proposal.manifest.arcs.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      const directories = proposal.manifest.directories.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      const chapters = proposal.manifest.chapters.filter(
        (candidate) => !selectedIds.has(candidate.candidateId),
      );
      if (
        lines.length === 0 &&
        arcs.length === 0 &&
        directories.length === 0 &&
        chapters.length === 0
      ) {
        await storage.remove(`${NARRATIVE_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
        return null;
      }

      return writeManifest(storage, proposal, {
        ...proposal.manifest,
        lines,
        arcs,
        directories,
        chapters,
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
 * 剧情事实仍由 NarrativeProposalRepository 校验并通过目录化 Repository 写入；
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

    async resolveConflict(
      proposalId: string,
      changeId: string,
      resolution: FileProposalConflictResolution,
      projectTitle: string,
    ) {
      void projectTitle;
      return materialize(
        await proposalRepository.resolveConflict(
          proposalId,
          changeId,
          resolution,
        ),
      );
    },

    async reject(proposalId: string, changeIds: readonly string[]) {
      return materialize(
        await proposalRepository.reject(proposalId, changeIds),
      );
    },

    async delete(proposalId: string, changeIds: readonly string[]) {
      const proposal = await proposalRepository.delete(proposalId, changeIds);
      return proposal ? materialize(proposal) : null;
    },
  });
}
