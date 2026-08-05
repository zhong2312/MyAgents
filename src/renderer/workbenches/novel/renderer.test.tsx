import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mdxeditor/editor", async () => {
  const React = await import("react");
  interface MockEditorProps {
    readonly markdown: string;
    readonly onChange?: (markdown: string, normalized: boolean) => void;
    readonly contentEditableClassName?: string;
    readonly placeholder?: React.ReactNode;
  }
  const Empty = () => null;
  const Passthrough = ({ children }: { readonly children: React.ReactNode }) =>
    children;
  return {
    MDXEditor: React.forwardRef(function MockMDXEditor(
      {
        markdown,
        onChange,
        contentEditableClassName,
        placeholder,
      }: MockEditorProps,
      ref: React.ForwardedRef<{ setMarkdown: (value: string) => void }>,
    ) {
      const [current, setCurrent] = React.useState(markdown);
      const normalizationSentRef = React.useRef(false);
      React.useImperativeHandle(ref, () => ({ setMarkdown: setCurrent }));
      React.useEffect(() => {
        if (normalizationSentRef.current) return;
        normalizationSentRef.current = true;
        onChange?.(markdown.replace("- ", "* "), true);
      }, [markdown, onChange]);
      return (
        <textarea
          className={contentEditableClassName}
          value={current}
          placeholder={typeof placeholder === "string" ? placeholder : ""}
          onChange={(event) => {
            setCurrent(event.target.value);
            onChange?.(event.target.value, false);
          }}
        />
      );
    }),
    BlockTypeSelect: Empty,
    BoldItalicUnderlineToggles: Empty,
    CodeToggle: Empty,
    CreateLink: Empty,
    DiffSourceToggleWrapper: Passthrough,
    InsertTable: Empty,
    ListsToggle: Empty,
    Separator: Empty,
    UndoRedo: Empty,
    diffSourcePlugin: () => ({}),
    headingsPlugin: () => ({}),
    linkDialogPlugin: () => ({}),
    linkPlugin: () => ({}),
    listsPlugin: () => ({}),
    markdownShortcutPlugin: () => ({}),
    quotePlugin: () => ({}),
    tablePlugin: () => ({}),
    toolbarPlugin: () => ({}),
    codeBlockPlugin: () => ({}),
    codeMirrorPlugin: () => ({}),
  };
});

import type { WorkbenchRendererContext } from "@/workbench-sdk";

import novelWorkbenchDefinition from "./index";
import { createNovelRepository } from "./repository";
import NovelWorkbenchRenderer from "./renderer";
import {
  createEmptyNovelStorage,
  NovelMemoryProjection,
  type NovelMemoryStorage,
} from "./testStorage";

function context(
  storage: NovelMemoryStorage,
  route: string,
  navigate: (nextRoute: string) => void,
  openAgentSession: WorkbenchRendererContext["agentSessions"]["open"] = async () =>
    undefined,
): WorkbenchRendererContext {
  return {
    manifest: novelWorkbenchDefinition.manifest,
    workspacePath: storage.rootPath,
    workspaceName: "test",
    route,
    isActive: true,
    storage,
    agentSessions: {
      isAvailable: true,
      open: openAgentSession,
    },
    aiRuns: {
      isAvailable: false,
      run: async () => {
        throw new Error("AI runs unavailable in renderer fixture");
      },
    },
    search: {
      isAvailable: false,
      async searchFiles() {
        throw new Error("Search unavailable in renderer fixture");
      },
      async refreshIndex() {
        throw new Error("Search unavailable in renderer fixture");
      },
      async invalidateIndex() {
        throw new Error("Search unavailable in renderer fixture");
      },
    },
    projection: new NovelMemoryProjection([], [], false),
    navigate,
    registerNavigationGuard: () => () => undefined,
  };
}

