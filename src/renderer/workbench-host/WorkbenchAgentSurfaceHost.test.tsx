import { render, screen } from "@testing-library/react";
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

function createSurface(presentation: "dialog" | "compact-review"): Tab {
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

function renderHost(tab: Tab) {
  return render(
    <WorkbenchAgentSurfaceHost
      surfaces={[tab]}
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
});
