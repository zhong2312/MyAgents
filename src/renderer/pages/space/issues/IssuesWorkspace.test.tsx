import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceIssue } from "@/api/spaceCloud";
import { i18n } from "@/i18n";
import {
  ACTIVE_ISSUE_STATE_FILTER,
  ALL_ISSUE_STATE_FILTER,
} from "@/pages/space/spaceHelpers";
import { formatFullTime } from "@/pages/space/spaceUi";
import { IssuesWorkspace } from "./IssuesWorkspace";

const issue: SpaceIssue = {
  id: "issue-1",
  number: 1,
  spaceId: "space-1",
  title: "Updated issue",
  body: "Body",
  state: "todo",
  creator: { id: "user-1", name: "Owner" },
  commentCount: 0,
  createdAt: "2026-06-01T01:00:00.000Z",
  updatedAt: "2026-07-11T09:30:00.000Z",
};

describe("IssuesWorkspace", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("keeps the issue toolbar on one row and allows its filters to shrink", () => {
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus={ACTIVE_ISSUE_STATE_FILTER}
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    const toolbar = screen
      .getByRole("button", { name: "Search issue" })
      .closest("section");
    expect(toolbar).toHaveClass("flex-nowrap", "min-w-0");
    expect(toolbar).not.toHaveClass("flex-wrap");
    expect(
      screen.queryByText("Updates available — refresh"),
    ).not.toBeInTheDocument();

    const statusFilter = screen.getByRole("group", { name: "Issue status" });
    expect(statusFilter).toHaveClass("h-9", "w-44", "grid-cols-2");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Incomplete" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Active" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select" }),
    ).not.toBeInTheDocument();
    const goalFilter = screen.getByRole("button", { name: "All goals" });
    expect(goalFilter.parentElement).toHaveClass(
      "min-w-0",
      "flex-1",
      "max-xl:min-w-20",
    );
    expect(screen.getByText("Related to me")).toHaveClass("max-xl:sr-only");
    expect(screen.getByText("Create")).toHaveClass("max-xl:sr-only");

    const statusTag = screen.getByText("Todo");
    expect(statusTag).toHaveClass("h-5", "px-1.5", "text-xs", "font-medium");
    expect(statusTag).not.toHaveClass("h-6", "px-2", "font-semibold");
  });

  it("reserves filter width while search is expanded at narrow widths", () => {
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus={ACTIVE_ISSUE_STATE_FILTER}
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search issue" }));

    const search = screen.getByRole("textbox");
    expect(search.closest("div")).toHaveClass(
      "max-xl:w-40",
      "max-xl:min-w-40",
    );
    expect(screen.getByRole("button", { name: "Create" }).parentElement).toHaveClass(
      "max-xl:hidden",
    );
  });

  it("maps the two status segments to all and incomplete query values", () => {
    const onStatusChange = vi.fn();
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus={ACTIVE_ISSUE_STATE_FILTER}
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={onStatusChange}
        onRelatedToMeChange={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Incomplete" }));

    expect(onStatusChange).toHaveBeenNthCalledWith(1, ALL_ISSUE_STATE_FILTER);
    expect(onStatusChange).toHaveBeenNthCalledWith(
      2,
      ACTIVE_ISSUE_STATE_FILTER,
    );
  });

  it("exposes related-to-me as an independent toggle and renders updatedAt", () => {
    const onRelatedToMeChange = vi.fn();
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore={false}
        issueQ=""
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={onRelatedToMeChange}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    const related = screen.getByRole("button", { name: "Related to me" });
    expect(related).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(related);
    expect(onRelatedToMeChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByTitle(formatFullTime(issue.updatedAt)),
    ).toBeInTheDocument();
    expect(
      screen.queryByTitle(formatFullTime(issue.createdAt)),
    ).not.toBeInTheDocument();
  });

  it("loads the next cursor page without replacing the visible rows", () => {
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError={null}
        showingPreviousIssues={false}
        hasMore
        issueQ=""
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={onLoadMore}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Updated issue")).toBeInTheDocument();
  });

  it("keeps prior rows visible and exposes retry when revalidation fails", () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <IssuesWorkspace
        admin={false}
        issues={[issue]}
        issuesLoading={false}
        issueError="network down"
        showingPreviousIssues
        hasMore={false}
        issueQ="runtime"
        selectedGoalId=""
        selectedStatus="open,todo,doing"
        relatedToMe={false}
        goalOptions={[{ value: "", label: "All goals" }]}
        activeIssueId={null}
        onQueryChange={vi.fn()}
        onGoalChange={vi.fn()}
        onStatusChange={vi.fn()}
        onRelatedToMeChange={vi.fn()}
        onRefresh={onRefresh}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCreate={vi.fn()}
        onOpenIssue={vi.fn()}
      />,
    );

    expect(screen.getByText("Updated issue")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The list could not be updated. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("forgets a prior load-more failure after the store error clears", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onLoadMore = vi
      .fn()
      .mockRejectedValueOnce(new Error("cursor failed"))
      .mockResolvedValue(undefined);
    const props = {
      admin: false,
      issues: [issue],
      issuesLoading: false,
      issueError: null as string | null,
      showingPreviousIssues: false,
      hasMore: true,
      issueQ: "",
      selectedGoalId: "",
      selectedStatus: "open,todo,doing",
      relatedToMe: false,
      goalOptions: [{ value: "", label: "All goals" }],
      activeIssueId: null,
      onQueryChange: vi.fn(),
      onGoalChange: vi.fn(),
      onStatusChange: vi.fn(),
      onRelatedToMeChange: vi.fn(),
      onRefresh,
      onLoadMore,
      onCreate: vi.fn(),
      onOpenIssue: vi.fn(),
    };
    const { rerender } = render(<IssuesWorkspace {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1));

    rerender(
      <IssuesWorkspace
        {...props}
        issueError="cursor failed"
        showingPreviousIssues
      />,
    );
    rerender(<IssuesWorkspace {...props} issueError={null} />);
    rerender(
      <IssuesWorkspace
        {...props}
        issueError="ordinary refresh failed"
        showingPreviousIssues
        hasMore={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
