import { describe, expect, it } from "vitest";

import { createNovelTimelineProposalRepository } from "./timelineProposalRepository";
import {
  createNovelTimelineLibraryRepository,
  createTimelineLibraryInitializationFiles,
} from "./timelineLibraryRepository";
import {
  serializeTimelineProposalManifest,
  type TimelineProposalManifest,
} from "../entities/timelineProposalSchema";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

const NOW = "2026-01-01T00:00:00.000Z";

function manifest(
  proposalId: string,
  operations: TimelineProposalManifest["operations"],
): TimelineProposalManifest {
  return {
    schemaVersion: 1,
    proposalId,
    title: "AI 时间线提案",
    description: "",
    createdAt: NOW,
    source: {
      kind: "agent",
      promptId: "novel.timeline.assist",
      promptVersion: "1.0.0",
    },
    operations,
  };
}

function eventValue(id: string, title: string): Record<string, unknown> {
  return {
    id,
    branchId: "branch-main",
    timeLabel: "第一天",
    sortKey: 1,
    sortOrder: 0,
    endSortKey: null,
    timePrecision: "exact",
    timeExpressions: [],
    periodId: null,
    scope: "story",
    knowledgeScope: "public",
    narrativeOrder: null,
    title,
    kind: "event",
    summary: "",
    description: "",
    characterIds: [],
    locationIds: [],
    chapterIds: [],
    factionIds: [],
    itemIds: [],
    causeEventIds: [],
    stateChanges: [],
    foreshadowings: [],
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function storageWithProposal(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    ...Object.fromEntries(
      createTimelineLibraryInitializationFiles(NOW).map((file) => [
        file.path,
        file.content,
      ]),
    ),
    "timeline/proposals/proposal-1/proposal.json":
      serializeTimelineProposalManifest(
        manifest("proposal-1", [
          {
            candidateId: "candidate-1",
            kind: "event",
            action: "create",
            summary: "新建事件：宗门大典",
            value: eventValue("event-1", "宗门大典"),
            status: "pending",
          },
          {
            candidateId: "candidate-2",
            kind: "event",
            action: "create",
            summary: "新建事件：论剑大会",
            value: eventValue("event-2", "论剑大会"),
            status: "pending",
          },
        ]),
      ),
  });
}

describe("createNovelTimelineProposalRepository", () => {
  it("采纳选中的事件候选并写入正式库", async () => {
    const storage = storageWithProposal();
    const repository = createNovelTimelineProposalRepository(storage);

    await repository.apply("proposal-1", ["candidate-1"]);

    const timeline = await createNovelTimelineLibraryRepository(storage).load();
    expect(timeline.library.events.map((event) => event.id)).toEqual([
      "event-1",
    ]);
    const applied = JSON.parse(
      storage.getText("timeline/proposals/proposal-1/proposal.json")!,
    );
    expect(
      applied.operations.find(
        (operation: { candidateId: string }) =>
          operation.candidateId === "candidate-1",
      ).status,
    ).toBe("applied");
  });

  it("采纳时执行跨库引用校验，悬空引用被拒绝", async () => {
    const storage = new NovelMemoryStorage({
      ...Object.fromEntries(
        createTimelineLibraryInitializationFiles(NOW).map((file) => [
          file.path,
          file.content,
        ]),
      ),
      "timeline/proposals/proposal-1/proposal.json":
        serializeTimelineProposalManifest(
          manifest("proposal-1", [
            {
              candidateId: "candidate-1",
              kind: "event",
              action: "create",
              summary: "引用不存在角色",
              value: {
                ...eventValue("event-1", "事件"),
                characterIds: ["char-missing"],
              },
              status: "pending",
            },
          ]),
        ),
    });
    const repository = createNovelTimelineProposalRepository(storage);

    await expect(
      repository.apply("proposal-1", ["candidate-1"]),
    ).rejects.toThrow(/关联了不存在的角色/);
    await expect(
      createNovelTimelineLibraryRepository(storage).load(),
    ).resolves.toMatchObject({ library: { events: [] } });
  });

  it("拒绝候选只更新提案状态", async () => {
    const storage = storageWithProposal();
    const repository = createNovelTimelineProposalRepository(storage);

    await repository.reject("proposal-1", ["candidate-2"]);

    await expect(
      createNovelTimelineLibraryRepository(storage).load(),
    ).resolves.toMatchObject({ library: { events: [] } });
    const applied = JSON.parse(
      storage.getText("timeline/proposals/proposal-1/proposal.json")!,
    );
    expect(
      applied.operations.find(
        (operation: { candidateId: string }) =>
          operation.candidateId === "candidate-2",
      ).status,
    ).toBe("rejected");
  });

  it("删除提案目录", async () => {
    const storage = storageWithProposal();
    const repository = createNovelTimelineProposalRepository(storage);

    await repository.deleteProposals(["proposal-1"]);

    expect(
      storage.getText("timeline/proposals/proposal-1/proposal.json"),
    ).toBeUndefined();
  });
});
