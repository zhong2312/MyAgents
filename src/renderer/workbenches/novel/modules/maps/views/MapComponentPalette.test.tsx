import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import MapComponentPalette from "./MapComponentPalette";
import { MAP_COMPONENT_DRAG_MIME } from "../business/mapComponents";
import type { MapArtworkStampAsset } from "../business/mapArtwork";

const PROJECT_ARTWORK: MapArtworkStampAsset = {
  id: "asset-pine-pack",
  name: "松林素材",
  symbol: "松",
  color: "#42744f",
  imageSrc: "data:image/png;base64,iVBORw==",
  width: 128,
  height: 64,
  variants: [
    {
      index: 0,
      imageSrc: "data:image/png;base64,iVBORw==",
      width: 128,
      height: 64,
      cacheKey: "project:asset-pine-pack",
    },
  ],
  brush: true,
  brushFollowsPath: false,
};

describe("地图构件库", () => {
  it("按分类展示现成构件，点击插入并支持拖拽", () => {
    const onInsert = vi.fn();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
      types: [MAP_COMPONENT_DRAG_MIME],
    };
    render(<MapComponentPalette disabled={false} onInsert={onInsert} />);

    fireEvent.click(screen.getByRole("button", { name: "文明道路" }));
    const cityButton = screen.getByRole("button", { name: "放置城市" });
    fireEvent.click(cityButton);
    fireEvent.dragStart(cityButton, { dataTransfer });

    expect(onInsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "city", drawKind: "marker" }),
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      MAP_COMPONENT_DRAG_MIME,
      "city",
    );
  });

  it("素材库按四类交互筛选，并让山脉脊线进入连续素材笔刷", () => {
    const onBrush = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        onBrush={onBrush}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "山川地貌" }));
    fireEvent.click(screen.getByRole("tab", { name: "筛选素材笔刷" }));

    expect(
      screen.getByRole("button", { name: "使用山脉脊线笔刷" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "放置火山" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "使用山脉脊线笔刷" }));
    expect(onBrush).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mountain-range", interaction: "scatter" }),
    );
  });

  it("大陆与水域预设按轮廓放置，不进入连续表面笔刷", () => {
    const onInsert = vi.fn();
    const onBrush = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={onInsert}
        onBrush={onBrush}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "大陆板块" }));
    fireEvent.click(screen.getByRole("button", { name: "放置群岛" }));
    fireEvent.click(screen.getByRole("button", { name: "河流水系" }));
    fireEvent.click(screen.getByRole("button", { name: "放置内海" }));

    expect(onInsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "archipelago",
        terrainPrefab: expect.objectContaining({ kind: "land" }),
      }),
    );
    expect(onInsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "inland-sea", placement: "terrain-prefab" }),
    );
    expect(onBrush).not.toHaveBeenCalled();
  });

  it("点击可连续绘制的地貌主卡直接进入笔刷，不再默认插入单个印章", () => {
    const onInsert = vi.fn();
    const onBrush = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={onInsert}
        onBrush={onBrush}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "植被生态" }));
    fireEvent.click(screen.getByRole("button", { name: "使用森林笔刷" }));

    expect(onBrush).toHaveBeenCalledWith(
      expect.objectContaining({ id: "forest" }),
    );
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("新增断崖和珊瑚礁主卡也直接进入连续笔刷", () => {
    const onBrush = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        onBrush={onBrush}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "山川地貌" }));
    fireEvent.click(screen.getByRole("button", { name: "使用断崖笔刷" }));
    fireEvent.click(screen.getByRole("button", { name: "河流水系" }));
    fireEvent.click(screen.getByRole("button", { name: "使用珊瑚礁笔刷" }));

    expect(onBrush).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "cliff" }),
    );
    expect(onBrush).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "coral-reef" }),
    );
  });

  it("路径构件主卡直接进入路径笔刷，拖入画布仍保留预制件落图", () => {
    const onInsert = vi.fn();
    const onBrush = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={onInsert}
        onBrush={onBrush}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "河流水系" }));
    const riverBrush = screen.getByRole("button", { name: "使用河流笔刷" });
    fireEvent.click(riverBrush);

    expect(onBrush).toHaveBeenCalledWith(
      expect.objectContaining({ id: "river", interaction: "path" }),
    );
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("可拾取素材后交给画布进入落图模式", () => {
    const onPick = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        onPick={onPick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "植被生态" }));
    fireEvent.click(screen.getByRole("button", { name: "拾取森林" }));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "forest" }),
    );
  });

  it("点击地貌色样后直接进入材质笔刷", () => {
    const onTerrainMaterial = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        onTerrainMaterial={onTerrainMaterial}
      />,
    );

    const desertButton = screen.getByRole("button", {
      name: "使用荒漠材质笔刷",
    });
    const preview = desertButton.querySelector('[aria-hidden="true"]');

    expect(preview).not.toBeNull();
    expect((preview as HTMLElement).style.backgroundImage).toContain(
      "repeating-radial-gradient",
    );

    fireEvent.click(desertButton);

    expect(onTerrainMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ id: "desert", color: "#c9a865" }),
    );
  });

  it("沙滩材质作为可连续绘制的地形材质提供给画布", () => {
    const onTerrainMaterial = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        onTerrainMaterial={onTerrainMaterial}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用沙滩材质笔刷" }));

    expect(onTerrainMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ id: "beach", name: "沙滩" }),
    );
  });

  it("展示项目素材使用次数，并阻止删除仍被地图引用的素材", () => {
    const onRemove = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        projectArtworkAssets={[PROJECT_ARTWORK]}
        projectArtworkUsage={
          new Map([
            [PROJECT_ARTWORK.id, { stamps: 2, brushStrokes: 3, total: 5 }],
          ])
        }
        onRemoveProjectArtwork={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目素材" }));

    expect(screen.getByText("2 印章 · 3 笔触")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除松林素材" })).toBeDisabled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("为未使用项目素材提供重命名和移除入口", () => {
    const onRename = vi.fn();
    const onRemove = vi.fn();
    render(
      <MapComponentPalette
        disabled={false}
        onInsert={vi.fn()}
        projectArtworkAssets={[PROJECT_ARTWORK]}
        onRenameProjectArtwork={onRename}
        onRemoveProjectArtwork={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目素材" }));
    fireEvent.click(screen.getByRole("button", { name: "重命名松林素材" }));
    fireEvent.change(screen.getByRole("textbox", { name: "重命名松林素材" }), {
      target: { value: "北境松林" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认重命名" }));
    fireEvent.click(screen.getByRole("button", { name: "移除松林素材" }));

    expect(onRename).toHaveBeenCalledWith(PROJECT_ARTWORK.id, "北境松林");
    expect(onRemove).toHaveBeenCalledWith(PROJECT_ARTWORK.id);
  });
});
