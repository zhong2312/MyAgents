import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-resizable-panels", () => ({
  Group: ({
    children,
    orientation,
    id,
  }: {
    children: ReactNode;
    orientation: string;
    id: string;
  }) => (
    <div data-testid={id} data-orientation={orientation}>
      {children}
    </div>
  ),
  Panel: ({ children, id }: { children: ReactNode; id: string }) => (
    <div data-panel-id={id}>{children}</div>
  ),
  Separator: ({
    children,
    ...props
  }: {
    children: ReactNode;
    "aria-label": string;
  }) => (
    <div role="separator" {...props}>
      {children}
    </div>
  ),
}));

vi.mock("@/workbench-registry", async () => {
  const React = await import("react");
  return {
    workbenchRegistry: {
      get: () => ({
        AgentCompanion: ({ companionId }: { companionId: string }) =>
          React.createElement(
            "div",
            { "data-testid": "agent-companion" },
            companionId,
          ),
      }),
    },
  };
});

import type { Tab } from "@/types/tab";
import WorkbenchAgentSurfaceHost from "./WorkbenchAgentSurfaceHost";

function createSurface(
  presentation: "dialog" | "compact-review" | "embedded-review",
  options: { readonly embedded?: boolean } = {},
): Tab {
  return {
    id: "agent-1",
    agentDir: "F:/novels/test",
    sessionId: "session-1",
    view: "chat",
    title: "第一章 · 完整生成",
    sidecarConfigDisposition: "push",
    isGenerating: true,
    workbenchAgentSurface: {
      presentation,
      sourceTabId: "source-1",
      workbenchId: "io.myagents.novel",
      workspacePath: "F:/novels/test",
      conversationKey: "chapter-000001.generate.run-1",
      ...(presentation === "embedded-review" || options.embedded
        ? { embeddedSurfaceId: "full-generation-test" }
        : {}),
      toolset: {
        id: "novel-world",
        context: { mode: "manuscript" },
      },
      companion: {
        id: "manuscript-review",
        context: { runId: "run-1", chapterId: "chapter-000001" },
      },
    },
  };
}