describe("NovelWorkbenchRenderer storage loop", () => {
  it("在新的世界推演菜单下保留控制台、实验室和立场会商入口", () => {
    const navigation = novelWorkbenchDefinition.manifest.navigation;
    expect(navigation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "simulation", label: "世界推演" }),
        expect.objectContaining({ id: "simulation-console", label: "运行控制台", parentId: "simulation" }),
        expect.objectContaining({ id: "simulation-lab", label: "世界实验室", parentId: "simulation" }),
        expect.objectContaining({ id: "simulation-council", label: "立场会商", parentId: "simulation" }),
      ]),
    );
    expect(navigation.find((item) => item.id === "simulation")?.parentId).toBeUndefined();
  });

  it("为世界推演启动检查提供可执行的设置入口", async () => {
    const storage = createEmptyNovelStorage();
    const navigate = vi.fn();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "simulation-console", navigate)}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "改用自定义起点" }),
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue("0")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "改用自定义起点" })).not.toBeInTheDocument();
      expect(screen.getByText("时间线事件不会自动成为事实。当前使用自定义起点，推演不会把任何时间线事件当作既成事实。")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "锁定已发生事实" }));
    expect(navigate).toHaveBeenCalledWith("timeline");
  });

  it("shows and updates project planning details from the overview", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "overview", vi.fn())}
      />,
    );

    expect(await screen.findAllByText("25 至 35 万字")).toHaveLength(2);
    expect(screen.getByText("100 至 140 章")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));

    expect(screen.getByLabelText("项目名")).toHaveValue("test-novel-01");
    fireEvent.change(screen.getByLabelText("书名"), {
      target: { value: "自由变更后的书名" },
    });
    fireEvent.change(screen.getByLabelText("总字数下限"), {
      target: { value: "40" },
    });
    fireEvent.change(screen.getByLabelText("总字数上限"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("每章字数"), {
      target: { value: "2000" },
    });
    expect(screen.getByText("200 至 300 章")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByRole("heading", { name: "自由变更后的书名" }),
    ).toBeInTheDocument();
    const metadata = JSON.parse(storage.getText("novel.json") ?? "{}");
    expect(metadata).toMatchObject({
      projectName: "test-novel-01",
      title: "自由变更后的书名",
      targetWordCountMin: 400_000,
      targetWordCountMax: 600_000,
      chapterWordCount: 2_000,
    });
  });

  it("creates the first chapter, saves Markdown, and reloads it after remount", async () => {
    const storage = createEmptyNovelStorage();
    const navigate = vi.fn();
    const view = render(
      <NovelWorkbenchRenderer
        context={context(storage, "overview", navigate)}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "测试小说" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("manuscript");
      expect(storage.getText("manuscript/chapters/000001.md")).toBe("");
    });

    view.rerender(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", navigate)}
      />,
    );
    const title = await screen.findByLabelText("章节标题");
    fireEvent.change(title, { target: { value: "雨夜来客" } });
    fireEvent.blur(title);

    const editor = await screen.findByLabelText("章节正文");
    fireEvent.change(editor, { target: { value: "雨落在旧港。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(storage.getText("manuscript/chapters/000001.md")).toBe(
        "雨落在旧港。",
      );
      expect(storage.getText("manuscript/index.json")).toContain("雨夜来客");
    });

    view.unmount();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", navigate)}
      />,
    );

    expect(await screen.findByDisplayValue("雨落在旧港。")).toBeInTheDocument();
    expect(screen.getByDisplayValue("雨夜来客")).toBeInTheDocument();
  });

  it("preserves a dirty draft when the chapter changes outside MyAgents", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const empty = await repository.load();
    const record = await repository.createChapter(empty);
    storage.setExternalText(record.path, "磁盘初始版本");
    const navigate = vi.fn();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", navigate)}
      />,
    );

    const editor = await screen.findByDisplayValue("磁盘初始版本");
    fireEvent.change(editor, { target: { value: "尚未保存的本地草稿" } });
    storage.setExternalText(record.path, "外部编辑后的版本");

    expect(
      await screen.findByText(/磁盘正文已变化，本地草稿未被覆盖/),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("尚未保存的本地草稿")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "载入磁盘版本" }));
    expect(screen.getByDisplayValue("外部编辑后的版本")).toBeInTheDocument();
  });

  it("renders and persists the setting library as a spatial Markdown workspace", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer context={context(storage, "lore", vi.fn())} />,
    );

    expect(await screen.findAllByText("测试小说世界根")).toHaveLength(2);
    expect(screen.getByText("每个节点必须关联层级类型")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /地图/ })).not.toBeInTheDocument();
    expect(screen.getByText("宇宙总览")).toBeInTheDocument();
    expect(screen.getByText("世界 · 虚拟页面")).toBeInTheDocument();
    const visualEditor =
      await screen.findByPlaceholderText("开始记录这个设定……");
    expect(visualEditor).toBeInTheDocument();
    const pagePath =
      "world/setting-library/pages/world-root/page-world-root-universe-overview.md";
    expect(storage.getText(pagePath)).toBeUndefined();
    fireEvent.change(visualEditor, {
      target: { value: "# 新的世界法则\n\n事实源正文" },
    });

    await waitFor(() => {
      expect(storage.getText(pagePath)).toContain("新的世界法则");
    });
    expect(screen.queryByText("作用域与继承")).not.toBeInTheDocument();
    expect(screen.queryByText("冲突优先级")).not.toBeInTheDocument();
  });

  it("creates a spatial node under any selected parent", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer context={context(storage, "lore", vi.fn())} />,
    );

    await screen.findByText("宇宙总览");
    fireEvent.click(screen.getByRole("button", { name: "新增子节点" }));
    expect(screen.getByRole("button", { name: "父节点" })).toHaveTextContent(
      "测试小说世界根",
    );
    fireEvent.change(screen.getByLabelText("节点名称"), {
      target: { value: "第一大陆" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建节点" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "新增子节点" }));
    expect(screen.getByRole("button", { name: "父节点" })).toHaveTextContent(
      "第一大陆",
    );
    fireEvent.click(screen.getByRole("button", { name: "父节点" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /^选择父节点：测试小说世界根 · /,
      }),
    );
    fireEvent.change(screen.getByLabelText("节点名称"), {
      target: { value: "第二大陆" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建节点" }));

    await waitFor(() => {
      const tree = JSON.parse(
        storage.getText("world/setting-library/spatial-tree.json") ?? "{}",
      ) as { nodes?: Array<{ name: string; parentId: string | null }> };
      expect(
        tree.nodes?.find((node) => node.name === "第二大陆")?.parentId,
      ).toBe("world-root");
    });
  });

  it("resolves the configured prompt before opening a MyAgents Agent Session", async () => {
    const storage = createEmptyNovelStorage();
    const openAgentSession = vi.fn(
      async (
        _request: Parameters<
          WorkbenchRendererContext["agentSessions"]["open"]
        >[0],
      ) => undefined,
    );
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "lore", vi.fn(), openAgentSession)}
      />,
    );

    await screen.findByText("宇宙总览");
    fireEvent.click(screen.getByRole("button", { name: "AI 创建世界" }));

    await waitFor(() => {
      expect(openAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          title: "世界架构向导 · 测试小说",
          promptId: "novel.world.guide",
          presentation: "dialog",
          conversationKey: "novel.world.architecture",
          initialMessage: expect.stringContaining("资深的世界设计师"),
          toolset: expect.objectContaining({
            id: "novel-world",
            context: expect.objectContaining({ mode: "world" }),
          }),
        }),
      );
    });
    expect(openAgentSession.mock.calls[0]?.[0].initialMessage).toContain(
      '"title": "测试小说"',
    );
    expect(openAgentSession.mock.calls[0]?.[0].initialMessage).toContain(
      "受控写回协议",
    );
    expect(openAgentSession.mock.calls[0]?.[0].initialMessage).toContain(
      "novel_world_submit_draft",
    );
  });

  it("renders editable level types, templates and profiles in meta configuration", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "lore-config", vi.fn())}
      />,
    );

    await screen.findByRole("button", { name: /层级类型/, current: "page" });
    expect(screen.getByRole("button", { current: "page" })).toHaveTextContent(
      "层级类型",
    );
    fireEvent.click(screen.getByRole("button", { name: /类型模板关联/ }));
    expect(screen.getByText("默认模板不是限制。")).toBeInTheDocument();
    expect(
      screen.getByText("首次编辑某页时才创建对应 Markdown 文件。"),
    ).toBeInTheDocument();
  });

  it("renders the map editor with an empty map library", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer context={context(storage, "map", vi.fn())} />,
    );

    expect(
      await screen.findByRole("heading", { name: "世界地图" }),
    ).toBeInTheDocument();
    // 空项目引导：地图库为空，提示新建地图
    expect(
      await screen.findByText(/暂无地图/),
    ).toBeInTheDocument();
    // 空间节点树视图保留
    fireEvent.click(screen.getByRole("button", { name: "空间节点树" }));
    expect(
      await screen.findByText(/尚无空间节点/),
    ).toBeInTheDocument();
  });

  it("persists prompt metadata and Markdown through the formal prompt route", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "ai-prompts", vi.fn())}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "提示词管理" }),
    ).toBeInTheDocument();
    expect(storage.getText("prompts/registry.json")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "新增提示词" }));
    fireEvent.change(screen.getByLabelText("提示词名称"), {
      target: { value: "场景节奏校准" },
    });
    fireEvent.change(screen.getByLabelText("稳定 ID"), {
      target: { value: "novel.scene.pacing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并编辑" }));

    const editor = await screen.findByPlaceholderText("开始编写提示词……");
    fireEvent.change(editor, {
      target: { value: "# 场景节奏校准\n\n检查冲突升级与回落节奏。\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存提示词" }));

    await waitFor(() => {
      const registry = JSON.parse(
        storage.getText("prompts/registry.json") ?? "{}",
      ) as {
        prompts?: Array<{
          promptId: string;
          contentPath: string;
        }>;
      };
      const prompt = registry.prompts?.find(
        (item) => item.promptId === "novel.scene.pacing",
      );
      expect(prompt).toBeDefined();
      expect(storage.getText(prompt?.contentPath ?? "")).toContain(
        "检查冲突升级与回落节奏",
      );
    });
  });
});
