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

vi.mock("@/hooks/useAvailableProviders", () => ({
  useAvailableProviders: () => [],
}));

import type {
  WorkbenchNavigationGuard,
  WorkbenchRendererContext,
} from "@/workbench-sdk";
import { dismissTopmost } from "@/utils/closeLayer";

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
  runAi: WorkbenchRendererContext["aiRuns"]["run"] | null = null,
  agentSessionsAvailable = true,
  registerNavigationGuard: WorkbenchRendererContext["registerNavigationGuard"] = () =>
    () => undefined,
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
      subscribeProgress: () => () => undefined,
    },
    search,
    projection: new NovelMemoryProjection([], [], false),
    navigate,
    registerNavigationGuard,
  };
}

describe("NovelWorkbenchRenderer storage loop", () => {
  it("在新的世界推演菜单下保留控制台、实验室和立场会商入口", () => {
    const navigation = novelWorkbenchDefinition.manifest.navigation;
    expect(navigation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "simulation", label: "世界推演" }),
        expect.objectContaining({
          id: "simulation-console",
          label: "运行控制台",
          parentId: "simulation",
        }),
        expect.objectContaining({
          id: "simulation-lab",
          label: "世界实验室",
          parentId: "simulation",
        }),
        expect.objectContaining({
          id: "simulation-council",
          label: "立场会商",
          parentId: "simulation",
        }),
      ]),
    );
    expect(
      navigation.find((item) => item.id === "simulation")?.parentId,
    ).toBeUndefined();
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
      expect(
        screen.queryByRole("button", { name: "改用自定义起点" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(
          "时间线事件不会自动成为事实。当前使用自定义起点，推演不会把任何时间线事件当作既成事实。",
        ),
      ).toBeInTheDocument();
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
        context={context(storage, "manuscript", vi.fn())}
      />,
    );

    const titleInput = await screen.findByLabelText("章节标题");
    fireEvent.change(titleInput, { target: { value: "等待写入的章节标题" } });
    fireEvent.blur(titleInput);
    await waitFor(() => {
      expect(
        screen.getByTitle("从光标处续写"),
      ).toBeDisabled();
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
        context={context(storage, "manuscript", vi.fn())}
      />,
    );

    fireEvent.change(await screen.findByLabelText("章节正文"), {
      target: { value: "等待保存的新正文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
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
    await waitFor(() => {
      const index = storage.getText("manuscript/index.json") ?? "";
      expect(index).toContain('"status": "complete"');
      expect(index).toContain('"trackingStatus": "synced"');
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
        context={
          context(
            storage,
            "manuscript",
            vi.fn(),
            undefined,
            runAi,
            true,
            registerNavigationGuard,
          )
        }
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

    fireEvent.click(await screen.findByRole("button", { name: "检查正文质量" }));
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
      await screen.findByText("磁盘正文在质量审查期间发生变化，旧结果已丢弃，请重新检查"),
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

    fireEvent.click(
      await screen.findByTitle("润色选区；无选区时处理全文"),
    );
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

    fireEvent.click(
      await screen.findByTitle("润色选区；无选区时处理全文"),
    );
    expect(
      await screen.findByRole("dialog", { name: "润色候选" }),
    ).toBeInTheDocument();
    storage.setExternalText(chapter.path, "外部编辑器改写后的正文。");

    expect(
      await screen.findByText(/磁盘正文已变化，本地草稿未被覆盖/),
    ).toBeInTheDocument();
    const reloadButton = screen.getByRole("button", { name: "载入磁盘版本" });
    expect(reloadButton).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "润色候选" })).toBeInTheDocument();
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

  it("完整生成建立 Agent 审阅会话后锁定输入步骤且不并行即时生成", async () => {
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

    render(
      <NovelWorkbenchRenderer
        context={context(storage, "manuscript", vi.fn(), openAgentSession)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "完整生成" }));
    fireEvent.click(
      within(await screen.findByLabelText("生成步骤")).getByRole("button", {
        name: /生成$/u,
      }),
    );

    await waitFor(() => expect(openAgentSession).toHaveBeenCalledTimes(1));
    expect(
      within(screen.getByLabelText("生成步骤")).getByRole("button", {
        name: /方案$/u,
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "开始生成正文" }),
    ).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "跳过方案与确认" })).toBeDisabled();
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
          title: "Agent + Azgaar · 九州",
          initialMessage: "请按协议读取世界架构并生成地图提案。",
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
