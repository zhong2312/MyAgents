import { fireEvent, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderPreviewMock = vi.hoisted(() => vi.fn());

vi.mock("./mapSceneExporter", () => ({
  renderMapDocumentToCanvas: renderPreviewMock,
}));

import { createEmptyMapDocument } from "../entities/mapSchema";
import MapProposalPreview from "./MapProposalPreview";

function createPreviewMap() {
  const base = createEmptyMapDocument({
    id: "proposal-preview",
    name: "九州候选",
    projectionType: "continent",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    ...base,
    canvas: {
      ...base.canvas,
      backgroundPreset: "ocean" as const,
      backgroundImage: "data:image/svg+xml;base64,PHN2Zy8+",
      backgroundImageWidth: 1600,
      backgroundImageHeight: 1000,
    },
    features: [
      {
        id: "feature-coast",
        kind: "polygon" as const,
        name: "主大陆",
        entityRef: null,
        layerId: "layer-main",
        points: [
          { x: 240, y: 180 },
          { x: 820, y: 160 },
          { x: 920, y: 640 },
          { x: 280, y: 700 },
        ],
        timeFrom: null,
        timeTo: null,
        props: {
          fill: "#d8c58f",
          color: "#536b54",
          showLabel: "true",
        },
        description: "",
      },
    ],
    scene: {
      ...base.scene!,
      layers: base.scene!.layers.map((layer) =>
        layer.id === "scene-terrain"
          ? {
              ...layer,
              regions: [
                {
                  id: "region-land",
                  layerId: layer.id,
                  kind: "land" as const,
                  points: [
                    { x: 320, y: 260 },
                    { x: 720, y: 260 },
                    { x: 760, y: 560 },
                    { x: 300, y: 560 },
                  ],
                  fill: "#b8ad7d",
                  texture: "paper-land" as const,
                  opacity: 1,
                  edgeColor: "#655540",
                  edgeWidth: 3,
                },
              ],
            }
          : layer,
      ),
    },
  };
}

describe("MapProposalPreview", () => {
  beforeEach(() => {
    renderPreviewMock.mockReset();
    renderPreviewMock.mockResolvedValue({
      toDataURL: () => "data:image/png;base64,rendered-preview",
    });
  });

  it("优先使用正式 Canvas 渲染器生成候选成图预览", async () => {
    const map = createPreviewMap();
    const { container } = render(<MapProposalPreview map={map} />);

    expect(
      screen.getByRole("region", { name: "地图候选预览：九州候选" }),
    ).toBeInTheDocument();
    expect(screen.getByText("深海")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        container.querySelector('[data-map-proposal-raster="true"]'),
      ).toBeTruthy();
    });
    expect(renderPreviewMock).toHaveBeenCalledWith(map, null, undefined, {
      maxEdge: 960,
    });
  });

  it("Canvas 渲染失败时降级为可读的 SVG 几何预览", async () => {
    const map = createPreviewMap();
    renderPreviewMock.mockRejectedValueOnce(new Error("canvas unavailable"));
    const { container } = render(<MapProposalPreview map={map} />);

    await waitFor(() => expect(container.querySelector("svg")).toBeTruthy());
    expect(screen.getByText("主大陆")).toBeInTheDocument();
  });

  it("SVG 降级预览仍渲染竖排印章标签", async () => {
    const map = createPreviewMap();
    const styled = {
      ...map,
      features: map.features.map((feature) => ({
        ...feature,
        name: "北荒",
        props: {
          ...feature.props,
          labelWritingMode: "vertical",
          labelFrame: "seal",
        },
      })),
    };
    renderPreviewMock.mockRejectedValueOnce(new Error("canvas unavailable"));
    const { container } = render(<MapProposalPreview map={styled} />);

    await waitFor(() =>
      expect(
        container.querySelector('[data-map-label-frame="seal"]'),
      ).toBeTruthy(),
    );
    expect(screen.getByText("北")).toBeInTheDocument();
    expect(screen.getByText("荒")).toBeInTheDocument();
  });

  it("支持滚轮缩放、拖拽平移，并可适配回完整画布", async () => {
    const map = createPreviewMap();
    const { container } = render(<MapProposalPreview map={map} />);
    const viewport = screen.getByRole("region", {
      name: "地图候选预览：九州候选",
    });
    const interactionSurface = viewport.querySelector(
      '[data-map-proposal-viewport="true"]',
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-map-proposal-raster="true"]'),
      ).toBeTruthy(),
    );
    const raster = container.querySelector('[data-map-proposal-raster="true"]');
    expect(raster).toBeTruthy();
    expect(interactionSurface).toBeTruthy();

    fireEvent.wheel(interactionSurface!, {
      deltaY: -120,
      clientX: 120,
      clientY: 80,
    });
    const zoomedStyle = raster?.getAttribute("style") ?? "";
    expect(zoomedStyle).toContain("scale(1.12)");

    Object.assign(interactionSurface as HTMLDivElement, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.pointerDown(interactionSurface!, {
      button: 0,
      pointerId: 7,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerMove(interactionSurface!, {
      pointerId: 7,
      clientX: 55,
      clientY: 70,
    });
    const draggedStyle = raster?.getAttribute("style") ?? "";
    expect(draggedStyle).not.toBe(zoomedStyle);
    expect(draggedStyle).toContain("scale(1.12)");

    fireEvent.click(screen.getByRole("button", { name: "适配候选地图" }));
    expect(raster?.getAttribute("style")).toContain("scale(1)");
    expect(raster?.getAttribute("style")).toContain("translate(0px, 0px)");
  });
});
