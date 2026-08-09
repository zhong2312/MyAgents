import { createHash } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

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
import { createManuscriptContinuityFiles } from "../shared/workbenches/novel/manuscriptContinuityStorage";
import { createManuscriptTrackingFiles } from "../shared/workbenches/novel/manuscriptTrackingStorage";
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

  it("支持同一候选的分块追加写入", async () => {
    const payload = {
      title: "分块正文",
      description: "",
      runId: "manuscript-run-append",
      chapterId: "chapter-000001",
      chapterTitle: "第一章",
      chapterPath: "manuscript/chapters/000001.md",
      baseSourceHash: "0".repeat(64),
      sourceContent: "",
      mode: "generate" as const,
      rangeStart: 0,
      rangeEnd: 0,
      candidate: null,
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
      "draft-manuscript-append",
    );
    const upsert = mocks.handlers.get("novel_manuscript_upsert_candidate");
    expect(upsert).toBeDefined();
    await upsert?.({
      draftId: draft.draftId,
      candidateId: "candidate-append",
      content: "第一段。",
    });
    await upsert?.({
      draftId: draft.draftId,
      candidateId: "candidate-append",
      content: "第二段。",
      append: true,
    });
    const saved = await loadNovelWorkbenchDraft<typeof payload>(
      workspace,
      "manuscript",
      draft.draftId,
    );
    expect(saved.payload.candidate).toEqual({
      id: "candidate-append",
      content: "第一段。第二段。",
    });
  });

  it("连续性工具默认只返回批次摘要，按 batchId 才展开记录", async () => {
    const trackingFiles = createManuscriptTrackingFiles({
      schemaVersion: 3,
      updatedAt: "2026-08-09T00:00:00.000Z",
      baselines: {},
      batches: [
        {
          id: "tracking-batch-one",
          chapterId: "chapter-000001",
          chapterContentHash: "fnv1a-12345678",
          summary: "第一章连续性",
          status: "applied",
          createdAt: "2026-08-09T00:00:00.000Z",
          appliedAt: "2026-08-09T00:01:00.000Z",
          revertedAt: null,
          changes: [],
          mutations: [],
        },
      ],
    });
    const continuityFiles = createManuscriptContinuityFiles({
      schemaVersion: 1,
      updatedAt: "2026-08-09T00:01:00.000Z",
      facts: [
        {
          id: "continuity-hero-awake",
          domain: "continuity",
          entityId: "hero",
          title: "主角清醒",
          value: "清醒",
          evidence: "第一章正文证据",
          chapterId: "chapter-000001",
          batchId: "tracking-batch-one",
          changeId: "tracking-change-one",
          updatedAt: "2026-08-09T00:01:00.000Z",
        },
      ],
    });
    const files = [...trackingFiles, ...continuityFiles];
    for (const file of files) {
      await fs.mkdir(join(workspace, dirname(file.path)), { recursive: true });
      await fs.writeFile(join(workspace, file.path), file.content, "utf8");
    }
    const getContext = mocks.handlers.get("novel_continuity_get_context");
    expect(getContext).toBeDefined();
    const summary = (await getContext?.({})) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(summary.content[0]!.text)).toMatchObject({
      trackingPath: "manuscript/state-ledger/index.json",
      continuityPath: "manuscript/continuity-state/index.json",
      trackingSourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      continuitySourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      tracking: {
        batches: [
          expect.objectContaining({
            id: "tracking-batch-one",
            changeCount: 0,
          }),
        ],
      },
      continuity: {
        facts: [{ id: "continuity-hero-awake", value: "清醒" }],
      },
    });
    const detail = (await getContext?.({ batchId: "tracking-batch-one" })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(detail.content[0]!.text)).toMatchObject({
      trackingPath: "manuscript/state-ledger/batches/tracking-batch-one.json",
      tracking: {
        batch: { id: "tracking-batch-one", mutations: [] },
      },
    });
    const chapterFiltered = (await getContext?.({
      chapterId: "chapter-000002",
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(chapterFiltered.content[0]!.text)).toMatchObject({
      tracking: { batches: [] },
      continuity: { facts: [] },
    });
  });
});
