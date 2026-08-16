import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "../../../testStorage";
import { createTimelineFiles } from "../../../../../../shared/workbenches/novel/timelineStorage";
import { createNovelTimelineLibraryRepository } from "../data-access/timelineLibraryRepository";
import {
  createEmptyTimelineLibrary,
  type TimelineEvent,
} from "../entities/timelineLibrarySchema";
import TimelineLibrary from "./TimelineLibrary";

const NOW = "2026-08-10T00:00:00.000Z";

function event(
  id: string,
  title: string,
  periodId: string,
  sortKey: number,
): TimelineEvent {
  return {
    id,
    branchId: "branch-main",
    timeLabel: title,
    sortKey,
    sortOrder: 0,
    endSortKey: null,
    timePrecision: "exact",
    timeExpressions: [],
    periodId,
    scope: "universe",
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

describe("TimelineLibrary 纪元筛选", () => {
  it("点击纪元后只显示该纪元及子纪元事件，并为空纪元显示空状态", async () => {
    const storage = createEmptyNovelStorage();
    const library = createEmptyTimelineLibrary(NOW);
    const rootId = library.periods[0]!.id;
    const firstId = "period-first";
    const childId = "period-first-child";
    const emptyId = "period-empty";
    library.periods = [
      ...library.periods,
      {
        id: firstId,
        name: "第一纪",
        parentPeriodId: rootId,
        kind: "era",
        scope: "universe",
        startSortKey: 0,
        endSortKey: 100,
        precision: "exact",
        description: "",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: childId,
        name: "第一纪·子期",
        parentPeriodId: firstId,
        kind: "phase",
        scope: "universe",
        startSortKey: 20,
        endSortKey: 80,
        precision: "exact",
        description: "",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: emptyId,
        name: "空白纪元",
        parentPeriodId: rootId,
        kind: "era",
        scope: "universe",
        startSortKey: 200,
        endSortKey: 300,
        precision: "exact",
        description: "",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    library.events = [
      event("event-root", "根事件", rootId, -100),
      event("event-first", "第一纪事件", firstId, 20),
      event("event-child", "子期事件", childId, 40),
    ];
    for (const file of createTimelineFiles(library)) {
      storage.setExternalText(file.path, file.content);
    }

    render(
      <TimelineLibrary storage={storage} projectTitle="测试小说" isActive />,
    );

    const firstPeriodButton = (await screen.findByText("第一纪")).closest(
      "button",
    );
    expect(firstPeriodButton).not.toBeNull();
    expect(screen.getByRole("button", { name: /根事件/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /第一纪事件/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /子期事件/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("事件资料").closest("header")).toHaveClass(
      "sticky",
      "top-0",
      "z-20",
      "bg-[var(--paper-elevated)]",
    );

    fireEvent.click(firstPeriodButton!);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /根事件/ })).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: /第一纪事件/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /子期事件/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("· 第一纪")).toBeInTheDocument();

    const emptyPeriodButton = screen.getByText("空白纪元").closest("button");
    expect(emptyPeriodButton).not.toBeNull();
    fireEvent.click(emptyPeriodButton!);
    expect(
      await screen.findByText("纪元“空白纪元”暂无事件"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建事件" }));
    await waitFor(async () => {
      const saved = await createNovelTimelineLibraryRepository(storage).load();
      expect(
        saved.library.events.find((item) => item.title === "未命名事件")
          ?.periodId,
      ).toBe(emptyId);
    });
  });
});
