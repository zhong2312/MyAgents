import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

vi.mock("@/workbench-sdk/DiffViewer", async () => {
  const React = await import("react");
  interface MockDiffViewerProps {
    readonly modified: string;
    readonly fontSize?: number;
    readonly lineHeight?: number;
    readonly onModifiedChange?: (value: string) => void;
  }
  return {
    default: ({
      modified,
      fontSize,
      lineHeight,
      onModifiedChange,
    }: MockDiffViewerProps) =>
      React.createElement("textarea", {
        "aria-label": onModifiedChange ? "编辑当前候选" : "当前候选",
        "data-font-size": fontSize,
        "data-line-height": lineHeight,
        readOnly: !onModifiedChange,
        value: modified,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onModifiedChange?.(event.target.value),
      }),
  };
});

vi.mock("@/hooks/useAvailableProviders", () => ({
  useAvailableProviders: () => [],
}));

import type {
  WorkbenchNavigationGuard,
  WorkbenchRendererContext,
} from "@/workbench-sdk";
import { dismissTopmost } from "@/utils/closeLayer";

import novelWorkbenchDefinition from "./index";
import {
  createManuscriptTrackingRepository,
  hashManuscriptContent,
} from "./manuscriptTrackingRepository";
import { createNarrativeEngineeringRepository } from "./narrativeEngineeringRepository";
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
  runAi: WorkbenchRendererContext["aiRuns"]["run"] | null = null,
  agentSessionsAvailable = true,
  registerNavigationGuard: WorkbenchRendererContext["registerNavigationGuard"] = () =>
    () =>
      undefined,
  search: WorkbenchRendererContext["search"] = {
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
  cancelAi: WorkbenchRendererContext["aiRuns"]["cancel"] = async () =>
    undefined,
  subscribeProgress: WorkbenchRendererContext["aiRuns"]["subscribeProgress"] = () =>
    () =>
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
      isAvailable: agentSessionsAvailable,
      open: openAgentSession,
    },
    aiRuns: {
      isAvailable: runAi !== null,
      run:
        runAi ??
        (async () => {
          throw new Error("AI runs unavailable in renderer fixture");
        }),
      cancel: cancelAi,
      subscribeProgress,
    },
    search,
    projection: new NovelMemoryProjection([], [], false),
    navigate,
    registerNavigationGuard,
  };
}

