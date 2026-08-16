import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../MarkdownVisualEditor", () => ({
  default: ({
    value,
    onChange,
    onSave,
  }: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onSave: () => void;
  }) => (
    <div>
      <textarea
        aria-label="资料编辑器"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" onClick={onSave}>
        保存资料
      </button>
    </div>
  ),
}));

import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import ResearchLibrary from "./ResearchLibrary";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResearchLibrary", () => {
  it("新建资料前先保存当前编辑，避免切换资料时丢失草稿", async () => {
    const storage = new NovelMemoryStorage({
      "research/index.json":
        '{"schemaVersion":1,"sources":[{"id":"source-1","path":"research/notes/考据.md","title":"考据","createdAt":"2026-01-01T00:00:00.000Z"}]}',
      "research/trash/index.json": '{"schemaVersion":1,"items":[]}',
      "research/notes/考据.md": "# 考据\n\n原始资料",
    });
    vi.spyOn(window, "prompt").mockReturnValue("新资料");

    render(
      <ResearchLibrary
        storage={storage}
        projectTitle="测试小说"
        isActive
        registerNavigationGuard={() => () => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "考据" }));
    const editor = await screen.findByRole("textbox", { name: "资料编辑器" });
    fireEvent.change(editor, { target: { value: "# 考据\n\n本地修改" } });
    fireEvent.click(screen.getByRole("button", { name: "新建资料" }));

    await waitFor(() => {
      expect(storage.getText("research/notes/考据.md")).toBe(
        "# 考据\n\n本地修改",
      );
    });
    expect(storage.getText("research/notes/新资料.md")).toContain("# 新资料");
  });

  it("当前资料未变化时仍刷新外部新增的资料", async () => {
    const storage = new NovelMemoryStorage({
      "research/index.json":
        '{"schemaVersion":1,"sources":[{"id":"source-1","path":"research/notes/考据.md","title":"考据","createdAt":"2026-01-01T00:00:00.000Z"}]}',
      "research/trash/index.json": '{"schemaVersion":1,"items":[]}',
      "research/notes/考据.md": "# 考据\n\n原始资料",
    });

    render(
      <ResearchLibrary
        storage={storage}
        projectTitle="测试小说"
        isActive
        registerNavigationGuard={() => () => undefined}
      />,
    );

    await screen.findByRole("button", { name: "考据" });
    storage.setExternalText("research/notes/外部资料.md", "# 外部资料\n\n新增");

    expect(
      await screen.findByRole("button", { name: "外部资料" }),
    ).toBeVisible();
  });
});
