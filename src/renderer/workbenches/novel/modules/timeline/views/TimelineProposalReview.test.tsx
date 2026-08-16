import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/workbench-sdk/DiffViewer", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div
      data-testid="timeline-diff-viewer"
      data-original={original}
      data-modified={modified}
    />
  ),
}));

import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import {
  createNovelTimelineLibraryRepository,
  createTimelineLibraryInitializationFiles,
} from "../data-access/timelineLibraryRepository";
import {
  serializeTimelineProposalManifest,
  timelineProposalManifestPath,
  type TimelineProposalManifest,
} from "../entities/timelineProposalSchema";
import TimelineProposalReview from "./TimelineProposalReview";

const NOW = "2026-08-10T00:00:00.000Z";

function event() {
  return {
    id: "event-opening",
    branchId: "branch-main",
    timeLabel: "第一天",
    sortKey: 1,
    sortOrder: 0,
    endSortKey: null,
    timePrecision: "exact" as const,
    timeExpressions: [],
    periodId: null,
    scope: "story" as const,
    knowledgeScope: "public" as const,
    narrativeOrder: null,
    title: "故事开端",
    kind: "event" as const,
    summary: "主角踏上旅途",
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

function proposal(): TimelineProposalManifest {
  return {
    schemaVersion: 1,
    proposalId: "proposal-opening",
    title: "首个时间线事件",
    description: "",
    createdAt: NOW,
    source: {
      kind: "agent",
      promptId: "novel.timeline.assist",
      promptVersion: "1.0.0",
    },
    operations: [
      {
        candidateId: "candidate-opening",
        kind: "event",
        action: "create",
        summary: "新建故事开端",
        baseValue: null,
        value: event(),
        status: "pending",
      },
    ],
  };
}

describe("TimelineProposalReview", () => {
  it("使用世界架构统一审阅器展示差异并应用首份时间线提案", async () => {
    const manifest = proposal();
    const storage = new NovelMemoryStorage({
      ...Object.fromEntries(
        createTimelineLibraryInitializationFiles(NOW).map((file) => [
          file.path,
          file.content,
        ]),
      ),
      [timelineProposalManifestPath(manifest.proposalId)]:
        serializeTimelineProposalManifest(manifest),
    });

    render(
      <TimelineProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "时间线提案" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("checkbox", { name: "全选待处理变更" }),
    ).toBeChecked();
    const diff = await screen.findByTestId("timeline-diff-viewer");
    expect(diff).toHaveAttribute("data-original", "");
    expect(diff).toHaveAttribute(
      "data-modified",
      `${JSON.stringify(event(), null, 2)}\n`,
    );

    fireEvent.click(screen.getByRole("button", { name: "应用选中" }));

    await waitFor(async () => {
      const loaded = await createNovelTimelineLibraryRepository(storage).load();
      expect(loaded.library.events.map((item) => item.id)).toEqual([
        "event-opening",
      ]);
    });
  });
});
