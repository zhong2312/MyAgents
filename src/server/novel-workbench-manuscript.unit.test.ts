import { createHash } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >(),
  createServer: vi.fn((config: unknown) => ({
    type: "sdk",
    name: "novel-workbench",
    config,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mocks.createServer,
  tool: vi.fn(
    (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      mocks.handlers.set(name, handler);
      return { name };
    },
  ),
}));

import {
  manuscriptProposalSchema,
  serializeManuscriptProposal,
} from "../shared/workbenches/novel/manuscriptProposalSchema";
import {
  clearNovelWorkbenchContext,
  configureNovelWorkbenchRequest,
} from "./novel-workbench-context";
import {
  createNovelWorkbenchDraft,
  hashNovelWorkbenchDraftPayload,
  loadNovelWorkbenchDraft,
  saveNovelWorkbenchDraftValidation,
} from "./novel-workbench-draft";
import { createNovelWorkbenchServer } from "./tools/novel-workbench-tool";

describe("novel manuscript proposal submission", () => {
  let workspace = "";

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.createServer.mockClear();
    workspace = await fs.mkdtemp(join(tmpdir(), "myagents-manuscript-"));
    configureNovelWorkbenchRequest(
      {
        mode: "manuscript",
        promptId: "novel.manuscript.generate",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-1", workspace },
    );
    await createNovelWorkbenchServer();
  });

  afterEach(async () => {
    clearNovelWorkbenchContext();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("recovers when the proposal exists but the draft was not marked submitted", async () => {
    const sourceContent = "旧正文";
    const chapterPath = "manuscript/chapters/000001.md";
    await fs.mkdir(join(workspace, "manuscript", "chapters"), {
      recursive: true,
    });
    await fs.writeFile(join(workspace, chapterPath), sourceContent, "utf8");

    const payload = {
      title: "第一章 · 完整生成",
      description: "",
      runId: "manuscript-run-1",
      chapterId: "chapter-000001",
      chapterTitle: "第一章",
      chapterPath,
      baseSourceHash: createHash("sha256").update(sourceContent).digest("hex"),
      sourceContent,
      mode: "generate" as const,
      rangeStart: 0,
      rangeEnd: sourceContent.length,
      candidate: { id: "candidate-1", content: "新正文" },
    };
    const draft = await createNovelWorkbenchDraft(
      workspace,
      "manuscript",
      {
        promptId: "novel.manuscript.generate",
        promptVersion: "1.0.0",
        sessionId: "session-1",
      },
      payload,
      "draft-manuscript-recovery",
    );
    const validated = await saveNovelWorkbenchDraftValidation(
      workspace,
      draft,
      hashNovelWorkbenchDraftPayload(payload),
    );
    const proposalId = `proposal-${draft.draftId}`;
    const now = new Date().toISOString();
    const proposal = manuscriptProposalSchema.parse({
      schemaVersion: 1,
      proposalId,
      draftId: draft.draftId,
      runId: payload.runId,
      title: payload.title,
      description: payload.description,
      createdAt: now,
      updatedAt: now,
      source: {
        chapterId: payload.chapterId,
        chapterTitle: payload.chapterTitle,
        chapterPath: payload.chapterPath,
        sourceHash: payload.baseSourceHash,
        sourceContent: payload.sourceContent,
        rangeStart: payload.rangeStart,
        rangeEnd: payload.rangeEnd,
        mode: payload.mode,
      },
      candidate: {
        id: payload.candidate.id,
        status: "pending",
        content: payload.candidate.content,
        appliedContent: null,
      },
    });
    const proposalDirectory = join(
      workspace,
      "manuscript",
      "proposals",
      proposalId,
    );
    await fs.mkdir(proposalDirectory, { recursive: true });
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      serializeManuscriptProposal(proposal),
      "utf8",
    );

    const submit = mocks.handlers.get("novel_manuscript_submit_draft");
    expect(submit).toBeDefined();
    const response = (await submit?.({
      draftId: draft.draftId,
      validationToken: validated.validation!.token,
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({
      submitted: true,
      exists: true,
      proposalId,
      status: "pending",
    });
    expect(
      (await loadNovelWorkbenchDraft(workspace, "manuscript", draft.draftId))
        .submittedProposalId,
    ).toBe(proposalId);
  });
});
