import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
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
      "overview:Novel:true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(onNavigate).toHaveBeenCalledWith("documents");
  });

  it("opens a visible child route while keeping hidden internal routes out of the menu", () => {
    const onNavigate = vi.fn();
    const nestedManifest = {
      ...manifest,
      id: "io.myagents.nested-testbench",
      navigation: [
        { id: "overview", label: "Overview", order: 0 },
        { id: "utilities", label: "辅助", order: 10 },
        { id: "diagnostics", label: "诊断", parentId: "utilities", order: 10 },
        {
          id: "diagnostics-internal",
          label: "内部诊断",
          parentId: "utilities",
          order: 10,
          hidden: true,
        },
      ],
    };
    const registry = createWorkbenchRegistry([
      defineWorkbench(nestedManifest, async () => ({ default: () => null })),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: nestedManifest.id, route: "overview" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={onNavigate}
        registry={registry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "辅助" }));
    expect(screen.getByRole("button", { name: "诊断" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "内部诊断" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "诊断" }));
    expect(onNavigate).toHaveBeenCalledWith("diagnostics");
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

  it("routes one-shot AI cancellation through the MyAgents host", async () => {
    const onCancelAiRun = vi.fn(async () => undefined);
    const registry = createWorkbenchRegistry([
      defineWorkbench(manifest, async () => ({
        default: ({ context }) => (
          <button
            type="button"
            onClick={() =>
              void context.aiRuns.cancel("full-generation-test-run")
            }
          >
            取消生成
          </button>
        ),
      })),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: manifest.id, route: "overview" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={vi.fn()}
        onCancelAiRun={onCancelAiRun}
        registry={registry}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "取消生成" }));
    await waitFor(() =>
      expect(onCancelAiRun).toHaveBeenCalledWith("full-generation-test-run"),
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

  it("renders workbench shell controls in English when the app locale changes", async () => {
    await i18n.changeLanguage("en-US");
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

    expect(
      screen.getByRole("button", { name: "Expand workbench navigation" }),
    ).toBeInTheDocument();
  });

  it("keeps a direct return-to-manuscript action visible in collapsed novel navigation", () => {
    const onNavigate = vi.fn();
    const novelManifest = {
      ...manifest,
      id: "io.myagents.novel-test",
      navigation: [
        ...manifest.navigation,
        { id: "manuscript", label: "正文", icon: "file-text", order: 20 },
      ],
    };
    const registry = createWorkbenchRegistry([
      defineWorkbench(novelManifest, async () => ({ default: () => null }), {
        shell: { defaultNavigationCollapsed: true },
      }),
    ]);
    render(
      <WorkbenchShell
        target={{ workbenchId: novelManifest.id, route: "documents" }}
        workspacePath="C:\\Work\\Novel"
        isActive
        onNavigate={onNavigate}
        registry={registry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "返回正文" }));
    expect(onNavigate).toHaveBeenCalledWith("manuscript");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台导航" }));
    fireEvent.click(screen.getByRole("button", { name: "返回正文" }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
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
