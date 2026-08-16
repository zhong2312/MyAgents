import { describe, expect, it } from "vitest";

import {
  hitMapArtworkTransformHandle,
  mapArtworkStampPlacementTransform,
  mapArtworkStampRenderSize,
  mapArtworkTransformHandles,
  rotateMapArtworkStampFromPointer,
  scaleMapArtworkStampFromPointer,
} from "./mapArtworkTransform";

describe("mapArtworkTransform", () => {
  const stamp = { x: 200, y: 160, scale: 2, rotation: 0 };

  it("按素材最长边归一化后计算真实成图尺寸", () => {
    const size = mapArtworkStampRenderSize(stamp, {
      width: 190,
      height: 126,
    });

    expect(size.width).toBeCloseTo(300);
    expect(size.height).toBeCloseTo(198.947, 3);
  });

  it("生成随印章旋转的四角与旋转手柄", () => {
    const handles = mapArtworkTransformHandles(
      { ...stamp, rotation: 90 },
      { width: 100, height: 60 },
      1,
    );

    expect(handles[0]!.point.x).toBeCloseTo(230);
    expect(handles[0]!.point.y).toBeCloseTo(110);
    expect(handles.at(-1)!.id).toBe("rotate");
    expect(handles.at(-1)!.point.x).toBeCloseTo(258);
    expect(handles.at(-1)!.point.y).toBeCloseTo(160);
  });

  it("以屏幕像素半径命中变换手柄", () => {
    const handles = mapArtworkTransformHandles(
      stamp,
      { width: 100, height: 60 },
      2,
    );

    expect(
      hitMapArtworkTransformHandle(
        { x: handles[0]!.point.x + 4, y: handles[0]!.point.y },
        handles,
        2,
      ),
    ).toBe("scale-north-west");
    expect(
      hitMapArtworkTransformHandle({ x: 200, y: 160 }, handles, 2),
    ).toBeNull();
  });

  it("根据中心距离等比缩放并限制到 schema 范围", () => {
    expect(
      scaleMapArtworkStampFromPointer(
        stamp,
        { x: 250, y: 160 },
        { x: 300, y: 160 },
      ),
    ).toBe(4);
    expect(
      scaleMapArtworkStampFromPointer(
        stamp,
        { x: 250, y: 160 },
        { x: 2_000, y: 160 },
      ),
    ).toBe(20);
  });

  it("把拖出印章的距离、中心和方向转换为成品变换", () => {
    const placed = mapArtworkStampPlacementTransform({
      anchor: { x: 999, y: 999 },
      defaultScale: 1,
      variant: { width: 150, height: 100 },
      gesture: {
        start: { x: 100, y: 200 },
        end: { x: 400, y: 200 },
      },
    });

    expect(placed).toMatchObject({
      x: 250,
      y: 200,
      scale: 2,
      rotation: 0,
    });
  });

  it("点击或极短拖动保持默认印章尺寸", () => {
    const placed = mapArtworkStampPlacementTransform({
      anchor: { x: 240, y: 180 },
      defaultScale: 1.5,
      variant: { width: 120, height: 90 },
      gesture: {
        start: { x: 240, y: 180 },
        end: { x: 245, y: 180 },
      },
    });

    expect(placed).toEqual({
      x: 240,
      y: 180,
      scale: 1.5,
      rotation: 0,
    });
  });

  it("根据指针绕中心的夹角旋转并归一化角度", () => {
    expect(
      rotateMapArtworkStampFromPointer(
        { ...stamp, rotation: 170 },
        { x: 250, y: 160 },
        { x: 200, y: 210 },
      ),
    ).toBe(-100);
  });
});
