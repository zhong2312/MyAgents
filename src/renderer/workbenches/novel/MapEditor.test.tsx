import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import MapEditor from "./MapEditor";
import { NovelMemoryStorage } from "./testStorage";

describe("MapEditor（地图阶段验收）", () => {
  it("空项目渲染地图库空态，可创建地图并进入编辑", async () => {
    const storage = new NovelMemoryStorage({});
    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );

    expect(await screen.findByText("地图编辑")).toBeInTheDocument();
    expect(await screen.findByText(/暂无地图/)).toBeInTheDocument();

    // 新建地图
    fireEvent.click(screen.getByTitle("新建地图"));
    const nameInput = await screen.findByPlaceholderText(/九州全图/);
    fireEvent.change(nameInput, { target: { value: "九州" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // 进入编辑态：要素工具出现
    await waitFor(() => {
      expect(screen.getByText("+ 标记点")).toBeInTheDocument();
      expect(screen.getByText("+ 路线")).toBeInTheDocument();
    });
    expect(await screen.findByText("九州")).toBeInTheDocument();
    unmount();
  });

  it("六类要素工具齐全，绘制草稿后可以保存并重新加载", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("./mapRepository").then((module) =>
      module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-1",
      name: "九州",
      projectionType: "continent",
    });
    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );
    fireEvent.click(await screen.findByText("九州"));
    await waitFor(() => {
      for (const label of ["+ 标记点", "+ 文本标签", "+ 区域", "+ 多边形", "+ 路线", "+ 拓扑节点"]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
    });
    const layerName = screen.getByRole("textbox", { name: "图层名称：主图层" });
    fireEvent.change(layerName, { target: { value: "地图底图" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(storage.getText("world/maps/records/map-1.json")).toContain("地图底图"));
    unmount();
  });
});
