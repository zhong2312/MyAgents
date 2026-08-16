import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createEmptyNovelStorage } from "../../../testStorage";
import CharacterLibraryPrototype from "./CharacterLibraryPrototype";

describe("CharacterLibraryPrototype 顶部视图切换", () => {
  it("将人物档案和关系图谱放在独立的居中栏", () => {
    render(
      <CharacterLibraryPrototype
        storage={createEmptyNovelStorage()}
        projectTitle="测试小说"
        isActive={false}
      />,
    );

    const profileButton = screen.getByRole("button", { name: "人物档案" });
    const networkButton = screen.getByRole("button", { name: "关系图谱" });
    const switcher = profileButton.parentElement;
    const header = profileButton.closest("header");

    expect(networkButton.parentElement).toBe(switcher);
    expect(switcher).toHaveClass("justify-self-center");
    expect(header).toHaveClass(
      "grid",
      "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
    expect(
      screen.getByRole("button", { name: "角色灵魂设计" }).parentElement,
    ).not.toBe(switcher);
  });

  it("未进入编辑态时也在编辑按钮旁显示删除按钮", async () => {
    render(
      <CharacterLibraryPrototype
        storage={createEmptyNovelStorage()}
        projectTitle="测试小说"
        isActive
      />,
    );

    await screen.findByText("人物库尚无角色");
    fireEvent.click(screen.getAllByRole("button", { name: "新建角色" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "保存并完成编辑" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "编辑角色" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "删除角色" }),
    ).toBeInTheDocument();
  });
});