function renderHost(tab: Tab | readonly Tab[]) {
  return render(
    <WorkbenchAgentSurfaceHost
      surfaces={Array.isArray(tab) ? tab : [tab]}
      activeSourceTabId="source-1"
      renderSurface={() => <div data-testid="agent-conversation" />}
      onMinimize={vi.fn()}
      onRestore={vi.fn()}
      onExpandToTab={vi.fn()}
      onReview={vi.fn()}
      onRestart={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("WorkbenchAgentSurfaceHost", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: window.innerWidth < 900,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders the real Agent conversation beside the workbench companion", async () => {
    renderHost(createSurface("compact-review"));

    expect(screen.getByTestId("agent-conversation")).toBeInTheDocument();
    expect(await screen.findByTestId("agent-companion")).toHaveTextContent(
      "manuscript-review",
    );
    expect(screen.getByLabelText("AI 执行过程")).toBeInTheDocument();
    expect(screen.getByLabelText("正文差异审阅")).toBeInTheDocument();
    expect(
      screen.getByTestId("workbench-agent-review-agent-1"),
    ).toHaveAttribute("data-orientation", "horizontal");
  });

  it("keeps a standard Agent dialog single-pane", () => {
    renderHost(createSurface("dialog"));

    expect(screen.getByTestId("agent-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-companion")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("workbench-agent-review-agent-1"),
    ).not.toBeInTheDocument();
  });

  it("mounts the full Agent conversation and companion into workbench-owned regions", async () => {
    const conversationTarget = document.createElement("div");
    conversationTarget.id = "full-generation-test-conversation";
    const companionTarget = document.createElement("div");
    companionTarget.id = "full-generation-test-companion";
    document.body.append(conversationTarget, companionTarget);

    renderHost(createSurface("embedded-review"));

    expect(conversationTarget.querySelector("[data-testid='agent-conversation']")).not.toBeNull();
    // Loading placeholders can coexist briefly with the Portal while a new
    // session is created. The Portal must overlay that placeholder rather than
    // become a second flex item and compress the embedded Chat into a narrow
    // vertical strip.
    const conversationSection = conversationTarget.querySelector(
      "section[aria-label='AI 执行过程']",
    );
    expect(conversationSection).toHaveClass("absolute", "inset-0", "z-10");
    const companionSection = companionTarget.querySelector(
      "section[aria-label='正文候选审阅']",
    );
    expect(companionSection).toHaveClass("absolute", "inset-0", "z-10");
    expect(await screen.findByTestId("agent-companion")).toHaveTextContent(
      "manuscript-review",
    );
    expect(companionTarget.querySelector("[data-testid='agent-companion']")).not.toBeNull();
    expect(screen.queryByLabelText("AI 任务坞")).not.toBeInTheDocument();

    conversationTarget.remove();
    companionTarget.remove();
  });

  it("keeps a workbench-owned embedded mount out of generic review dialogs", async () => {
    const conversationTarget = document.createElement("div");
    conversationTarget.id = "full-generation-test-conversation";
    const companionTarget = document.createElement("div");
    companionTarget.id = "full-generation-test-companion";
    document.body.append(conversationTarget, companionTarget);

    renderHost(createSurface("compact-review", { embedded: true }));

    expect(conversationTarget.querySelector("[data-testid='agent-conversation']")).not.toBeNull();
    expect(companionTarget.querySelector("[data-testid='agent-companion']")).not.toBeNull();
    expect(screen.queryByLabelText("AI 任务坞")).not.toBeInTheDocument();

    conversationTarget.remove();
    companionTarget.remove();
  });

  it("keeps only the latest session in a shared embedded mount", async () => {
    const conversationTarget = document.createElement("div");
    conversationTarget.id = "full-generation-test-conversation";
    const companionTarget = document.createElement("div");
    companionTarget.id = "full-generation-test-companion";
    document.body.append(conversationTarget, companionTarget);

    const stale = { ...createSurface("embedded-review"), id: "agent-stale" };
    const newest = { ...createSurface("embedded-review"), id: "agent-newest" };
    renderHost([stale, newest]);

    expect(
      conversationTarget.querySelectorAll("[data-testid='agent-conversation']"),
    ).toHaveLength(1);
    expect(
      companionTarget.querySelectorAll("[data-testid='agent-companion']"),
    ).toHaveLength(1);

    conversationTarget.remove();
    companionTarget.remove();
  });

  it("stacks execution and review vertically in a narrow window", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 720,
    });
    renderHost(createSurface("compact-review"));

    expect(await screen.findByTestId("agent-companion")).toBeInTheDocument();
    expect(
      screen.getByTestId("workbench-agent-review-agent-1"),
    ).toHaveAttribute("data-orientation", "vertical");
  });

  it("allows the AI task dock to be moved without turning its buttons into drag handles", () => {
    renderHost(createSurface("dialog"));

    const dock = screen.getByLabelText("AI 任务坞");
    const dragHandle = screen.getByLabelText("拖动 AI 任务坞");
    fireEvent.pointerDown(dragHandle, {
      button: 0,
      pointerId: 8,
      clientX: 40,
      clientY: 60,
    });
    fireEvent.pointerMove(dragHandle, {
      pointerId: 8,
      clientX: 160,
      clientY: 140,
    });

    expect(dock).toHaveStyle("transform: translate3d(120px, 80px, 0)");

    fireEvent.pointerUp(dragHandle, { pointerId: 8 });
    expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(8);

    const collapseButton = screen.getByRole("button", {
      name: "收起 AI 任务",
    });
    fireEvent.pointerDown(collapseButton, {
      button: 0,
      pointerId: 9,
      clientX: 160,
      clientY: 140,
    });
    fireEvent.pointerMove(collapseButton, {
      pointerId: 9,
      clientX: 280,
      clientY: 220,
    });
    expect(dock).toHaveStyle("transform: translate3d(120px, 80px, 0)");

    fireEvent.click(collapseButton);
    expect(
      screen.queryByRole("button", { name: /第一章 · 完整生成/ }),
    ).not.toBeInTheDocument();
  });
});
