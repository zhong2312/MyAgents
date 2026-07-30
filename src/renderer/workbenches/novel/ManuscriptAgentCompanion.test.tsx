import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useWorkbenchStorageMock = vi.hoisted(() => vi.fn());

vi.mock("@/workbench-host/useWorkbenchStorage", () => ({
  useWorkbenchStorage: useWorkbenchStorageMock,
}));

vi.mock("@/workbench-sdk/DiffViewer", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div
      data-testid="manuscript-diff"
      data-original={original}
      data-modified={modified}
    />
  ),
}));

import {
  serializeManuscriptProposal,
  type ManuscriptProposal,
} from "../../../shared/workbenches/novel/manuscriptProposalSchema";
import ManuscriptAgentCompanion from "./ManuscriptAgentCompanion";
import { NovelMemoryStorage } from "./testStorage";

function createProposal(): ManuscriptProposal {
  const sourceContent = "旧段一\n\n旧段二";
  return {
    schemaVersion: 1,
    proposalId: "proposal-draft-manuscript-1",
    draftId: "draft-manuscript-1",
    runId: "manuscript-run-1",
    title: "第一章 · 润色",
    description: "",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    source: {
      chapterId: "chapter-000001",
      chapterTitle: "第一章",
      chapterPath: "manuscript/chapters/000001.md",
      sourceHash: "a".repeat(64),
      sourceContent,
      rangeStart: 0,
      rangeEnd: sourceContent.length,
      mode: "revise",
    },
    candidate: {
      id: "candidate-1",
      status: "pending",
      content: "新段一\n\n新段二",
      appliedContent: null,
    },
  };
}

function renderCompanion(storage: NovelMemoryStorage, isAgentRunning = false) {
  useWorkbenchStorageMock.mockReturnValue(storage);
  return render(
    <ManuscriptAgentCompanion
      workspacePath="F:/novels/test"
      conversationKey="chapter-000001.revise.manuscript-run-1"
      companionId="manuscript-review"
      context={{
        runId: "manuscript-run-1",
        chapterId: "chapter-000001",
      }}
      isAgentRunning={isAgentRunning}
    />,
  );
}

describe("ManuscriptAgentCompanion", () => {
  it("keeps the review area in a visible waiting state until the Agent submits", async () => {
    renderCompanion(new NovelMemoryStorage({}), true);

    expect(await screen.findByText("Agent 正在准备正文")).toBeInTheDocument();
    expect(screen.getByText("等待 Agent 提交候选")).toBeInTheDocument();
    expect(screen.queryByTestId("manuscript-diff")).not.toBeInTheDocument();
  });

  it("shows the exact diff and applies only the selected candidate paragraphs", async () => {
    const proposal = createProposal();
    const storage = new NovelMemoryStorage({
      [proposal.source.chapterPath]: proposal.source.sourceContent,
      [`manuscript/proposals/${proposal.proposalId}/proposal.json`]:
        serializeManuscriptProposal(proposal),
    });
    renderCompanion(storage);

    const diff = await screen.findByTestId("manuscript-diff");
    expect(diff).toHaveAttribute(
      "data-original",
      proposal.source.sourceContent,
    );
    expect(diff).toHaveAttribute("data-modified", proposal.candidate.content);

    fireEvent.click(screen.getByRole("button", { name: "逐段选择" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "新段一" }));
    fireEvent.click(screen.getByRole("button", { name: "应用为新修订" }));

    await waitFor(() => {
      expect(storage.getText(proposal.source.chapterPath)).toBe("新段二");
      expect(screen.getByText("已应用")).toBeInTheDocument();
    });
  });
});
