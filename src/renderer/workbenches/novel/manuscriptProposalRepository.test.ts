import { describe, expect, it } from "vitest";

import {
  serializeManuscriptProposal,
  type ManuscriptProposal,
} from "../../../shared/workbenches/novel/manuscriptProposalSchema";
import { createManuscriptProposalRepository } from "./manuscriptProposalRepository";
import { NovelMemoryStorage } from "./testStorage";

function proposal(sourceContent = "旧段一\n\n旧段二"): ManuscriptProposal {
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

function storageFor(value: ManuscriptProposal) {
  return new NovelMemoryStorage({
    [value.source.chapterPath]: value.source.sourceContent,
    [`manuscript/proposals/${value.proposalId}/proposal.json`]:
      serializeManuscriptProposal(value),
  });
}

describe("createManuscriptProposalRepository", () => {
  it("applies selected paragraphs against the exact chapter baseline", async () => {
    const value = proposal();
    const storage = storageFor(value);
    const repository = createManuscriptProposalRepository(storage);
    const [loaded] = await repository.list();

    const applied = await repository.apply(loaded!, "新段二");

    expect(storage.getText(value.source.chapterPath)).toBe("新段二");
    expect(applied.proposal.candidate.status).toBe("applied");
    expect(applied.proposal.candidate.appliedContent).toBe("新段二");
  });

  it("refuses to overwrite a chapter changed after generation", async () => {
    const value = proposal();
    const storage = storageFor(value);
    const repository = createManuscriptProposalRepository(storage);
    const [loaded] = await repository.list();
    storage.setExternalText(value.source.chapterPath, "作者已经改过正文");

    await expect(repository.apply(loaded!)).rejects.toThrow(
      "正文已在生成后发生变化",
    );
    expect(storage.getText(value.source.chapterPath)).toBe("作者已经改过正文");
  });

  it("rolls back the chapter when proposal status persistence fails", async () => {
    const value = proposal();
    const storage = storageFor(value);
    const repository = createManuscriptProposalRepository(storage);
    const [loaded] = await repository.list();
    storage.failWritePathOnce = `manuscript/proposals/${value.proposalId}/proposal.json`;

    await expect(repository.apply(loaded!)).rejects.toThrow(
      "Injected write failure",
    );

    expect(storage.getText(value.source.chapterPath)).toBe(
      value.source.sourceContent,
    );
    expect(
      JSON.parse(
        storage.getText(
          `manuscript/proposals/${value.proposalId}/proposal.json`,
        )!,
      ).candidate.status,
    ).toBe("pending");
  });
});
