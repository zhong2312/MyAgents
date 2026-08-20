import { describe, expect, it } from "vitest";

import {
  createInspirationBoardRepository,
  buildStickyFromInspiration,
  parseInspirationBoard,
} from "./inspirationBoard";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";

describe("inspirationBoard", () => {
  it("创建/加载/保存/删除画布（含 expectedContent 冲突保护）", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createInspirationBoardRepository(storage);

    const created = await repository.createBoard("推演板");
    expect(created.board.nodes).toHaveLength(0);

    const loaded = await repository.loadBoard(created.board.id);
    expect(loaded.board.name).toBe("推演板");

    const updated = await repository.saveBoard(loaded, {
      ...loaded.board,
      nodes: [
        {
          id: "node-1",
          kind: "inspiration",
          entityId: "insp-1",
          label: "以剑入道",
          x: 10,
          y: 20,
          width: 220,
          height: 140,
        },
      ],
    });
    expect(updated.board.nodes).toHaveLength(1);

    const index = await repository.loadIndex();
    expect(index.boards).toHaveLength(1);

    // 外部修改冲突
    storage.setExternalText(
      "inspiration/boards/board-1.json",
      storage.getText("inspiration/boards/board-1.json")!,
    );
    await repository.deleteBoard(created.board.id);
    expect(storage.getText("inspiration/boards/board-1.json")).toBeUndefined();
  });

  it("索引写入失败时回滚画布创建和保存", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createInspirationBoardRepository(storage);

    storage.failWritePathOnce = "inspiration/boards/index.json";
    await expect(repository.createBoard("不会留下孤儿文件")).rejects.toThrow(
      "Injected write failure",
    );
    expect(storage.getText("inspiration/boards/index.json")).toContain(
      '"boards": []',
    );

    const created = await repository.createBoard("可回滚保存");
    const loaded = await repository.loadBoard(created.board.id);
    const originalContent = loaded.content;
    storage.failWritePathOnce = "inspiration/boards/index.json";
    await expect(
      repository.saveBoard(loaded, {
        ...loaded.board,
        name: "不应落盘",
      }),
    ).rejects.toThrow("Injected write failure");
    expect((await repository.loadBoard(created.board.id)).content).toBe(
      originalContent,
    );
  });

  it("删除记录失败时保留索引引用", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createInspirationBoardRepository(storage);
    const created = await repository.createBoard("删除保护");

    storage.failRemovePathOnce = `inspiration/boards/${created.board.id}.json`;
    await expect(repository.deleteBoard(created.board.id)).rejects.toThrow(
      "Injected remove failure",
    );
    expect((await repository.loadIndex()).boards).toEqual([
      expect.objectContaining({ id: created.board.id }),
    ]);
    expect(storage.getText(`inspiration/boards/${created.board.id}.json`)).toBe(
      created.content,
    );
  });

  it("画布连线引用不存在节点时被 schema 拒绝", () => {
    expect(() =>
      parseInspirationBoard(
        "x",
        JSON.stringify({
          schemaVersion: 1,
          id: "board-1",
          name: "b",
          nodes: [
            {
              id: "node-1",
              kind: "inspiration",
              entityId: "insp-1",
              label: "l",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "node-1",
              target: "node-missing",
              label: "",
            },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toThrow(/连线引用的节点不存在/);
  });

  it("T18：便签从灵感投影（只存引用与视图状态）", () => {
    const node = buildStickyFromInspiration(
      { id: "insp-1", title: "以剑入道", body: "把剑修与心性结合" },
      { x: 40, y: 60 },
    );
    expect(node).toMatchObject({
      kind: "inspiration",
      entityId: "insp-1",
      label: "以剑入道",
      x: 40,
      y: 60,
    });
  });
});
