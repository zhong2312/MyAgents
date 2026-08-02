import type { WorkbenchStorage } from "@/workbench-sdk";
import {
  manuscriptProposalSchema,
  serializeManuscriptProposal,
  type ManuscriptProposal,
} from "../../../shared/workbenches/novel/manuscriptProposalSchema";
import { createManuscriptVersionRepository } from "./manuscriptVersionRepository";

const PROPOSAL_ROOT = "manuscript/proposals";

export interface LoadedManuscriptProposal {
  readonly proposal: ManuscriptProposal;
  readonly content: string;
  readonly currentChapterContent: string | null;
  readonly conflict: boolean;
}

function proposalPath(proposalId: string): string {
  return `${PROPOSAL_ROOT}/${proposalId}/proposal.json`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextChapterContent(
  proposal: ManuscriptProposal,
  replacement: string,
): string {
  const { source } = proposal;
  const spacer =
    source.mode === "continue" &&
    source.rangeStart > 0 &&
    !source.sourceContent.slice(0, source.rangeStart).endsWith("\n")
      ? "\n\n"
      : "";
  return `${source.sourceContent.slice(0, source.rangeStart)}${spacer}${replacement}${source.sourceContent.slice(source.rangeEnd)}`;
}

export function createManuscriptProposalRepository(storage: WorkbenchStorage) {
  const loadOne = async (
    proposalId: string,
  ): Promise<LoadedManuscriptProposal> => {
    const file = await storage.readText(proposalPath(proposalId));
    const proposal = manuscriptProposalSchema.parse(JSON.parse(file.content));
    let currentChapterContent: string | null = null;
    try {
      currentChapterContent = (
        await storage.readText(proposal.source.chapterPath)
      ).content;
    } catch {
      currentChapterContent = null;
    }
    return {
      proposal,
      content: file.content,
      currentChapterContent,
      conflict:
        proposal.candidate.status === "pending" &&
        currentChapterContent !== proposal.source.sourceContent,
    };
  };

  return Object.freeze({
    async list(): Promise<readonly LoadedManuscriptProposal[]> {
      const [root] = await storage.stat([PROPOSAL_ROOT]);
      if (!root?.exists) return [];
      const entries = await storage.list(PROPOSAL_ROOT);
      const proposals = await Promise.all(
        entries
          .filter((entry) => entry.kind === "directory")
          .map(async (entry) => {
            try {
              return await loadOne(entry.name);
            } catch {
              return null;
            }
          }),
      );
      return proposals
        .filter((proposal): proposal is LoadedManuscriptProposal =>
          Boolean(proposal),
        )
        .sort((left, right) =>
          right.proposal.createdAt.localeCompare(left.proposal.createdAt),
        );
    },

    async apply(
      loaded: LoadedManuscriptProposal,
      contentOverride?: string,
    ): Promise<LoadedManuscriptProposal> {
      if (loaded.proposal.candidate.status !== "pending") {
        throw new Error("该正文候选已经处理");
      }
      const current = await storage.readText(
        loaded.proposal.source.chapterPath,
      );
      if (current.content !== loaded.proposal.source.sourceContent) {
        throw new Error("正文已在生成后发生变化，请重新生成候选");
      }
      const replacement = contentOverride ?? loaded.proposal.candidate.content;
      if (!replacement.trim()) throw new Error("至少保留一个候选段落");
      const nextContent = nextChapterContent(loaded.proposal, replacement);
      await storage.writeText(loaded.proposal.source.chapterPath, nextContent, {
        expectedContent: current.content,
      });
      // AI 采纳也落版本快照（source=ai-apply），保证用户无需手动保存即可回滚。
      try {
        await createManuscriptVersionRepository(storage).create(
          {
            id: loaded.proposal.source.chapterId,
            title: loaded.proposal.source.chapterTitle,
          },
          nextContent,
          "ai-apply",
        );
      } catch (versionError) {
        try {
          await storage.writeText(
            loaded.proposal.source.chapterPath,
            current.content,
            { expectedContent: nextContent },
          );
        } catch (rollbackError) {
          throw new Error(
            `正文已写入，但历史版本创建和正文回滚均失败：${errorMessage(versionError)}；${errorMessage(rollbackError)}`,
          );
        }
        throw new Error(
          `正文已采纳，但历史版本创建失败，已回滚：${errorMessage(versionError)}`,
        );
      }
      const proposal: ManuscriptProposal = {
        ...loaded.proposal,
        updatedAt: new Date().toISOString(),
        candidate: {
          ...loaded.proposal.candidate,
          status: "applied",
          appliedContent: replacement,
        },
      };
      const content = serializeManuscriptProposal(proposal);
      let file;
      try {
        file = await storage.writeText(
          proposalPath(proposal.proposalId),
          content,
          { expectedContent: loaded.content },
        );
      } catch (error) {
        try {
          await storage.writeText(
            loaded.proposal.source.chapterPath,
            current.content,
            { expectedContent: nextContent },
          );
        } catch (rollbackError) {
          throw new Error(
            `正文已写入，但候选状态更新和正文回滚均失败：${errorMessage(error)}；${errorMessage(rollbackError)}`,
          );
        }
        throw error;
      }
      return {
        proposal,
        content: file.content,
        currentChapterContent: nextContent,
        conflict: false,
      };
    },

    async reject(
      loaded: LoadedManuscriptProposal,
    ): Promise<LoadedManuscriptProposal> {
      if (loaded.proposal.candidate.status !== "pending") return loaded;
      const proposal: ManuscriptProposal = {
        ...loaded.proposal,
        updatedAt: new Date().toISOString(),
        candidate: {
          ...loaded.proposal.candidate,
          status: "rejected",
        },
      };
      const file = await storage.writeText(
        proposalPath(proposal.proposalId),
        serializeManuscriptProposal(proposal),
        { expectedContent: loaded.content },
      );
      return {
        ...loaded,
        proposal,
        content: file.content,
        conflict: false,
      };
    },
  });
}
