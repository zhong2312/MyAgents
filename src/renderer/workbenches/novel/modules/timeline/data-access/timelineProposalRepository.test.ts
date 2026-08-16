import { describe, expect, it } from "vitest";

import {
  createNovelTimelineProposalRepository,
  createTimelineFileProposalRepository,
} from "./timelineProposalRepository";
import {
  createNovelTimelineLibraryRepository,
  createTimelineLibraryInitializationFiles,
} from "./timelineLibraryRepository";
import {
  serializeTimelineProposalManifest,
  timelineProposalManifestPath,
  type TimelineProposalManifest,
} from "../entities/timelineProposalSchema";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import {
  createTimelineFiles,
  timelineRecordPath,
} from "../../../../../../shared/workbenches/novel/timelineStorage";

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

  it("按统一文件提案契约投影事件对象和生成基准", async () => {
    const listed = await createTimelineFileProposalRepository(
      storageWithProposal(),
    ).list();
    const change = listed.proposals[0]?.changes[0];

    expect(change).toMatchObject({
      id: "candidate-1",
      targetPath: timelineRecordPath("events", "event-1"),
      operation: "create",
      baseContentAvailable: true,
      currentContent: null,
      conflict: false,
      loadError: null,
    });
    expect(change?.beforeContent).toBe("");
    expect(change?.afterContent).toBe(
      `${JSON.stringify(eventValue("event-1", "宗门大典"), null, 2)}\n`,
    );
  });

  it("按对象基准识别更新冲突，并允许显式使用提案版本", async () => {
    const baseline = eventValue("event-1", "开端");
    const formal = {
      ...baseline,
      id: "event-1",
      title: "作者修改后的开端",
    };
    const storage = new NovelMemoryStorage({
      ...Object.fromEntries(
        createTimelineFiles({
          schemaVersion: 1,
          calendars: [],
          periods: [],
          views: [],
          storyStartEventId: null,
          factsThroughEventId: null,
          branches: [
            {
              id: "branch-main",
              name: "主时间线",
              parentBranchId: null,
              forkEventId: null,
              description: "",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          events: [formal],
        }).map((file) => [file.path, file.content]),
      ),
      "timeline/proposals/proposal-update/proposal.json":
        serializeTimelineProposalManifest(
          manifest("proposal-update", [
            {
              candidateId: "candidate-update",
              kind: "event",
              action: "update",
              targetId: "event-1",
              summary: "更新开端标题",
              baseValue: baseline,
              value: { ...baseline, title: "提案版本的开端" },
              status: "pending",
            },
          ]),
        ),
    });
    const repository = createTimelineFileProposalRepository(storage);
    const listed = await repository.list();
    const change = listed.proposals[0]?.changes[0];
    expect(change).toMatchObject({
      conflict: true,
      baseContentAvailable: true,
      currentContent: `${JSON.stringify(formal, null, 2)}\n`,
    });

    await repository.resolveConflict(
      "proposal-update",
      "candidate-update",
      {
        strategy: "use-proposal",
        expectedCurrentContent: change?.currentContent ?? null,
      },
      "测试小说",
    );

    expect(
      JSON.parse(storage.getText(timelineRecordPath("events", "event-1"))!)
        .title,
    ).toBe("提案版本的开端");
  });

  it("删除新建候选时拒绝留下事件引用的提案", async () => {
    const storage = storageWithProposal();
    const proposalPath = "timeline/proposals/proposal-1/proposal.json";
    const document = JSON.parse(storage.getText(proposalPath)!) as {
      operations: Array<{ value: Record<string, unknown> }>;
    };
    document.operations[1]!.value.causeEventIds = ["event-1"];
    storage.setExternalText(
      proposalPath,
      `${JSON.stringify(document, null, 2)}\n`,
    );

    await expect(
      createNovelTimelineProposalRepository(storage).delete("proposal-1", [
        "candidate-1",
      ]),
    ).rejects.toThrow(/仍引用它/);
  });

  it("将跨提案依赖的前置提案排在前面，并在采纳后解除阻塞", async () => {
    const first = manifest("proposal-first", [
      {
        candidateId: "candidate-root",
        kind: "event",
        action: "create",
        summary: "新建回潮纪",
        baseValue: null,
        value: eventValue("event-root", "回潮纪"),
        status: "pending",
      },
    ]);
    const second = {
      ...manifest("proposal-second", [
        {
          candidateId: "candidate-child",
          kind: "event" as const,
          action: "create" as const,
          summary: "新建西岭历程",
          baseValue: null,
          value: {
            ...eventValue("event-child", "西岭历程"),
            causeEventIds: ["event-root"],
          },
          status: "pending" as const,
        },
      ]),
      title: "第二部分：西岭事件链",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const storage = new NovelMemoryStorage({
      ...Object.fromEntries(
        createTimelineLibraryInitializationFiles(NOW).map((file) => [
          file.path,
          file.content,
        ]),
      ),
      [timelineProposalManifestPath(first.proposalId)]:
        serializeTimelineProposalManifest(first),
      [timelineProposalManifestPath(second.proposalId)]:
        serializeTimelineProposalManifest(second),
    });
    const repository = createTimelineFileProposalRepository(storage);

    const before = await repository.list();
    expect(
      before.proposals.map((proposal) => proposal.manifest.proposalId),
    ).toEqual(["proposal-first", "proposal-second"]);
    const dependencyError = before.proposals[1]?.changes[0]?.loadError;
    expect(dependencyError).toContain("AI 时间线提案");
    expect(dependencyError).toContain("event-root");

    await repository.apply("proposal-first", ["candidate-root"], "测试小说");

    const after = await repository.list();
    const dependent = after.proposals.find(
      (proposal) => proposal.manifest.proposalId === "proposal-second",
    );
    expect(dependent?.changes[0]?.loadError).toBeNull();
    await expect(
      repository.apply("proposal-second", ["candidate-child"], "测试小说"),
    ).resolves.toMatchObject({
      manifest: { proposalId: "proposal-second" },
    });
  });
});
