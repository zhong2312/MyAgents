import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import NovelProjectCreator from "./NovelProjectCreator";

describe("NovelProjectCreator", () => {
  it("submits multiple genres, target words and the shared project layout", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);

    render(
      <NovelProjectCreator
        defaultParentPath={"F:\\Novels"}
        onPickDirectory={vi.fn().mockResolvedValue(null)}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("小说名称"), {
      target: { value: "长夜:行" },
    });
    expect(screen.queryByText("初始结构")).not.toBeInTheDocument();
    expect(screen.queryByText("初始化 Git")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "题材" }));
    const listbox = screen.getByRole("listbox", { name: "题材" });
    const form = screen
      .getByRole("button", { name: "创建并打开" })
      .closest("form");
    expect(form).not.toContainElement(listbox);
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");

    fireEvent.click(screen.getByRole("option", { name: "东方玄幻" }));
    fireEvent.click(screen.getByRole("option", { name: "悬疑" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    fireEvent.change(screen.getByLabelText("目标字数"), {
      target: { value: "50.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并打开" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: "F:\\Novels\\长夜-行",
          displayName: "长夜:行",
          icon: "📖",
          route: "overview",
          initialization: expect.objectContaining({
            version: 1,
            initializeGit: false,
          }),
        }),
      );
    });

    const request = onCreate.mock.calls[0]?.[0];
    const novelMetadata = request.initialization.files.find(
      (file: { path: string }) => file.path === "novel.json",
    );
    const parsedMetadata = JSON.parse(novelMetadata.content);
    expect(parsedMetadata).toMatchObject({
      title: "长夜:行",
      genres: ["玄幻", "东方玄幻", "悬疑"],
      targetWordCount: 505_000,
      workbenchId: "io.myagents.novel",
    });
    expect(parsedMetadata).not.toHaveProperty("genre");
    expect(parsedMetadata).not.toHaveProperty("form");
  });
});
