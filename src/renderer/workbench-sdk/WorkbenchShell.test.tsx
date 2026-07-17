import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { defineWorkbench } from "./defineWorkbench";
import { createWorkbenchRegistry } from "./registry";
import WorkbenchShell from "./WorkbenchShell";

const manifest = {
  manifestVersion: 1,
  id: "io.myagents.testbench",
  name: "Testbench",
  description: "Test workbench",
  version: "1.0.0",
  api: { major: 1, minMinor: 0 },
  entry: { renderer: "testbench", defaultRoute: "overview" },
  navigation: [
    { id: "overview", label: "Overview", icon: "layout-dashboard", order: 0 },
    { id: "documents", label: "Documents", icon: "file-text", order: 10 },
  ],
};

describe("WorkbenchShell", () => {
  it("loads a registered module and routes navigation through the host", async () => {
    const onNavigate = vi.fn();
    const registry = createWorkbenchRegistry([
      defineWorkbench(manifest, async () => ({
        default: ({ context }) => (
          <div data-testid="workbench-module">
            {context.route}:{context.workspaceName}:
            {String(context.storage.isAvailable)}
          </div>
        ),
      })),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\Work\Novel"
        isActive
        onNavigate={onNavigate}
        registry={registry}
      />,
    );
    expect(await screen.findByTestId("workbench-module")).toHaveTextContent(
      "overview:Novel:false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(onNavigate).toHaveBeenCalledWith("documents");
  });

  it("routes full Agent Session requests through the MyAgents host", async () => {
    const onOpenAgentSession = vi.fn(async () => undefined);
    const registry = createWorkbenchRegistry([
      defineWorkbench(manifest, async () => ({
        default: ({ context }) => (
          <button
            type="button"
            onClick={() =>
              void context.agentSessions.open({
                version: 1,
                title: "世界架构向导",
                initialMessage: "从一句话开始创建世界",
                promptId: "novel.world.guide",
              })
            }
          >
            启动 Agent
          </button>
        ),
      })),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\Work\Novel"
        isActive
        onNavigate={vi.fn()}
        onOpenAgentSession={onOpenAgentSession}
        registry={registry}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "启动 Agent" }));
    expect(onOpenAgentSession).toHaveBeenCalledWith(
      "C:\\Work\\Novel",
      expect.objectContaining({
        title: "世界架构向导",
        promptId: "novel.world.guide",
      }),
    );
  });

  it("honors a workbench default collapsed navigation and lets the user expand it", () => {
    const registry = createWorkbenchRegistry([
      defineWorkbench(manifest, async () => ({ default: () => null }), {
        shell: { defaultNavigationCollapsed: true },
      }),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={vi.fn()}
        registry={registry}
      />,
    );

    const expandButton = screen.getByRole("button", {
      name: "展开工作台导航",
    });
    expect(expandButton).toHaveAttribute("aria-expanded", "false");
    expect(expandButton.closest("aside")).toHaveClass("w-16");
    expect(screen.queryByText("Testbench")).not.toBeInTheDocument();

    fireEvent.click(expandButton);

    expect(
      screen.getByRole("button", { name: "收起工作台导航" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Testbench")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "收起工作台导航" }).closest("aside"),
    ).toHaveClass("w-60");
  });

  it("contains unknown and incompatible workbenches inside the shell", () => {
    const emptyRegistry = createWorkbenchRegistry([]);
    const { rerender } = render(
      <WorkbenchShell
        target={{ workbenchId: "io.myagents.missing", route: "home" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={vi.fn()}
        registry={emptyRegistry}
      />,
    );
    expect(screen.getByText("工作台未注册")).toBeInTheDocument();

    const incompatible = createWorkbenchRegistry([
      defineWorkbench(
        { ...manifest, api: { major: 2, minMinor: 0 } },
        async () => ({ default: () => null }),
      ),
    ]);
    rerender(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={vi.fn()}
        registry={incompatible}
      />,
    );
    expect(screen.getByText("工作台版本不兼容")).toBeInTheDocument();
  });

  it("contains a rejected renderer module without replacing the app root", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const registry = createWorkbenchRegistry([
      defineWorkbench(manifest, async () => {
        throw new Error("renderer chunk unavailable");
      }),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={vi.fn()}
        registry={registry}
      />,
    );
    expect(await screen.findByText("工作台载入失败")).toBeInTheDocument();
    expect(screen.getByText("renderer chunk unavailable")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
