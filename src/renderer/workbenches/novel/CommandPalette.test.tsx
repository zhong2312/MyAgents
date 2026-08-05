import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import CommandPalette from "./CommandPalette";
import { buildDomainIndex, type DomainIndex } from "./domainIndex";
import { NovelMemoryStorage } from "./testStorage";

function storageWithManyEntities(count: number): NovelMemoryStorage {
  const characters = Array.from({ length: count }, (_, index) => ({
    id: `char-${index}`,
    name: `角色${index}`,
    summary: `第 ${index} 号角色的摘要`,
    raceId: null,
    groupIds: [],
    recordPath: `characters/records/char-${index}.json`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return new NovelMemoryStorage({
    "characters/index.json": JSON.stringify({
      schemaVersion: 1,
      characters,
    }),
  });
}

async function indexOf(storage: NovelMemoryStorage): Promise<DomainIndex> {
  return buildDomainIndex(storage);
}

describe("CommandPalette 键盘全流程", () => {
  it("Ctrl+K 打开、上下选择、回车打开实体、Esc 关闭", async () => {
    const storage = storageWithManyEntities(12);
    const index = await indexOf(storage);
    const onOpen = vi.fn();
    const onShowAll = vi.fn();
    const onCreate = vi.fn();
    const { unmount } = render(
      <CommandPalette
        index={index}
        isAvailable={false}
        onOpen={onOpen}
        onShowAll={onShowAll}
        onCreate={onCreate}
      />,
    );

    // 初始未打开
    expect(screen.queryByRole("dialog")).toBeNull();

    // Ctrl+K 打开
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // 输入关键词 → 结果列表
    const input = screen.getByPlaceholderText(/搜索/);
    fireEvent.change(input, { target: { value: "角色5" } });
    await waitFor(() => {
      expect(screen.getByText("角色5")).toBeInTheDocument();
    });

    // ArrowDown + Enter 打开（默认第 0 个结果 = 角色5）
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ id: "char-5", kind: "character" }),
      );
    });

    // Esc 关闭
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    unmount();
  });

  it("空输入时展示快速新建命令并可触发 onCreate", async () => {
    const index = await indexOf(storageWithManyEntities(1));
    const onCreate = vi.fn();
    const { unmount } = render(
      <CommandPalette
        index={index}
        isAvailable={false}
        onOpen={vi.fn()}
        onShowAll={vi.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByText("新建章节")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("新建章节"));
    expect(onCreate).toHaveBeenCalledWith("chapter");
    unmount();
  });
});

describe("领域搜索性能（第一阶段验收：热搜索 100ms）", () => {
  it("200 个实体下关键词搜索在 100ms 内完成", async () => {
    const storage = storageWithManyEntities(200);
    const index = await indexOf(storage);
    const { searchDomainIndex } = await import("./domainIndex");
    const start = performance.now();
    const hits = searchDomainIndex(index, "角色19");
    const elapsed = performance.now() - start;
    expect(hits[0]?.id).toBe("char-19");
    expect(elapsed).toBeLessThan(100);
  });
});