describe("NovelWorkbenchRenderer storage loop", () => {
  it("shows and updates project planning details from the overview", async () => {
    const storage = createEmptyNovelStorage();
    render(
      <NovelWorkbenchRenderer
        context={context(storage, "overview", vi.fn())}
      />,
    );

    expect(await screen.findAllByText("25 至 35 万字")).toHaveLength(2);
    expect(screen.getByText("100 至 140 章")).toBeInTheDocument();
    expect(screen.getByText("第三人称限知")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));

    expect(screen.getByLabelText("项目名")).toHaveValue("test-novel-01");
    expect(screen.getByRole("button", { name: "写作视角" })).toHaveTextContent(
      "第三人称限知",
    );
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
    fireEvent.click(screen.getByRole("button", { name: "写作视角" }));
    fireEvent.click(screen.getByRole("button", { name: "第一人称" }));
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
      writingPerspective: "first-person",
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

  it("在正文剧情工程结构中展示未归类章节，而不是归入自由内容", async () => {
    const storage = createEmptyNovelStorage();
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const narrative = await narrativeRepository.load();
    const plan = {
      id: "chapter-plan-unassigned",
      directoryId: null,
      manuscriptChapterId: null,
      title: "未归类正文",
      description: "暂时未归入卷篇组的章节。",
      status: "idea" as const,
      order: 0,
      updatedAt: "2026-07-14T12:00:00.000Z",
      lineIds: [],
      arcIds: [],
      sections: [],
    };
    await narrativeRepository.save(narrative, {
      ...narrative.library,
      chapters: [plan],
    });

    const novelRepository = createNovelRepository(storage);
    const project = await novelRepository.load();
    await novelRepository.createChapter(project, {
      narrativeChapterId: plan.id,
      title: plan.title,
    });

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn())}
      />,
    );

    const unassignedGroup = await screen.findByRole("group", {
      name: "剧情工程未归类章节",
    });
    expect(unassignedGroup).toHaveTextContent("未归类");
    expect(unassignedGroup).toHaveTextContent("未归类正文");
    expect(unassignedGroup.querySelectorAll(".ms-chapter-row")).toHaveLength(1);
    const freeContentGroup = document.querySelector(".ms-free-content-group");
    expect(freeContentGroup).toBeInTheDocument();
    expect(freeContentGroup).not.toHaveTextContent("未归类正文");
    expect(
      screen.getByRole("button", { name: /未归类正文/u }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /未归类正文/u }));
    expect(await screen.findByDisplayValue("未归类正文")).toBeInTheDocument();
    const chapterGoal = document.querySelector(".ms-chapter-goal");
    expect(chapterGoal).toBeInTheDocument();
    expect(chapterGoal).toHaveTextContent("章节目标");
    expect(chapterGoal).toHaveTextContent("目标：暂时未归入卷篇组的章节。");
    fireEvent.click(screen.getByRole("button", { name: "收起章节目标" }));
    expect(chapterGoal?.querySelector("p")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开章节目标" }));
    expect(chapterGoal).toHaveTextContent("目标：暂时未归入卷篇组的章节。");
  });

  it("allows returning to the chapter editor from continuity tracking", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn())}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "状态同步" }));
    expect(
      await screen.findByRole("heading", { name: "正文状态同步" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "回到正文" }));
    expect(await screen.findByLabelText("章节正文")).toBeInTheDocument();
  });

  it("移动端上下文按钮切换真实的上下文面板并可返回编辑面板", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);

    const view = render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn())}
      />,
    );
    await screen.findByLabelText("章节正文");

    const studioBody = view.container.querySelector(".ms-body");
    expect(studioBody).toHaveClass("is-mobile-editor");
    fireEvent.click(screen.getByRole("button", { name: "打开基本与排版面板" }));
    expect(studioBody).toHaveClass("is-mobile-context");
    fireEvent.click(screen.getByRole("button", { name: "收起基本与排版面板" }));
    expect(studioBody).toHaveClass("is-mobile-editor");
  });

  it("连续性账本载入期间禁用分析入口并在载入后恢复", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    const originalReadText = storage.readText.bind(storage);
    let releaseLedgerRead: (() => void) | null = null;
    let ledgerReadStarted = false;
    vi.spyOn(storage, "readText").mockImplementation(async (path) => {
      if (path === "manuscript/state-ledger/index.json" && !ledgerReadStarted) {
        ledgerReadStarted = true;
        await new Promise<void>((resolve) => {
          releaseLedgerRead = resolve;
        });
      }
      return originalReadText(path);
    });
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({ summary: "", changes: [] }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "状态同步" }));
    const loadingButton = await screen.findByRole("button", {
      name: "正在载入状态账本",
    });
    expect(loadingButton).toBeDisabled();
    expect(runAi).not.toHaveBeenCalled();
    await waitFor(() => expect(ledgerReadStarted).toBe(true));

    if (!releaseLedgerRead) throw new Error("连续性账本读取未启动");
    await act(async () => {
      releaseLedgerRead?.();
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "分析当前章节" }),
      ).not.toBeDisabled();
    });
  });

  it("从全文搜索结果跳转到所属资料库", async () => {
    const storage = createEmptyNovelStorage();
    const navigate = vi.fn();
    const search: WorkbenchRendererContext["search"] = {
      isAvailable: true,
      searchFiles: vi.fn(async () => ({
        hits: [
          {
            path: "world/factions/records/faction-north.json",
            name: "faction-north.json",
            matchCount: 1,
            matches: [],
          },
        ],
        totalFiles: 1,
        totalMatches: 1,
        queryTimeMs: 1,
      })),
      async refreshIndex() {
        return [1, 0];
      },
      async invalidateIndex() {},
    };
    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "search",
          navigate,
          undefined,
          null,
          true,
          undefined,
          search,
        )}
      />,
    );

    fireEvent.change(
      await screen.findByPlaceholderText("搜索实体或正文内容…"),
      { target: { value: "北境" } },
    );
    const hit = await screen.findByRole("button", {
      name: /world\/factions\/records\/faction-north\.json/u,
    });
    fireEvent.click(hit);

    expect(navigate).toHaveBeenCalledWith("factions");
  });

  it("在正文索引写入未完成时禁用全部 AI 入口", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    const originalWriteText = storage.writeText.bind(storage);
    let releaseIndexWrite: (() => void) | null = null;
    let holdNextIndexWrite = true;
    vi.spyOn(storage, "writeText").mockImplementation(
      async (path, content, options) => {
        if (path === "manuscript/index.json" && holdNextIndexWrite) {
          holdNextIndexWrite = false;
          await new Promise<void>((resolve) => {
            releaseIndexWrite = resolve;
          });
        }
        return originalWriteText(path, content, options);
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          async () => ({ output: "候选正文" }),
        )}
      />,
    );

    const titleInput = await screen.findByLabelText("章节标题");
    fireEvent.change(titleInput, { target: { value: "等待写入的章节标题" } });
    fireEvent.blur(titleInput);
    await waitFor(() => {
      expect(screen.getByTitle("从光标处续写")).toBeDisabled();
      expect(screen.getByTitle("生成完整正文")).toBeDisabled();
    });

    if (!releaseIndexWrite) throw new Error("正文索引写入未启动");
    await act(async () => {
      releaseIndexWrite?.();
    });
    await waitFor(() => {
      expect(screen.getByTitle("从光标处续写")).not.toBeDisabled();
      expect(screen.getByTitle("生成完整正文")).not.toBeDisabled();
    });
  });

  it("在手动保存正文期间禁止启动 AI", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "初始正文");
    const originalWriteText = storage.writeText.bind(storage);
    let releaseChapterWrite: (() => void) | null = null;
    let holdNextChapterWrite = true;
    vi.spyOn(storage, "writeText").mockImplementation(
      async (path, content, options) => {
        if (path === chapter.path && holdNextChapterWrite) {
          holdNextChapterWrite = false;
          await new Promise<void>((resolve) => {
            releaseChapterWrite = resolve;
          });
        }
        return originalWriteText(path, content, options);
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          async () => ({ output: "候选正文" }),
        )}
      />,
    );

    fireEvent.change(await screen.findByLabelText("章节正文"), {
      target: { value: "等待保存的新正文" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.getByTitle("从光标处续写")).toBeDisabled();
      expect(screen.getByTitle("生成完整正文")).toBeDisabled();
    });

    if (!releaseChapterWrite) throw new Error("正文保存未启动");
    await act(async () => {
      releaseChapterWrite?.();
    });
    await waitFor(() => {
      expect(screen.getByTitle("从光标处续写")).not.toBeDisabled();
      expect(screen.getByTitle("生成完整正文")).not.toBeDisabled();
    });
  });

  it("标记章节完成后会启动连续性同步", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨夜里，主角抵达旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        summary: "没有需要同步的状态变化",
        changes: [],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "基本" }));
    fireEvent.click(await screen.findByLabelText("章节状态"));
    fireEvent.click(await screen.findByRole("button", { name: "已完成" }));

    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(1));
    expect(runAi).toHaveBeenCalledWith(
      expect.objectContaining({
        executionProfile: "extended",
        timeoutMs: 300_000,
        maxTurns: 16,
      }),
    );
    await waitFor(() => {
      const index = storage.getText("manuscript/index.json") ?? "";
      expect(index).toContain('"status": "complete"');
      expect(index).toContain('"trackingStatus": "synced"');
    });
  });

  it("连续性分析允许把默认五分钟超时调整为十分钟以内", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨夜里，主角抵达旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        summary: "没有需要同步的状态变化",
        changes: [],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "状态同步" }));
    const timeoutSelect = await screen.findByRole("button", {
      name: "连续性分析超时",
    });
    expect(timeoutSelect).toHaveTextContent("5 分钟");
    fireEvent.click(timeoutSelect);
    fireEvent.click(await screen.findByRole("button", { name: "8 分钟" }));
    fireEvent.click(screen.getByRole("button", { name: "分析当前章节" }));

    await waitFor(() =>
      expect(runAi).toHaveBeenCalledWith(
        expect.objectContaining({
          executionProfile: "extended",
          timeoutMs: 480_000,
          maxTurns: 16,
        }),
      ),
    );
  });

  it("连续性分析落库前剔除无法在正文逐字定位的模型证据", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨夜里，主角抵达旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        summary: "主角在雨夜抵达旧港",
        changes: [
          {
            domain: "continuity",
            entityId: null,
            title: "抵达旧港",
            before: null,
            after: "主角已经抵达旧港",
            evidence: "主角抵达旧港",
            operation: { kind: "continuity-fact", key: "arrived-old-port" },
          },
          {
            domain: "continuity",
            entityId: null,
            title: "雨夜抵达",
            before: null,
            after: "主角在下雨的夜晚抵达",
            evidence: "下着雨的夜晚，主角来到了旧港。",
            operation: { kind: "continuity-fact", key: "rainy-arrival" },
          },
        ],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "状态同步" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "分析当前章节" }),
    );

    await waitFor(async () => {
      const loaded = await createManuscriptTrackingRepository(storage).load();
      expect(loaded.ledger.batches[0]?.changes).toEqual([
        expect.objectContaining({
          title: "抵达旧港",
          evidence: "主角抵达旧港",
        }),
      ]);
      expect(loaded.ledger.batches[0]?.summary).toContain("已忽略 1 项");
    });
    expect(screen.queryByText("雨夜抵达")).not.toBeInTheDocument();
  });

  it("连续性分析不会为全部无效的模型证据创建待审批次", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨夜里，主角抵达旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        summary: "模型只返回了改写证据",
        changes: [
          {
            domain: "continuity",
            entityId: null,
            title: "雨夜抵达",
            before: null,
            after: "主角在下雨的夜晚抵达",
            evidence: "下着雨的夜晚，主角来到了旧港。",
            operation: { kind: "continuity-fact", key: "rainy-arrival" },
          },
        ],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "状态同步" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "分析当前章节" }),
    );

    expect(
      await screen.findByText(
        "连续性分析返回的 1 项变化均缺少可逐字定位的正文证据，请重新分析",
      ),
    ).toBeInTheDocument();
    const loaded = await createManuscriptTrackingRepository(storage).load();
    expect(loaded.ledger.batches).toEqual([]);
  });

  it("同步页签将分析、同步、放弃和查看固定在顶部同一行", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, vi.fn())}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "同步" }));
    const syncToolbar = await screen.findByRole("toolbar", {
      name: "状态同步操作",
    });
    expect(syncToolbar).toHaveClass("ms-sync-toolbar");
    expect(
      within(syncToolbar)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["分析", "同步", "放弃", "查看"]);
    expect(
      within(syncToolbar).getByRole("button", { name: "同步" }),
    ).toBeDisabled();
    expect(
      within(syncToolbar).getByRole("button", { name: "放弃" }),
    ).toBeDisabled();
    expect(
      within(syncToolbar).getByRole("button", { name: "查看" }),
    ).toBeEnabled();
  });

  it("同步页签会禁用缺少人物引用的旧批次变化并保留可同步项", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    const content = "他终于踏入筑基期。";
    storage.setExternalText(chapter.path, content);
    const trackingRepository = createManuscriptTrackingRepository(storage);
    const tracking = await trackingRepository.load();
    await trackingRepository.createProposal(tracking, {
      chapterId: chapter.id,
      chapterContentHash: hashManuscriptContent(content),
      summary: "包含无效人物引用",
      changes: [
        {
          domain: "continuity",
          entityId: null,
          title: "正文事实",
          before: null,
          after: "已经踏入筑基期",
          evidence: "踏入筑基期",
          operation: { kind: "continuity-fact", key: "realm-change" },
        },
        {
          domain: "character-state",
          entityId: null,
          title: "缺少人物引用",
          before: null,
          after: "进入筑基期",
          evidence: "踏入筑基期",
          operation: { kind: "character-field", field: "currentRealm" },
        },
      ],
    });

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, vi.fn())}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "同步" }));
    const invalidReference = await screen.findByRole("checkbox", {
      name: /缺少人物引用/u,
    });
    expect(invalidReference).not.toBeChecked();
    expect(invalidReference).toBeDisabled();
    expect(
      within(screen.getByRole("toolbar", { name: "状态同步操作" })).getByRole(
        "button",
        { name: "同步" },
      ),
    ).toBeEnabled();
  });

  it("旧批次的无效证据默认取消选择且不阻断有效项同步", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    const content = "雨夜里，主角抵达旧港。";
    storage.setExternalText(chapter.path, content);
    const trackingRepository = createManuscriptTrackingRepository(storage);
    const tracking = await trackingRepository.load();
    await trackingRepository.createProposal(tracking, {
      chapterId: chapter.id,
      chapterContentHash: hashManuscriptContent(content),
      summary: "旧批次",
      changes: [
        {
          domain: "continuity",
          entityId: null,
          title: "有效抵达事实",
          before: null,
          after: "主角已经抵达旧港",
          evidence: "主角抵达旧港",
          operation: { kind: "continuity-fact", key: "valid-arrival" },
        },
        {
          domain: "continuity",
          entityId: null,
          title: "无效改写证据",
          before: null,
          after: "主角在下雨的夜晚抵达",
          evidence: "下着雨的夜晚，主角来到了旧港。",
          operation: { kind: "continuity-fact", key: "invalid-arrival" },
        },
      ],
    });

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, vi.fn())}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "同步" }));
    const invalidEvidence = await screen.findByRole("checkbox", {
      name: /无效改写证据/u,
    });
    expect(invalidEvidence).not.toBeChecked();
    expect(invalidEvidence).toBeDisabled();
    const syncToolbar = screen.getByRole("toolbar", {
      name: "状态同步操作",
    });
    expect(
      within(syncToolbar)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(["分析", "同步", "放弃", "查看"]);
    const syncButton = within(syncToolbar).getByRole("button", {
      name: "同步",
    });
    expect(syncButton).toBeEnabled();
    expect(
      within(syncToolbar).getByRole("button", { name: "放弃" }),
    ).toBeEnabled();

    fireEvent.click(syncButton);
    await waitFor(async () => {
      const loaded = await trackingRepository.load();
      expect(
        loaded.ledger.batches.find((batch) => batch.status === "applied")
          ?.changes,
      ).toEqual([expect.objectContaining({ title: "有效抵达事实" })]);
      expect(
        loaded.ledger.batches.find((batch) => batch.status === "proposed")
          ?.changes,
      ).toEqual([expect.objectContaining({ title: "无效改写证据" })]);
    });
  });

  it("正文提炼候选必须确认处理后才能关闭或离开", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨夜里，主角抵达旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        chapters: [
          {
            sourceChapterId: chapter.id,
            title: "旧港雨夜",
            description: "主角在雨夜抵达旧港，并发现异常灯火。",
            sections: [],
          },
        ],
      }),
    }));
    const navigationGuardRef: { current: WorkbenchNavigationGuard | null } = {
      current: null,
    };
    const registerNavigationGuard: WorkbenchRendererContext["registerNavigationGuard"] =
      (guard) => {
        navigationGuardRef.current = guard;
        return () => {
          if (navigationGuardRef.current === guard) {
            navigationGuardRef.current = null;
          }
        };
      };

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          true,
          registerNavigationGuard,
        )}
      />,
    );

    await screen.findByLabelText("章节正文");
    fireEvent.click(screen.getByRole("button", { name: "基本" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "提炼到剧情工程" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "AI 提炼正文事实" }),
    );
    expect(await screen.findByDisplayValue("旧港雨夜")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "AI 提炼正文事实" }),
    ).toBeDisabled();

    await waitFor(() => expect(navigationGuardRef.current).not.toBeNull());
    const navigationGuard = navigationGuardRef.current;
    if (!navigationGuard) throw new Error("正文导航守卫未注册");
    const leaveAttempt = navigationGuard.confirmLeave();
    expect(
      await screen.findByRole("heading", { name: "正文有未保存修改" }),
    ).toBeVisible();
    const continueEditingButtons = screen.getAllByRole("button", {
      name: "继续编辑",
    });
    fireEvent.click(continueEditingButtons.at(-1)!);
    await expect(leaveAttempt).resolves.toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "关闭正文提炼" }));
    expect(await screen.findByText("放弃正文提炼候选")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃候选" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "从正文提炼到剧情工程" }),
      ).not.toBeInTheDocument();
    });
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
    await waitFor(() => {
      expect(screen.getByDisplayValue("外部编辑后的版本")).toBeInTheDocument();
    });
  });

  it("丢弃质量审查期间被外部改写正文的旧结果", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    const resolveRuns: Array<(value: AiResult) => void> = [];
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      () =>
        new Promise<AiResult>((resolve) => {
          resolveRuns.push(resolve);
        }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "检查正文质量" }),
    );
    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(1));
    storage.setExternalText(chapter.path, "外部编辑器改写后的正文。");
    const resolveAiRun = resolveRuns.at(0);
    if (!resolveAiRun) throw new Error("质量审查请求尚未建立");
    resolveAiRun({
      output: JSON.stringify({
        score: 92,
        summary: "整体稳定",
        issues: [],
        passed: ["连续性正常"],
      }),
    });

    expect(
      await screen.findByText(
        "磁盘正文在质量审查期间发生变化，旧结果已丢弃，请重新检查",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("整体稳定")).not.toBeInTheDocument();
  });

  it("丢弃即时 AI 返回前被外部改写正文的候选", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    const resolveRuns: Array<(value: AiResult) => void> = [];
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      () =>
        new Promise<AiResult>((resolve) => {
          resolveRuns.push(resolve);
        }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
        )}
      />,
    );

    fireEvent.click(await screen.findByTitle("润色选区；无选区时处理全文"));
    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(1));
    storage.setExternalText(chapter.path, "外部编辑器改写后的正文。");
    const resolveAiRun = resolveRuns.at(0);
    if (!resolveAiRun) throw new Error("即时 AI 请求尚未建立");
    resolveAiRun({ output: "候选不应显示" });

    expect(
      await screen.findByText(
        "磁盘正文在候选生成后已经变化，请先载入最新版本再重新生成候选",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("候选不应显示")).not.toBeInTheDocument();
  });

  it("载入外部正文版本时不会静默丢弃待处理的即时 AI 候选", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const runAi = vi.fn(async () => ({ output: "新的润色候选" }));

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
        )}
      />,
    );

    fireEvent.click(await screen.findByTitle("润色选区；无选区时处理全文"));
    expect(
      await screen.findByRole("dialog", { name: "润色候选" }),
    ).toBeInTheDocument();
    storage.setExternalText(chapter.path, "外部编辑器改写后的正文。");

    expect(
      await screen.findByText(/磁盘正文已变化，本地草稿未被覆盖/),
    ).toBeInTheDocument();
    const reloadButton = screen.getByRole("button", { name: "载入磁盘版本" });
    expect(reloadButton).toBeDisabled();
    expect(
      screen.getByRole("dialog", { name: "润色候选" }),
    ).toBeInTheDocument();
  });

  it("完整生成候选在关闭前必须明确放弃", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const generatedText = "字".repeat(2700);
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      async () => ({ output: generatedText }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    const skipToGeneration = await screen.findByRole("button", {
      name: "跳过方案与确认",
    });
    await waitFor(() => expect(skipToGeneration).toBeEnabled());
    fireEvent.click(skipToGeneration);
    fireEvent.click(
      await screen.findByRole("button", { name: "开始生成正文" }),
    );
    expect(
      await screen.findByRole("region", { name: "生成正文差异" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭完整生成" }));
    expect(await screen.findByText("放弃生成的正文候选")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "生成正文差异" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放弃候选" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("生成的正文候选")).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("雨落在旧港。")).toBeInTheDocument();
  });

  it("完整生成候选可与生成前正文对比", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const generatedText = "字".repeat(2700);
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      async () => ({ output: generatedText }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    const skipToGeneration = await screen.findByRole("button", {
      name: "跳过方案与确认",
    });
    await waitFor(() => expect(skipToGeneration).toBeEnabled());
    fireEvent.click(skipToGeneration);
    fireEvent.click(
      await screen.findByRole("button", { name: "开始生成正文" }),
    );
    expect(
      await screen.findByRole("region", { name: "生成正文差异" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("生成前正文 / 当前候选")).not.toBeInTheDocument();
    expect(
      screen.getByText("当前候选 2,700 字，采用后写入正文草稿但不会自动保存。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑候选" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "采用到正文" })).toBeEnabled();
    expect(
      screen.queryByRole("dialog", { name: "生成正文差异" }),
    ).not.toBeInTheDocument();
  });

  it("完整生成可取消且不会保留候选", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    let rejectRun: ((reason?: unknown) => void) | undefined;
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      () =>
        new Promise<{ output: string }>((_resolve, reject) => {
          rejectRun = reject;
        }),
    );
    const cancelAi: WorkbenchRendererContext["aiRuns"]["cancel"] = vi.fn(
      async () => {
        rejectRun?.(new Error("本次 AI 生成已取消"));
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
          undefined,
          undefined,
          cancelAi,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    const skipToGeneration = await screen.findByRole("button", {
      name: "跳过方案与确认",
    });
    await waitFor(() => expect(skipToGeneration).toBeEnabled());
    fireEvent.click(skipToGeneration);
    fireEvent.click(
      await screen.findByRole("button", { name: "开始生成正文" }),
    );
    const cancelButton = await screen.findByRole("button", {
      name: "取消生成",
    });
    fireEvent.click(cancelButton);

    await waitFor(() => expect(cancelAi).toHaveBeenCalledOnce());
    expect(cancelAi).toHaveBeenCalledWith(
      expect.stringMatching(/^full-generation-/u),
    );
    expect(
      await screen.findByText("正文生成已取消，未写入草稿。"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("生成的正文候选")).not.toBeInTheDocument();
  });

  it("完整生成方案在关闭前必须明确放弃", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        plans: [
          {
            title: "雨夜入局",
            premise: "主角用旧案试探来客的立场。",
            fragments: [
              {
                title: "门前试探",
                summary: "建立来客与主角之间的互相试探。",
                content:
                  "雨水顺着门槛渗进屋内，主角没有立刻接过来客递出的信，而是先说出旧案里那句从未写进卷宗的话。",
              },
            ],
          },
        ],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    fireEvent.click(await screen.findByRole("button", { name: "并行生成" }));
    expect(await screen.findAllByText("雨夜入局")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭完整生成" }));
    expect(await screen.findByText("放弃 AI 方案")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getAllByText("雨夜入局")).not.toHaveLength(0);
  });

  it("质量审查过期后可重新检查", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify({
        score: 92,
        summary: "整体稳定",
        issues: [],
        passed: ["连续性正常"],
      }),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "质量" }));
    const timeoutSelect = await screen.findByRole("button", {
      name: "质量检查超时",
    });
    expect(timeoutSelect).toHaveTextContent("5 分钟");
    fireEvent.click(timeoutSelect);
    fireEvent.click(await screen.findByRole("button", { name: "8 分钟" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始质量检查" }),
    );
    await waitFor(() =>
      expect(runAi).toHaveBeenCalledWith(
        expect.objectContaining({
          executionProfile: "extended",
          timeoutMs: 480_000,
          maxTurns: 16,
        }),
      ),
    );
    expect(await screen.findByText("整体稳定")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("雨落在旧港。"), {
      target: { value: "雨停在旧港。" },
    });
    expect(
      await screen.findByText(
        "正文已变化，这份审查结果仅供参考，请重新检查后再生成修复候选。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  });

  it("在剧情推演运行期间禁止关闭工作室，并在完成后恢复关闭", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。\n钟声敲过第三遍。");
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    const resolveRuns: Array<(value: AiResult) => void> = [];
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      () =>
        new Promise<AiResult>((resolve) => {
          resolveRuns.push(resolve);
        }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "剧情推演室" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始推演 · 12 条路径" }),
    );

    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(6));
    expect(
      screen.getByRole("button", { name: "关闭 AI 剧情推演室" }),
    ).toBeDisabled();

    for (const resolve of resolveRuns) resolve({ output: "[]" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "关闭 AI 剧情推演室" }),
      ).not.toBeDisabled();
    });
  });

  it("剧情推演可取消并丢弃所有在途候选", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    const rejectRuns = new Map<string, (reason?: unknown) => void>();
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      (request) =>
        new Promise<AiResult>((_resolve, reject) => {
          if (request.runId) rejectRuns.set(request.runId, reject);
        }),
    );
    const cancelAi: WorkbenchRendererContext["aiRuns"]["cancel"] = vi.fn(
      async (runId) => {
        rejectRuns.get(runId)?.(new Error("本次 AI 生成已取消"));
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          true,
          undefined,
          undefined,
          cancelAi,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "剧情推演室" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始推演 · 12 条路径" }),
    );
    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(6));

    fireEvent.click(screen.getByRole("button", { name: "取消推演" }));
    await waitFor(() => expect(cancelAi).toHaveBeenCalledTimes(6));
    expect(
      await screen.findByText("本次剧情推演已取消，未保留候选路径。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "剧情路径差异" }),
    ).not.toBeInTheDocument();
  });

  it("剧情推演候选在关闭前必须明确放弃", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。钟声敲过第三遍。");
    const runAi = vi.fn(async () => ({
      output: JSON.stringify([
        {
          title: "灯下的代价",
          premise: "主角必须在救人与守住秘密之间选择。",
          outline: ["旧友带来一封不能公开的信", "代价落到最信任的人身上"],
          riskLevel: "medium",
          coherence: 88,
          novelty: 74,
          riskScore: 42,
          tags: ["选择", "代价"],
          nodes: [
            {
              offset: 1,
              title: "半夜通行",
              summary: "主角用承诺换取通行。",
              checkpoint: "承诺可被追责",
            },
          ],
        },
      ]),
    }));

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "剧情推演室" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始推演 · 12 条路径" }),
    );
    expect(await screen.findAllByText("灯下的代价")).not.toHaveLength(0);

    expect(
      await screen.findAllByRole("region", { name: "剧情路径差异" }),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("生成基线 / 当前候选")).not.toHaveLength(0);
    expect(
      screen.queryByRole("dialog", { name: "剧情路径差异" }),
    ).not.toBeInTheDocument();

    const firstDiff = screen.getAllByRole("region", {
      name: "剧情路径差异",
    })[0];
    const firstPath = firstDiff.closest("article");
    expect(firstPath).not.toBeNull();
    const editedSimulationDraft = [
      "# 候选路径：人工调整后的代价",
      "## 前提",
      "主角决定公开秘密。",
      "## 方案正文",
      "主角当众交出半封信。",
      "## 章节节点",
      "### 第 2 章 · 当面对质",
      "#### 内容",
      "主角交出证据。",
      "#### 验收",
      "证据来源必须闭合",
    ].join("\n\n");
    fireEvent.change(
      await within(firstDiff).findByRole("textbox", {
        name: "编辑当前候选",
      }),
      { target: { value: editedSimulationDraft } },
    );
    fireEvent.click(
      within(firstPath as HTMLElement).getByRole("button", {
        name: "送入剧情工程",
      }),
    );
    await waitFor(async () => {
      const narrative =
        await createNarrativeEngineeringRepository(storage).load();
      expect(narrative.library.simulationProposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "人工调整后的代价",
            premise: "主角决定公开秘密。",
            description: "主角当众交出半封信。",
            nodes: [
              expect.objectContaining({
                offset: 1,
                title: "当面对质",
                summary: "主角交出证据。",
                checkpoint: "证据来源必须闭合",
              }),
            ],
          }),
        ]),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭 AI 剧情推演室" }));
    expect(
      await screen.findByText(
        "当前推演室中有尚未处理的候选剧情路径。放弃后不会写入剧情工程，且无法恢复，是否继续？",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭 AI 剧情推演室" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getAllByText("灯下的代价")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭 AI 剧情推演室" }));
    fireEvent.click(await screen.findByRole("button", { name: "放弃候选" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "关闭 AI 剧情推演室" }),
      ).not.toBeInTheDocument();
    });
  });

  it("脑暴完整方案可与生成基线对比", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。钟声敲过第三遍。");
    const contracts = ["plan-1", "plan-2", "plan-3"].map((id, index) => ({
      id,
      title: `方案 ${index + 1}`,
      coreChoice: "主角以旧案试探来客。",
      causalChain: "旧案线索迫使双方交换条件。",
      requiredBeats: ["抛出旧案", "确认代价"],
      characterQuestion: "来客是否可信？",
      emotionArc: "戒备转向决断。",
      twist: "来客知道失落卷宗。",
      hook: "钟声再次响起。",
      nonNegotiables: ["不得泄露主角身份"],
      openQuestions: [],
    }));
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      async (request) => {
        if (request.label.includes("总控会诊")) {
          return { output: JSON.stringify({ summary: "会诊完成", contracts }) };
        }
        if (request.label.includes("并行设计")) {
          return {
            output: JSON.stringify({
              contributions: contracts.map((contract) => ({
                planId: contract.id,
                contribution: "用行动与对话推进试探，并保留章末牵引。",
                evidence: ["旧案未结"],
                assumptions: ["来客持有线索"],
                conflicts: [],
              })),
            }),
          };
        }
        if (request.label.includes("总控整合与审计")) {
          return {
            output: JSON.stringify({
              plans: contracts.map((contract) => ({
                id: contract.id,
                title: contract.title,
                premise: contract.coreChoice,
                content: "【开场】雨声掩住脚步。\n\n① 主角以旧案试探来客。",
                opening: contract.hook,
                beats: contract.requiredBeats,
                evidence: ["旧案未结"],
                assumptions: ["来客持有线索"],
                conflicts: [],
                audit: { score: 86, summary: "可执行", risks: [] },
              })),
            }),
          };
        }
        return {
          output: JSON.stringify({
            opportunities: ["旧案可作为谈判筹码"],
            constraints: ["不得提前揭露身份"],
            recommendation: "先试探再交换条件",
            questions: [],
          }),
        };
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), undefined, runAi)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "AI 脑暴室" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始会诊 · 3 套完整方案" }),
    );
    expect(await screen.findAllByText("方案 1")).not.toHaveLength(0);

    expect(
      await screen.findByRole("region", { name: "脑暴方案差异" }),
    ).toBeInTheDocument();
    expect(screen.getByText("生成基线 / 当前候选")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "脑暴方案差异" }),
    ).not.toBeInTheDocument();

    const brainstormDiff = screen.getByRole("region", {
      name: "脑暴方案差异",
    });
    const brainstormEditor = await within(brainstormDiff).findByRole(
      "textbox",
      {
        name: "编辑当前候选",
      },
    );
    expect(brainstormEditor).toHaveAttribute("data-font-size", "14");
    fireEvent.click(screen.getByRole("button", { name: "脑暴产出字体缩放" }));
    fireEvent.click(await screen.findByRole("button", { name: "150%" }));
    await waitFor(() =>
      expect(brainstormEditor).toHaveAttribute("data-font-size", "21"),
    );

    fireEvent.change(brainstormEditor, {
      target: { value: "人工编辑后的完整脑暴方案" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "采用此完整方案并进入正文" }),
    );
    expect(
      await screen.findByDisplayValue("人工编辑后的完整脑暴方案"),
    ).toBeInTheDocument();
  });

  it("脑暴会诊可取消并丢弃所有在途候选", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    const rejectRuns = new Map<string, (reason?: unknown) => void>();
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      (request) =>
        new Promise<AiResult>((_resolve, reject) => {
          if (request.runId) rejectRuns.set(request.runId, reject);
        }),
    );
    const cancelAi: WorkbenchRendererContext["aiRuns"]["cancel"] = vi.fn(
      async (runId) => {
        rejectRuns.get(runId)?.(new Error("本次 AI 生成已取消"));
      },
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          true,
          undefined,
          undefined,
          cancelAi,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "AI 脑暴室" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "开始会诊 · 3 套完整方案" }),
    );
    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: "取消脑暴" }));
    await waitFor(() => expect(cancelAi).toHaveBeenCalledTimes(3));
    expect(
      await screen.findByText("本次脑暴已取消，未保留候选方案。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "脑暴方案差异" }),
    ).not.toBeInTheDocument();
  });

  it("完整生成只通过 extended AI Run 运行，不创建独立 Agent 会话", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    const openAgentSession = vi.fn(
      async (
        _request: Parameters<
          WorkbenchRendererContext["agentSessions"]["open"]
        >[0],
      ) => undefined,
    );
    const generatedText = "字".repeat(2700);
    const runAi = vi.fn(async () => ({ output: generatedText }));

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          openAgentSession,
          runAi,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    fireEvent.click(
      within(await screen.findByLabelText("生成步骤")).getByRole("button", {
        name: /生成$/u,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "开始生成正文" }),
    );

    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(1));
    expect(openAgentSession).not.toHaveBeenCalled();
    expect(runAi).toHaveBeenCalledWith(
      expect.objectContaining({
        executionProfile: "extended",
      }),
    );
    expect(
      await screen.findByRole("region", { name: "生成正文差异" }),
    ).toBeInTheDocument();
  });

  it("正文快捷润色只通过 Host AI Run 创建候选，不打开 Agent Session", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。");
    const openAgentSession = vi.fn(
      async (
        _request: Parameters<
          WorkbenchRendererContext["agentSessions"]["open"]
        >[0],
      ) => undefined,
    );
    const runAi = vi.fn(
      async (
        _request: Parameters<WorkbenchRendererContext["aiRuns"]["run"]>[0],
      ) => ({
        output: "雨落在更新后的旧港。",
      }),
    );

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          openAgentSession,
          runAi,
        )}
      />,
    );

    fireEvent.click(await screen.findByTitle("润色选区；无选区时处理全文"));

    await waitFor(() =>
      expect(runAi).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "第 1 章 · 润色",
          executionProfile: "standard",
          maxTurns: 1,
          streamOutput: true,
        }),
      ),
    );
    expect(runAi.mock.calls[0]?.[0]).not.toHaveProperty("toolset");
    expect(openAgentSession).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: "润色候选" }),
    ).toBeInTheDocument();
  });

  it("正文选区润色实时展示同一次无工具请求的文本增量", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    const chapter = await repository.createChapter(project);
    storage.setExternalText(chapter.path, "雨落在旧港。钟声已经响过三遍。");
    type AiResult = Awaited<
      ReturnType<WorkbenchRendererContext["aiRuns"]["run"]>
    >;
    let resolveAiRun: ((value: AiResult) => void) | undefined;
    let progressListener:
      | Parameters<WorkbenchRendererContext["aiRuns"]["subscribeProgress"]>[1]
      | undefined;
    const runAi: WorkbenchRendererContext["aiRuns"]["run"] = vi.fn(
      () =>
        new Promise<AiResult>((resolve) => {
          resolveAiRun = resolve;
        }),
    );
    const subscribeProgress: WorkbenchRendererContext["aiRuns"]["subscribeProgress"] =
      vi.fn((_runId, listener) => {
        progressListener = listener;
        return () => undefined;
      });

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          false,
          undefined,
          undefined,
          undefined,
          subscribeProgress,
        )}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    fireEvent.select(editor, {
      target: { selectionStart: 0, selectionEnd: 6 },
    });
    const selectionToolbar = (
      await screen.findByRole("button", { name: "标为伏笔证据" })
    ).closest('[role="toolbar"]');
    expect(selectionToolbar).not.toBeNull();
    fireEvent.click(
      within(selectionToolbar as HTMLElement).getByRole("button", {
        name: "润色",
      }),
    );

    await waitFor(() => expect(runAi).toHaveBeenCalledTimes(1));
    const request = vi.mocked(runAi).mock.calls[0]?.[0];
    expect(request).toMatchObject({
      executionProfile: "standard",
      maxTurns: 1,
      streamOutput: true,
    });
    expect(request).not.toHaveProperty("toolset");
    expect(progressListener).toBeDefined();
    act(() => {
      progressListener?.({
        runId: request?.runId ?? "manuscript-revise-test-run",
        kind: "status",
        message: "正在生成结果",
        partialOutput: "雨丝斜落旧港，",
        revision: 1,
      });
    });
    expect(await screen.findByText("雨丝斜落旧港，")).toBeInTheDocument();

    await act(async () => {
      resolveAiRun?.({ output: "雨丝斜落旧港，钟声穿过长街。" });
    });
    expect(
      await screen.findByRole("dialog", { name: "AI 快速润色结果" }),
    ).toBeInTheDocument();
  });

  it("模型场景页不展示已废弃的正文会话展示方式", async () => {
    const storage = createEmptyNovelStorage();

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "model-scenes", vi.fn())}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "模型场景" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("正文 AI 交互")).not.toBeInTheDocument();
    expect(screen.queryByText("简易协作窗")).not.toBeInTheDocument();
    expect(screen.queryByText("完整 Agent 对话")).not.toBeInTheDocument();
  });

  it("完整生成运行时消费关闭请求并锁定流程导航", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelRepository(storage);
    const project = await repository.load();
    await repository.createChapter(project);
    const resolveRuns: Array<(result: { output: string }) => void> = [];
    const runAi = vi.fn(
      () =>
        new Promise<{ output: string }>((resolve) => {
          resolveRuns.push(resolve);
        }),
    );
    const navigationGuardRef: { current: WorkbenchNavigationGuard | null } = {
      current: null,
    };
    const registerNavigationGuard: WorkbenchRendererContext["registerNavigationGuard"] =
      (guard) => {
        navigationGuardRef.current = guard;
        return () => {
          if (navigationGuardRef.current === guard) {
            navigationGuardRef.current = null;
          }
        };
      };

    render(
      <NovelWorkbenchRenderer
        context={context(
          storage,
          "manuscript",
          vi.fn(),
          undefined,
          runAi,
          true,
          registerNavigationGuard,
        )}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    fireEvent.click(await screen.findByRole("button", { name: "并行生成" }));

    await waitFor(() => expect(runAi).toHaveBeenCalled());
    await waitFor(() => expect(navigationGuardRef.current).not.toBeNull());
    const navigationGuard = navigationGuardRef.current;
    if (!navigationGuard) throw new Error("正文导航守卫未注册");
    const leaveAttempt = navigationGuard.confirmLeave();
    expect(
      await screen.findByRole("heading", { name: "正文任务正在运行" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续等待" }));
    await expect(leaveAttempt).resolves.toBe(false);

    expect(
      within(screen.getByLabelText("生成步骤")).getByRole("button", {
        name: /方案$/u,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "跳过方案与确认" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "进入确认" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步剧情工程" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建目录" })).toBeDisabled();
    expect(screen.getByLabelText("章节标题")).toBeDisabled();
    expect(document.querySelector(".ms-chapter-row")).toHaveAttribute(
      "draggable",
      "false",
    );

    act(() => {
      expect(dismissTopmost()).toBe(true);
    });
    expect(screen.getByText("正文完整生成")).toBeInTheDocument();

    for (const resolve of resolveRuns) resolve({ output: '{"plans":[]}' });
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
          initialMessage: "请开始执行当前小说工作台任务。",
          systemPrompt: expect.stringContaining("资深的世界设计师"),
          toolset: expect.objectContaining({
            id: "novel-world",
            context: expect.objectContaining({ mode: "world" }),
          }),
        }),
      );
    });
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).not.toContain(
      '"title": "测试小说"',
    );
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).toContain(
      "受控写回协议",
    );
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).toContain(
      "novel_world_submit_draft",
    );
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).toContain(
      "【小说总览：所有生成必须遵守】",
    );
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).toContain(
      "题材：悬疑、推理侦探",
    );
  });

  it("uses the人物库 prompt installation and appends the platform protocol", async () => {
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
        context={context(storage, "characters", vi.fn(), openAgentSession)}
      />,
    );

    await screen.findByRole("button", { name: "Agent 设计角色" });
    fireEvent.click(screen.getByRole("button", { name: "Agent 设计角色" }));
    fireEvent.click(screen.getByRole("button", { name: "生成提案" }));

    await waitFor(() => {
      expect(openAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          promptId: "novel.characters.assist",
          systemPrompt: expect.stringContaining("novel_characters_get_context"),
          toolset: expect.objectContaining({
            context: expect.objectContaining({
              promptId: "novel.characters.assist",
              promptVersion: "1.0.0",
            }),
          }),
        }),
      );
    });
    expect(openAgentSession.mock.calls[0]?.[0].systemPrompt).toContain(
      "MyAgents 受控写回协议",
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
    expect(await screen.findByText(/暂无地图/)).toBeInTheDocument();
    // 空间节点树视图保留
    fireEvent.click(screen.getByRole("button", { name: "空间节点树" }));
    expect(await screen.findByText(/尚无空间节点/)).toBeInTheDocument();
  });

  it("从地图生成入口打开 Agent + Azgaar 会话并注入地图工具协议", async () => {
    const storage = createEmptyNovelStorage();
    const mapRepository = await import(
      "./modules/maps/data-access/mapRepository"
    ).then((module) => module.createNovelMapRepository(storage));
    await mapRepository.createMap({
      id: "map-agent",
      name: "九州",
      projectionType: "continent",
    });
    const openAgentSession = vi.fn(
      async (
        _request: Parameters<
          WorkbenchRendererContext["agentSessions"]["open"]
        >[0],
      ) => undefined,
    );

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "map", vi.fn(), openAgentSession)}
      />,
    );

    fireEvent.click(await screen.findByText("九州"));
    fireEvent.click(await screen.findByRole("button", { name: "生成地图" }));
    expect(await screen.findAllByText("Agent + Azgaar")).not.toHaveLength(0);
    const launchButton = screen.getByRole("button", {
      name: "交给 Agent 生成",
    });
    await waitFor(() => expect(launchButton).toBeEnabled());
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(openAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          promptId: "novel.maps.fantasy",
          title: "Agent + 玄幻地图 · 九州",
          initialMessage: "请读取世界架构，按中文玄幻地图规范生成地图提案。",
          toolset: expect.objectContaining({
            id: "novel-world",
            context: expect.objectContaining({
              mode: "maps",
              mapId: "map-agent",
            }),
          }),
          systemPrompt: expect.stringContaining("novel_world_get_context"),
        }),
      );
    });
    const request = openAgentSession.mock.calls[0]?.[0];
    expect(request?.systemPrompt).toContain("novel_maps_generate_fantasy_map");
    expect(request?.systemPrompt).toContain("landmassCount");
    expect(request?.systemPrompt).toContain("azgaarTemplate");
    expect(request?.systemPrompt).toContain("azgaarPrecipitation");
    expect(request?.systemPrompt).toContain("novel_maps_validate_draft");
    expect(request?.systemPrompt).toContain("novel_maps_submit_draft");
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
