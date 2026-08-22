import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import MapEditor from "./MapEditor";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { MAP_COMPONENT_DRAG_MIME } from "../business/mapComponents";
import { createMapProjectArtworkAsset } from "../business/mapProjectArtwork";
import { serializeMapDocument } from "../entities/mapSchema";

function fireMapPointer(
  canvas: HTMLCanvasElement,
  type: "pointerdown" | "pointerup",
  input: {
    readonly clientX: number;
    readonly clientY: number;
    readonly pointerId: number;
    readonly shiftKey?: boolean;
  },
) {
  const event =
    type === "pointerdown"
      ? createEvent.pointerDown(canvas, {
          button: 0,
          buttons: 1,
          clientX: input.clientX,
          clientY: input.clientY,
          shiftKey: input.shiftKey ?? false,
        })
      : createEvent.pointerUp(canvas, {
          button: 0,
          buttons: 0,
          clientX: input.clientX,
          clientY: input.clientY,
          shiftKey: input.shiftKey ?? false,
        });
  Object.defineProperty(event, "pointerId", { value: input.pointerId });
  fireEvent(canvas, event);
}

describe("MapEditor（地图阶段验收）", () => {
  it("中文玄幻风格转换会预览并创建独立副本，原图保持不变", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-fantasy-conversion-source",
      name: "苍穹九州",
      projectionType: "continent",
    });
    const source = await repository.saveMap(created, {
      ...created.map,
      features: [
        {
          id: "conversion-cloud-city",
          kind: "marker",
          name: "云中城",
          entityRef: { kind: "location", id: "cloud-city" },
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: { terrain: "city" },
          description: "旧城设定",
        },
        {
          id: "conversion-spirit-vein",
          kind: "route",
          name: "玄霄灵脉",
          entityRef: { kind: "faction", id: "xuanxiao-sect" },
          layerId: "layer-main",
          points: [
            { x: 320, y: 240 },
            { x: 720, y: 560 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { routeStyle: "ley-line", terrain: "spirit-vein" },
          description: "连接两地的灵脉",
        },
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("苍穹九州"));
    fireEvent.click(
      await screen.findByTitle("保留当前地图几何，创建中文玄幻风格副本"),
    );

    expect(
      await screen.findByRole("dialog", { name: "中文玄幻风格转换预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("转换副本 · 保留几何与实体引用"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建风格副本" }));

    await waitFor(async () => {
      const index = await repository.loadIndex();
      expect(index.index.maps).toHaveLength(2);
    });

    const index = await repository.loadIndex();
    const copyEntry = index.index.maps.find(
      (entry) => entry.id !== source.map.id,
    );
    expect(copyEntry).toMatchObject({ name: "苍穹九州 · 中文玄幻风格" });

    const [reloadedSource, copy] = await Promise.all([
      repository.loadMap(source.map.id),
      repository.loadMap(copyEntry!.id),
    ]);
    expect(reloadedSource.map).toEqual(source.map);
    expect(copy.map.canvas).toMatchObject({
      backgroundPreset: "parchment",
      backgroundColor: "#d8c49a",
    });
    expect(
      copy.map.features.map((feature) => ({
        points: feature.points,
        entityRef: feature.entityRef,
      })),
    ).toEqual(
      source.map.features.map((feature) => ({
        points: feature.points,
        entityRef: feature.entityRef,
      })),
    );
    expect(
      copy.map.features.every(
        (feature) => feature.props.generator === "fantasy-style-conversion",
      ),
    ).toBe(true);
  });

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
      expect(screen.getByText("+ 标记")).toBeInTheDocument();
      expect(screen.getByText("+ 路线")).toBeInTheDocument();
    });
    expect(await screen.findByText("九州")).toBeInTheDocument();
    unmount();
  });

  it("空海域不会允许落下不可见的地貌材质，绘制陆地后才可使用", async () => {
    const storage = new NovelMemoryStorage({});
    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );

    fireEvent.click(screen.getByTitle("新建地图"));
    fireEvent.change(await screen.findByPlaceholderText(/九州全图/), {
      target: { value: "材质约束" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const materialButton = await screen.findByRole("button", {
      name: "使用荒漠材质笔刷",
    });
    expect(materialButton).toBeDisabled();

    const canvas = (await screen.findByLabelText(
      "地图绘图层",
    )) as HTMLCanvasElement;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_600,
        bottom: 1_000,
        width: 1_600,
        height: 1_000,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "绘制陆地" }));
    fireMapPointer(canvas, "pointerdown", {
      clientX: 420,
      clientY: 280,
      pointerId: 41,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 420,
      clientY: 280,
      pointerId: 41,
    });

    await waitFor(() => expect(materialButton).toBeEnabled());
    unmount();
  });

  it("水域笔刷与水域材质分别遵循各自的写入图层", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-water-layer-permission",
      name: "水域权限",
      projectionType: "continent",
    });
    const map = created.map;
    storage.setExternalText(
      "world/maps/records/map-water-layer-permission.json",
      `${JSON.stringify({
        ...map,
        scene: {
          ...map.scene,
          layers: map.scene?.layers.map((layer) =>
            layer.id === "scene-terrain"
              ? { ...layer, locked: false }
              : layer.id === "scene-water"
                ? {
                    ...layer,
                    locked: true,
                    regions: [
                      ...layer.regions,
                      {
                        id: "water-layer-fixture",
                        layerId: "scene-water",
                        kind: "water",
                        points: [
                          { x: 180, y: 160 },
                          { x: 420, y: 160 },
                          { x: 420, y: 360 },
                          { x: 180, y: 360 },
                        ],
                        fill: "#5d92a5",
                        texture: "water-ripple",
                        opacity: 1,
                        edgeColor: "#2f6377",
                        edgeWidth: 2,
                      },
                    ],
                  }
                : layer,
          ),
        },
      })}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("水域权限"));
    await screen.findByLabelText("地图设计画布");

    expect(screen.getByRole("button", { name: "绘制水域" })).toBeEnabled();
    expect(
      await screen.findByRole("button", { name: "使用浅海材质笔刷" }),
    ).toBeDisabled();
  });

  it("橡皮擦始终明确指向当前选择的绘图层", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-scene-eraser-layer",
      name: "分层橡皮",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("分层橡皮"));

    expect(
      await screen.findByRole("button", {
        name: "擦除当前绘图层：地形笔触",
      }),
    ).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "选择绘图层：植被笔触" }),
    );

    expect(
      screen.getByRole("button", {
        name: "擦除当前绘图层：植被笔触",
      }),
    ).toBeEnabled();
  });

  it("打开历史越界内容时自动补齐画布尺寸", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-loaded-bounds",
      name: "越界地图",
      projectionType: "continent",
    });
    const legacyMap = {
      ...created.map,
      features: [
        {
          id: "feature-loaded-edge",
          kind: "marker",
          name: "边境城",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 2_200, y: 1_500 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    };
    // 直接写入历史记录，模拟仓储契约收紧前已经存在的越界地图。
    // 不能通过 saveMap 构造该状态，因为正式仓储现在会在保存边界统一修复。
    storage.setExternalText(
      "world/maps/records/map-loaded-bounds.json",
      `${JSON.stringify(legacyMap)}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("越界地图"));

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（2366 × 1666）"),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("打开旧版默认尺寸的手工地图时按内容收束画布", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-loaded-manual-content-bounds",
      name: "旧版手工群岛",
      projectionType: "continent",
    });
    const legacyMap = {
      ...created.map,
      scene: {
        ...created.map.scene!,
        layers: created.map.scene!.layers.map((layer) =>
          layer.id === "scene-terrain"
            ? {
                ...layer,
                regions: [
                  {
                    id: "legacy-manual-island",
                    layerId: layer.id,
                    kind: "land" as const,
                    points: [
                      { x: 280, y: 180 },
                      { x: 460, y: 200 },
                      { x: 390, y: 330 },
                    ],
                    fill: "#b8ad7d",
                    texture: "paper-land" as const,
                    opacity: 1,
                    edgeColor: "#655540",
                    edgeWidth: 4,
                  },
                ],
              }
            : layer,
        ),
      },
    };
    storage.setExternalText(
      "world/maps/records/map-loaded-manual-content-bounds.json",
      `${JSON.stringify(legacyMap)}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("旧版手工群岛"));

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（504 × 474）"),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("首次内容完全越出初始画布时立即向对应方向扩展", async () => {
    const storage = new NovelMemoryStorage({});
    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );

    fireEvent.click(screen.getByTitle("新建地图"));
    const nameInput = await screen.findByPlaceholderText(/九州全图/);
    fireEvent.change(nameInput, { target: { value: "越界绘制" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const canvas = (await screen.findByLabelText(
      "地图绘图层",
    )) as HTMLCanvasElement;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_600,
        bottom: 1_000,
        width: 1_600,
        height: 1_000,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "绘制标记" }));
    fireMapPointer(canvas, "pointerdown", {
      clientX: 2_200,
      clientY: 1_500,
      pointerId: 11,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 2_200,
      clientY: 1_500,
      pointerId: 11,
    });

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（2366 × 1666）"),
      ).toBeInTheDocument();
    });
    unmount();
  });

  it("首次内容完全越出左上范围时扩展尺寸并保持世界坐标", async () => {
    const storage = new NovelMemoryStorage({});
    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );

    fireEvent.click(screen.getByTitle("新建地图"));
    const nameInput = await screen.findByPlaceholderText(/九州全图/);
    fireEvent.change(nameInput, { target: { value: "左上越界绘制" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const canvas = (await screen.findByLabelText(
      "地图绘图层",
    )) as HTMLCanvasElement;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_600,
        bottom: 1_000,
        width: 1_600,
        height: 1_000,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireEvent.click(screen.getByRole("button", { name: "绘制标记" }));
    fireMapPointer(canvas, "pointerdown", {
      clientX: -200,
      clientY: -100,
      pointerId: 12,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: -200,
      clientY: -100,
      pointerId: 12,
    });

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（1966 × 1266）"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("撤销（Ctrl+Z）"));
    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（1600 × 1000）"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle("重做（Ctrl+Shift+Z / Ctrl+Y）"));
    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（1966 × 1266）"),
      ).toBeInTheDocument();
    });
    unmount();
  });

  it("底图移出左边界时自动扩展画布并同步保存世界坐标", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-background-bounds",
      name: "底图边界",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      canvas: {
        ...created.map.canvas,
        backgroundImage: "data:image/png;base64,placeholder",
        backgroundImageWidth: 800,
        backgroundImageHeight: 500,
        backgroundImagePlacement: {
          x: 320,
          y: 180,
          width: 800,
          height: 500,
        },
      },
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("底图边界"));

    const xInput = await screen.findByLabelText("底图横坐标");
    fireEvent.change(xInput, { target: { value: "-80" } });

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（1840 × 1000）"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-background-bounds.json") ??
          "{}",
      ) as {
        canvas?: {
          width?: number;
          height?: number;
          backgroundImagePlacement?: {
            x?: number;
            y?: number;
            width?: number;
            height?: number;
            source?: "automatic" | "author";
          };
        };
      };
      expect(saved.canvas).toMatchObject({ width: 1840, height: 1000 });
      expect(saved.canvas?.backgroundImagePlacement).toEqual({
        x: 160,
        y: 180,
        width: 800,
        height: 500,
        source: "author",
      });
    });
  });

  it("生成器自动对齐底图被手动变换后，才纳入画布边界", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-generated-background-bounds",
      name: "生成底图边界",
      projectionType: "continent",
    });
    storage.setExternalText(
      "world/maps/records/map-generated-background-bounds.json",
      `${JSON.stringify({
        ...created.map,
        canvas: {
          ...created.map.canvas,
          width: 1_700,
          backgroundImage: "data:image/svg+xml;base64,generated",
          backgroundImageWidth: 800,
          backgroundImageHeight: 500,
          backgroundImagePlacement: {
            x: 320,
            y: 180,
            width: 800,
            height: 500,
            source: "automatic",
          },
        },
        features: [
          {
            id: "generated-anchor",
            kind: "marker",
            name: "生成锚点",
            entityRef: null,
            layerId: "layer-main",
            points: [{ x: 500, y: 360 }],
            timeFrom: null,
            timeTo: null,
            props: { generator: "azgaar-runtime" },
            description: "",
          },
        ],
      })}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("生成底图边界"));

    fireEvent.change(await screen.findByLabelText("底图横坐标"), {
      target: { value: "-80" },
    });

    await waitFor(() => {
      expect(
        screen.getByTitle("导出高清 PNG（1940 × 1000）"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText(
          "world/maps/records/map-generated-background-bounds.json",
        ) ?? "{}",
      ) as {
        canvas?: {
          width?: number;
          backgroundImagePlacement?: { x?: number; source?: string };
        };
      };
      expect(saved.canvas).toMatchObject({ width: 1940 });
      expect(saved.canvas?.backgroundImagePlacement).toEqual(
        expect.objectContaining({ x: 160, source: "author" }),
      );
    });
  });

  it("锁定图层中的要素仍可查看，但删除键和检查器删除不会改写地图", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-locked-feature",
      name: "锁定地图",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      layers: created.map.layers.map((layer) =>
        layer.id === "layer-main" ? { ...layer, locked: true } : layer,
      ),
      features: [
        {
          id: "feature-locked",
          kind: "marker",
          name: "锁定地点",
          entityRef: null,
          layerId: "layer-main",
          points: [{ x: 320, y: 240 }],
          timeFrom: null,
          timeTo: null,
          props: {},
          description: "",
        },
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("锁定地图"));
    const featureButton = (
      await screen.findAllByRole("button", {
        name: /锁定地点/,
      })
    )[0]!;
    fireEvent.click(featureButton);
    fireEvent.keyDown(window, { key: "Delete" });

    expect(screen.getByText("锁定地点")).toBeInTheDocument();
    expect(
      screen.getByText("当前绘图层已隐藏或锁定。无法删除地图要素。"),
    ).toBeInTheDocument();

    const deleteButton = screen.getByRole("button", { name: "删除要素" });
    fireEvent.click(deleteButton);
    expect(screen.getByText("锁定地点")).toBeInTheDocument();
  });

  it("地图要素工具使用标记、标签和画笔入口，绘制草稿后可以保存并重新加载", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
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
      for (const label of ["+ 标记", "+ 标签", "+ 路线"]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.queryByText("+ 自由")).not.toBeInTheDocument();
      expect(screen.queryByText("+ 拓扑节点")).not.toBeInTheDocument();
      expect(screen.queryByText("+ 多边形")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "绘制陆地" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "绘制水域" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "勾画陆地区域" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "勾画水域区域" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /保存/ })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "放大地图" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "缩小地图" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "适配画布" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "移动" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "河流画笔" }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "自由" })).toHaveLength(
        1,
      );
      expect(screen.getByLabelText("地图构件库")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "画布背景" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "自由" }));
    fireEvent.click(screen.getByRole("button", { name: "画笔形状" }));
    expect(screen.getByRole("button", { name: "闭合" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "多边形" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "圆形" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "椭圆" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "自由" })).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "画笔形状" }).parentElement,
    ).toHaveClass("w-32");
    fireEvent.click(screen.getByRole("button", { name: "多边形" }));
    expect(screen.getByRole("button", { name: "画笔形状" })).toHaveTextContent(
      "多边形",
    );
    fireEvent.click(screen.getByRole("button", { name: "画笔形状" }));
    fireEvent.click(screen.getByRole("button", { name: "椭圆" }));
    expect(screen.getByRole("button", { name: "画笔形状" })).toHaveTextContent(
      "椭圆",
    );
    fireEvent.click(screen.getByRole("button", { name: "画笔形状" }));
    const freehandOptions = screen.getAllByRole("button", {
      name: "自由",
    });
    fireEvent.click(freehandOptions.at(-1)!);
    expect(screen.getByRole("button", { name: "画笔形状" })).toHaveTextContent(
      "自由",
    );
    expect(screen.getByRole("button", { name: "自由" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "画布背景" }));
    fireEvent.click(await screen.findByRole("button", { name: "宇宙星空" }));
    fireEvent.click(
      screen.getByRole("button", { name: "上移绘图层：植被笔触" }),
    );
    const layerName = screen.getByRole("textbox", { name: "图层名称：主图层" });
    fireEvent.change(layerName, { target: { value: "地图底图" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(storage.getText("world/maps/records/map-1.json")).toContain(
        "地图底图",
      ),
    );
    const saved = storage.getText("world/maps/records/map-1.json");
    expect(saved).toContain('"backgroundPreset": "starfield"');
    expect(
      (
        JSON.parse(saved ?? "{}") as {
          scene?: { layers?: Array<{ id: string }> };
        }
      ).scene?.layers?.map((layer) => layer.id),
    ).toEqual([
      "scene-terrain",
      "scene-water",
      "scene-relief",
      "scene-civilization",
      "scene-vegetation",
      "scene-labels",
      "scene-effects",
    ]);
    unmount();
  });

  it("点击路线构件后拖动落点即可创建带预设样式的成品路线", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-prefab",
      name: "九州",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("九州"));
    await waitFor(() =>
      expect(screen.getByLabelText("地图构件库")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "河流水系" }));
    fireEvent.click(screen.getByRole("button", { name: "使用河流笔刷" }));

    expect(await screen.findAllByText("预制件 · 河流")).not.toHaveLength(0);
    expect(screen.queryByDisplayValue("未命名河流")).not.toBeInTheDocument();

    const canvas = (await screen.findByLabelText(
      "地图绘图层",
    )) as HTMLCanvasElement;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1_600,
        bottom: 1_000,
        width: 1_600,
        height: 1_000,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    fireMapPointer(canvas, "pointerdown", {
      clientX: 460,
      clientY: 300,
      pointerId: 1,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 760,
      clientY: 520,
      pointerId: 1,
    });

    expect(await screen.findByDisplayValue("未命名河流")).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "河流源头宽度" }),
    ).toHaveValue(2);
    const mouthWidth = screen.getByRole("spinbutton", {
      name: "河流河口宽度",
    });
    expect(mouthWidth).toHaveValue(10);
    fireEvent.change(mouthWidth, { target: { value: "14" } });
    expect(mouthWidth).toHaveValue(14);
    fireEvent.click(screen.getByRole("button", { name: "反转源头与河口" }));
    expect(screen.getByRole("button", { name: "选择" })).toHaveClass(
      "bg-[var(--ink)]",
    );
  });

  it("河流标签可以套用地图样式并编辑排版参数", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-labels",
      name: "北境水系",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      features: [
        {
          id: "feature-river-label",
          kind: "route",
          name: "霜落河",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 240, y: 180 },
            { x: 520, y: 420 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { terrain: "river", showLabel: "true" },
          description: "",
        },
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("北境水系"));
    const search = await screen.findByLabelText("搜索地图要素");
    fireEvent.change(search, { target: { value: "霜落河" } });
    fireEvent.click(await screen.findByText("霜落河"));

    expect(screen.getByText("标签排版")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "标签字号" })).toHaveValue(
      16,
    );
    expect(screen.getByLabelText("沿路线方向")).toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: "应用区域标题标签样式" }),
    );
    expect(screen.getByRole("spinbutton", { name: "标签字号" })).toHaveValue(
      28,
    );
    expect(screen.getByLabelText("沿路线方向")).not.toBeChecked();
    fireEvent.change(screen.getByRole("spinbutton", { name: "标签旋转角度" }), {
      target: { value: "32" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "标签描边宽度" }), {
      target: { value: "6" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = storage.getText("world/maps/records/map-labels.json");
      expect(saved).toContain('"labelSize": "28"');
      expect(saved).toContain('"labelRotation": "32"');
      expect(saved).toContain('"labelHaloWidth": "6"');
    });
  });

  it("画笔区域可以编辑填充颜色和透明度，并保存为 MapDocument 样式事实", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-area-style",
      name: "边境分区",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      features: [
        {
          id: "feature-borderland-area",
          kind: "area",
          name: "北境领地",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 180, y: 180 },
            { x: 620, y: 210 },
            { x: 470, y: 540 },
          ],
          timeFrom: null,
          timeTo: null,
          // 旧地图的带 alpha 填充色进入检查器后仍应被完整还原。
          props: { fill: "#b26d4540", color: "#8b6b4a", lineWidth: "2" },
          description: "北境势力范围",
        },
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("边境分区"));
    const search = await screen.findByLabelText("搜索地图要素");
    fireEvent.change(search, { target: { value: "北境领地" } });
    fireEvent.click(await screen.findByText("北境领地"));

    expect(screen.getByText("画笔填充")).toBeInTheDocument();
    expect(screen.getByLabelText("画笔填充颜色")).toHaveValue("#b26d45");
    expect(screen.getByRole("slider", { name: "画笔填充透明度" })).toHaveValue(
      "0.25",
    );

    fireEvent.change(screen.getByLabelText("画笔填充颜色"), {
      target: { value: "#3c91b5" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "画笔填充透明度" }), {
      target: { value: "0.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const saved = storage.getText("world/maps/records/map-area-style.json");
      expect(saved).toContain('"fill": "#3c91b5"');
      expect(saved).toContain('"fillOpacity": "0.7"');
    });
  });

  it("闭合画笔可以提升为陆地区域并保留可编辑地形事实", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-area-promote",
      name: "画笔转地形",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      features: [
        {
          id: "feature-promote-area",
          kind: "area",
          name: "待转大陆",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 180, y: 180 },
            { x: 620, y: 210 },
            { x: 470, y: 540 },
          ],
          timeFrom: null,
          timeTo: null,
          props: {
            fill: "#b26d45",
            fillOpacity: "0.4",
            color: "#8b6b4a",
            lineWidth: "3",
          },
          description: "待确认的大陆轮廓",
        },
      ],
    });

    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );
    fireEvent.click(await screen.findByText("画笔转地形"));
    fireEvent.change(await screen.findByLabelText("搜索地图要素"), {
      target: { value: "待转大陆" },
    });
    fireEvent.click(await screen.findByText("待转大陆"));
    fireEvent.click(await screen.findByRole("button", { name: "设为陆地" }));

    expect(await screen.findByText("地形区域")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-area-promote.json") ?? "{}",
      ) as {
        features?: Array<{ id: string }>;
        scene?: {
          layers?: Array<{
            id: string;
            regions: Array<{
              kind: string;
              fill: string;
              opacity: number;
              terrainMaterial?: string | null;
            }>;
          }>;
        };
      };
      expect(saved.features).toEqual([]);
      expect(
        saved.scene?.layers?.find((layer) => layer.id === "scene-terrain")
          ?.regions,
      ).toEqual([
        expect.objectContaining({
          kind: "land",
          fill: "#b26d45",
          opacity: 0.4,
          terrainMaterial: null,
        }),
      ]);
    });
    unmount();
  });

  it("道路可以切换为城墙路线样式并保存分层外观", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-routes",
      name: "北关防线",
      projectionType: "continent",
    });
    await repository.saveMap(created, {
      ...created.map,
      features: [
        {
          id: "feature-road-style",
          kind: "route",
          name: "北境古道",
          entityRef: null,
          layerId: "layer-main",
          points: [
            { x: 280, y: 340 },
            { x: 760, y: 580 },
          ],
          timeFrom: null,
          timeTo: null,
          props: { routeStyle: "road", showLabel: "true" },
          description: "",
        },
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("北关防线"));
    const search = await screen.findByLabelText("搜索地图要素");
    fireEvent.change(search, { target: { value: "古道" } });
    fireEvent.click(await screen.findByText("北境古道"));

    expect(screen.getByText("路线外观")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "路线样式" }));
    fireEvent.click(await screen.findByRole("button", { name: "城墙防线" }));
    expect(screen.getByRole("slider", { name: "路线主体宽度" })).toHaveValue(
      "10",
    );
    fireEvent.change(screen.getByRole("slider", { name: "路线主体宽度" }), {
      target: { value: "18" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = storage.getText("world/maps/records/map-routes.json");
      expect(saved).toContain('"routeStyle": "wall"');
      expect(saved).toContain('"routeWidth": "18"');
    });
  });

  it("拖入构件创建独立素材印章，并可在检查器中调整后删除", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-artwork",
      name: "九州",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("九州"));
    await screen.findByLabelText("地图构件库");
    fireEvent.click(screen.getByRole("button", { name: "文明道路" }));
    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 420,
      clientY: 280,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? "city" : "",
      },
    });

    expect((await screen.findAllByText("素材印章")).length).toBeGreaterThan(0);
    const secondVariant = screen.getByRole("button", {
      name: "使用素材变体 2",
    });
    fireEvent.click(secondVariant);
    expect(secondVariant).toHaveClass("border-[var(--accent-warm)]");
    const scale = screen.getByRole("spinbutton", { name: "素材缩放" });
    fireEvent.change(scale, { target: { value: "1.5" } });
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: "素材缩放" })).toHaveValue(
        1.5,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除素材" }));
    expect(screen.queryByText("素材印章")).not.toBeInTheDocument();
  });

  it("拖入连续素材构件会直接写入素材笔触，而不是退化为单个印章", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-artwork-brush-drop",
      name: "万林",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("万林"));
    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 420,
      clientY: 280,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? "forest" : "",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-artwork-brush-drop.json") ??
          "{}",
      ) as {
        scene?: {
          layers?: Array<{
            id: string;
            strokes: Array<{ brushAssetId: string | null }>;
          }>;
        };
        artwork?: {
          layers?: Array<{
            stamps: Array<{ assetId: string }>;
          }>;
        };
      };
      expect(
        saved.scene?.layers?.find((layer) => layer.id === "scene-vegetation")
          ?.strokes,
      ).toEqual([expect.objectContaining({ brushAssetId: "forest" })]);
      expect(
        saved.artwork?.layers?.flatMap((layer) => layer.stamps) ?? [],
      ).not.toContainEqual(expect.objectContaining({ assetId: "forest" }));
    });
  });

  it("拖入项目笔刷也保留为素材笔触", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-project-brush-drop",
      name: "松海",
      projectionType: "continent",
    });
    const asset = createMapProjectArtworkAsset({
      mapId: created.map.id,
      id: "asset-pine-pack",
      name: "松林素材.png",
      mimeType: "image/png",
      width: 128,
      height: 64,
      brush: true,
    });
    await storage.createBinary(
      asset.path,
      Uint8Array.from([137, 80, 78, 71]).buffer,
      { createParents: true },
    );
    await repository.saveMap(created, {
      ...created.map,
      artwork: {
        ...created.map.artwork,
        assets: [asset],
      },
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("松海"));
    fireEvent.click(await screen.findByRole("button", { name: "项目素材" }));
    await screen.findByRole("button", { name: "使用松林素材笔刷" });
    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 460,
      clientY: 300,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? asset.id : "",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-project-brush-drop.json") ??
          "{}",
      ) as {
        scene?: {
          layers?: Array<{
            id: string;
            strokes: Array<{ brushAssetId: string | null }>;
          }>;
        };
        artwork?: {
          layers?: Array<{
            stamps: Array<{ assetId: string }>;
          }>;
        };
      };
      expect(
        saved.scene?.layers?.find((layer) => layer.id === "scene-vegetation")
          ?.strokes,
      ).toEqual([expect.objectContaining({ brushAssetId: asset.id })]);
      expect(
        saved.artwork?.layers?.flatMap((layer) => layer.stamps) ?? [],
      ).not.toContainEqual(expect.objectContaining({ assetId: asset.id }));
    });
  });

  it("素材图层决定印章落点，移动和删除图层都不会丢失印章", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-artwork-layers",
      name: "山海",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("山海"));
    fireEvent.click(
      await screen.findByRole("button", { name: "新建素材图层" }),
    );
    const layerName = await screen.findByRole("textbox", {
      name: "素材图层名称：素材层 2",
    });
    fireEvent.change(layerName, { target: { value: "前景地标" } });

    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 460,
      clientY: 300,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? "city" : "",
      },
    });
    expect((await screen.findAllByText("素材印章")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "所属素材图层" }));
    fireEvent.click(await screen.findByRole("button", { name: "素材印章" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "所属素材图层" }),
      ).toHaveTextContent("素材印章"),
    );
    fireEvent.click(screen.getByRole("button", { name: "所属素材图层" }));
    fireEvent.click(await screen.findByRole("button", { name: "前景地标" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "所属素材图层" }),
      ).toHaveTextContent("前景地标"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "删除素材图层：前景地标" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "转移并删除" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-artwork-layers.json") ?? "{}",
      ) as {
        artwork?: {
          layers?: Array<{
            id: string;
            stamps: Array<{ layerId: string }>;
          }>;
        };
      };
      expect(saved.artwork?.layers).toHaveLength(1);
      expect(saved.artwork?.layers?.[0]).toMatchObject({
        id: "artwork-stamps",
        stamps: [{ layerId: "artwork-stamps" }],
      });
    });
    await expect(
      repository.loadMap("map-artwork-layers"),
    ).resolves.toMatchObject({
      map: {
        artwork: {
          layers: [
            {
              id: "artwork-stamps",
              stamps: [{ layerId: "artwork-stamps" }],
            },
          ],
        },
      },
    });
  });

  it("拖入大陆板块会写入真实海陆区域，而不是装饰多边形", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-landmass-prefab",
      name: "群陆",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("群陆"));
    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 480,
      clientY: 320,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? "continent" : "",
      },
    });

    expect(await screen.findByText("地形区域")).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-landmass-prefab.json") ?? "{}",
      ) as {
        scene?: {
          layers?: Array<{
            id: string;
            regions?: Array<{
              kind: string;
              texture: string;
              points: unknown[];
            }>;
          }>;
        };
      };
      const terrainLayer = saved.scene?.layers?.find(
        (layer) => layer.id === "scene-terrain",
      );
      expect(terrainLayer?.regions).toEqual([
        expect.objectContaining({ kind: "land", texture: "paper-land" }),
      ]);
      expect(terrainLayer?.regions?.[0]?.points.length).toBeGreaterThan(8);
    });
  });

  it("拖入疆域覆盖构件会写入可编辑区域要素，而不是改写海陆区域", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-overlay-prefab",
      name: "疆域覆盖",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("疆域覆盖"));
    const canvas = await screen.findByLabelText("地图设计画布");
    fireEvent.drop(canvas, {
      clientX: 520,
      clientY: 340,
      dataTransfer: {
        types: [MAP_COMPONENT_DRAG_MIME],
        getData: (type: string) =>
          type === MAP_COMPONENT_DRAG_MIME ? "territory-fill" : "",
      },
    });

    expect(await screen.findByText("未命名疆域填色")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-overlay-prefab.json") ?? "{}",
      ) as {
        features?: Array<{ kind: string; props: Record<string, string> }>;
        scene?: { layers?: Array<{ regions?: unknown[] }> };
      };
      expect(saved.features).toEqual([
        expect.objectContaining({
          kind: "area",
          props: expect.objectContaining({ component: "territory-fill" }),
        }),
      ]);
      expect(
        saved.scene?.layers?.flatMap((layer) => layer.regions ?? []),
      ).toHaveLength(0);
    });
  });

  it("可搜索、定位、复制要素，并在检查器中切换所属图层", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-designer",
      name: "九州",
      projectionType: "continent",
    });
    storage.setExternalText(
      "world/maps/records/map-designer.json",
      `${JSON.stringify({
        ...created.map,
        layers: [
          ...created.map.layers,
          {
            id: "layer-places",
            name: "地点标注",
            visible: true,
            locked: false,
            opacity: 1,
          },
        ],
        features: [
          {
            id: "feature-outer-island",
            kind: "polygon",
            name: "外岛 1",
            entityRef: null,
            layerId: "layer-main",
            points: [
              { x: 720, y: 420 },
              { x: 800, y: 400 },
              { x: 840, y: 480 },
            ],
            timeFrom: null,
            timeTo: null,
            props: { color: "#63715b", fill: "#9aab7f88" },
            description: "与大陆分离的岛屿。",
          },
        ],
      })}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("九州"));

    const search = await screen.findByLabelText("搜索地图要素");
    fireEvent.change(search, { target: { value: "外岛" } });
    expect(await screen.findByText("外岛 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("外岛 1"));

    expect(
      screen.getByRole("button", { name: "定位到当前要素" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "复制当前要素" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("所属图层")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(await screen.findByDisplayValue("外岛 1 副本")).toBeInTheDocument();

    // 副本成为当前选区，方向键应直接修改副本而不影响源要素。
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-designer.json") ?? "{}",
      ) as {
        features?: Array<{
          id: string;
          points: Array<{ x: number; y: number }>;
        }>;
      };
      expect(
        saved.features?.find((item) => item.id === "feature-outer-island")
          ?.points[0],
      ).toEqual({ x: 160, y: 180 });
      expect(
        saved.features?.find((item) => item.id === "feature-outer-island-copy")
          ?.points[0],
      ).toEqual({ x: 188, y: 198 });
    });

    fireEvent.click(screen.getByLabelText("所属图层"));
    fireEvent.click(await screen.findByRole("button", { name: "地点标注" }));
    await waitFor(() =>
      expect(screen.getByLabelText("所属图层")).toHaveTextContent("地点标注"),
    );

    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() =>
      expect(screen.queryByDisplayValue("外岛 1 副本")).not.toBeInTheDocument(),
    );
  });

  it("Shift 追加选区后，方向键会将全部可编辑对象作为一个操作移动", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-keyboard-selection",
      name: "双城",
      projectionType: "continent",
    });
    storage.setExternalText(
      "world/maps/records/map-keyboard-selection.json",
      `${JSON.stringify({
        ...created.map,
        features: [
          {
            id: "feature-west-city",
            kind: "marker",
            name: "西城",
            entityRef: null,
            layerId: "layer-main",
            points: [{ x: 320, y: 240 }],
            timeFrom: null,
            timeTo: null,
            props: {},
            description: "",
          },
          {
            id: "feature-east-city",
            kind: "marker",
            name: "东城",
            entityRef: null,
            layerId: "layer-main",
            points: [{ x: 520, y: 340 }],
            timeFrom: null,
            timeTo: null,
            props: {},
            description: "",
          },
        ],
      })}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("双城"));
    const canvas = (await screen.findByLabelText(
      "地图绘图层",
    )) as HTMLCanvasElement;
    Object.assign(canvas, {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 532,
        bottom: 432,
        width: 532,
        height: 432,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });

    fireMapPointer(canvas, "pointerdown", {
      clientX: 166,
      clientY: 166,
      pointerId: 1,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 166,
      clientY: 166,
      pointerId: 1,
    });
    await waitFor(() =>
      expect(screen.getByDisplayValue("西城")).toBeInTheDocument(),
    );
    fireMapPointer(canvas, "pointerdown", {
      clientX: 366,
      clientY: 266,
      pointerId: 2,
      shiftKey: true,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 366,
      clientY: 266,
      pointerId: 2,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(screen.getByDisplayValue("东城")).toBeInTheDocument(),
    );

    const arrowRight = createEvent.keyDown(canvas, {
      key: "ArrowRight",
      shiftKey: true,
    });
    fireEvent(canvas, arrowRight);
    expect(arrowRight.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-keyboard-selection.json") ??
          "{}",
      ) as {
        canvas?: { width?: number };
        features?: Array<{
          id: string;
          points: Array<{ x: number; y: number }>;
        }>;
      };
      expect(
        saved.features?.find((item) => item.id === "feature-west-city")
          ?.points[0],
      ).toEqual({ x: 176, y: 166 });
      expect(
        saved.features?.find((item) => item.id === "feature-east-city")
          ?.points[0],
      ).toEqual({ x: 376, y: 266 });
      expect(saved.canvas?.width).toBe(542);
    });
  });

  it("内置素材笔刷在落笔前可选色，并从素材默认色开始", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-brush-color",
      name: "苍梧",
      projectionType: "continent",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("苍梧"));
    fireEvent.click(await screen.findByRole("button", { name: "植被生态" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "使用森林笔刷" }),
    );

    const color = await screen.findByLabelText("素材笔刷颜色");
    expect(color).toHaveValue("#3f7650");
    fireEvent.change(color, { target: { value: "#234f38" } });
    expect(color).toHaveValue("#234f38");
  });

  it("多元宇宙地图分派到拓扑画布并只显示拓扑工具", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-topology",
      name: "诸界",
      projectionType: "multiverse",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("诸界"));

    let topologyCanvas!: HTMLElement;
    await waitFor(() => {
      topologyCanvas = screen.getByLabelText("世界拓扑画布");
      const viewport = topologyCanvas.querySelector('[aria-hidden="true"]');
      expect(viewport).not.toBeNull();
      expect(viewport).toHaveStyle({
        width: "1600px",
        height: "1000px",
      });
    });
    expect(screen.getByText("+ 拓扑节点")).toBeInTheDocument();
    expect(screen.getByText("+ 路线")).toBeInTheDocument();
    expect(screen.queryByText("+ 多边形")).not.toBeInTheDocument();
    expect(screen.queryByText("生成地图")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑节点类型" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "新建拓扑节点名称" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑节点关联地图" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑节点关联设定或实体" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑节点状态" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑通道关系" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建拓扑通道方向" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "拓扑节点横向自动布局" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "拓扑节点纵向自动布局" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "适配拓扑内容" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "折叠全部拓扑子节点" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "展开全部拓扑子节点" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("拓扑构件库")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "放置星球节点" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "使用世界分支" }),
    ).toBeInTheDocument();
    expect(screen.getByText("节点 0")).toBeInTheDocument();
  });

  it("拓扑节点可编辑类型与关联地图，通道可重连且键盘移动会同步端点", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const worldMap = await repository.createMap({
      id: "map-linked-world",
      name: "九州",
      projectionType: "continent",
    });
    const topology = await repository.createMap({
      id: "map-topology-editor",
      name: "诸界拓扑",
      projectionType: "multiverse",
    });
    const topologyMap = await import("../business/topologyMap");
    const source = topologyMap.createTopologyNodeFeature({
      id: "node-origin",
      layerId: "layer-main",
      point: { x: 100, y: 180 },
    });
    const target = topologyMap.createTopologyNodeFeature({
      id: "node-target",
      layerId: "layer-main",
      point: { x: 560, y: 340 },
    });
    const alternate = {
      ...topologyMap.createTopologyNodeFeature({
        id: "node-alternate",
        layerId: "layer-main",
        point: { x: 900, y: 560 },
      }),
      name: "灰烬世界",
    };
    const route = topologyMap.createTopologyEdgeFeature({
      id: "route-passage",
      layerId: "layer-main",
      connection: { source: source.id, target: target.id },
      document: {
        ...topology.map,
        features: [source, target, alternate],
      },
    })!;
    await repository.saveMap(topology, {
      ...topology.map,
      features: [
        { ...source, name: "原初世界" },
        { ...target, name: "镜像世界" },
        alternate,
        route,
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("诸界拓扑"));
    fireEvent.click(await screen.findByRole("button", { name: "原初世界" }));

    expect(await screen.findByText("世界节点")).toBeInTheDocument();
    expect(screen.getAllByText("1 条通道").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: "前置节点" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "后继节点" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "拓扑节点关联设定或实体" }),
    ).toBeInTheDocument();
    const nodeLabelToggle = await screen.findByRole("checkbox", {
      name: "显示拓扑节点标签",
    });
    expect(nodeLabelToggle).toBeChecked();
    fireEvent.click(nodeLabelToggle);
    expect(nodeLabelToggle).not.toBeChecked();
    // 关闭标签后，节点卡片不应再把名称作为可见文本渲染；无障碍名称仍
    // 保留真实节点名，方便定位和键盘操作。
    const hiddenLabelNode = screen.getByLabelText("世界节点：原初世界");
    expect(hiddenLabelNode).not.toHaveTextContent("原初世界");
    expect(hiddenLabelNode).toHaveTextContent("世界");
    expect(screen.getAllByTitle("拖动创建或重连通道")).toHaveLength(12);
    expect(screen.getAllByTitle("连接到此端点")).toHaveLength(12);
    // 节点工具点击已有节点时仍应进入检查器；节点工具只在空白处创建，
    // 不能让“创建”和“编辑”变成互斥的两个工作流。
    fireEvent.click(screen.getByRole("button", { name: "绘制拓扑节点" }));
    const sourceTopologyNode =
      await screen.findByLabelText("世界节点：原初世界");
    fireEvent.click(sourceTopologyNode);
    expect(screen.getByText("世界节点")).toBeInTheDocument();
    fireEvent.click(
      within(sourceTopologyNode).getByLabelText("原初世界更多节点操作"),
    );
    expect(
      within(sourceTopologyNode).getByLabelText("原初世界更多操作"),
    ).toBeInTheDocument();
    expect(
      within(sourceTopologyNode).getByText("新建关联地图"),
    ).toBeInTheDocument();
    expect(
      within(sourceTopologyNode).getByText("复制节点"),
    ).toBeInTheDocument();
    expect(
      within(sourceTopologyNode).getByText("删除节点及关联通道"),
    ).toBeInTheDocument();
    // 方向键由 React Flow 节点自身处理；它不会冒泡到 MapEditor 的通用
    // 微调监听器，因此必须验证节点内的键盘移动也会写回事实源。
    fireEvent.keyDown(await screen.findByLabelText("世界节点：原初世界"), {
      key: "ArrowRight",
    });
    fireEvent.click(screen.getByRole("button", { name: "拓扑节点类型" }));
    fireEvent.click(screen.getByRole("button", { name: "宇宙" }));
    fireEvent.click(screen.getByRole("button", { name: "拓扑节点状态" }));
    fireEvent.click(screen.getByRole("button", { name: "封闭" }));
    fireEvent.click(screen.getByRole("button", { name: "关联地图" }));
    fireEvent.click(screen.getByRole("button", { name: "九州（大陆平面图）" }));

    fireEvent.click(screen.getByRole("button", { name: "世界通道" }));
    expect(
      screen.getByRole("button", { name: "反转方向" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "插入节点" }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "拓扑目标节点" }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "灰烬世界" }).at(-1)!,
    );
    fireEvent.click(screen.getByRole("button", { name: "拓扑通道关系" }));
    fireEvent.click(screen.getByRole("button", { name: "传送门" }));
    fireEvent.click(screen.getByRole("button", { name: "拓扑行进方向" }));
    fireEvent.click(screen.getByRole("button", { name: "单向" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "动态通道" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      const savedSource = loaded.map.features.find(
        (feature) => feature.id === source.id,
      );
      const savedRoute = loaded.map.features.find(
        (feature) => feature.id === route.id,
      );
      const savedAlternate = loaded.map.features.find(
        (feature) => feature.id === alternate.id,
      );
      expect(savedSource).toMatchObject({
        props: {
          topologyNodeKind: "universe",
          topologyNodeStatus: "sealed",
          showLabel: "false",
          linkedMapId: worldMap.map.id,
        },
      });
      // 首次打开会按内容包络重定位整个 MapDocument。验证相对位置，避免
      // 把通用画布坐标规范化细节误当成拓扑节点移动契约。
      expect(savedSource?.points[0]).toEqual({
        x: savedAlternate!.points[0]!.x - 794,
        y: savedAlternate!.points[0]!.y - 380,
      });
      expect(savedRoute).toMatchObject({
        name: "传送门",
        props: {
          sourceNodeId: source.id,
          targetNodeId: alternate.id,
          topologyRouteRelation: "portal",
          topologyRouteDirection: "one-way",
          animated: "true",
        },
        points: [savedSource!.points[0], savedAlternate!.points[0]],
      });
    });
  });

  it("拓扑节点的失效关联可以在检查器中识别并解除", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-stale-link",
      name: "失效关联拓扑",
      projectionType: "multiverse",
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const node = createTopologyNodeFeature({
      id: "node-stale-link",
      layerId: "layer-main",
      point: { x: 320, y: 240 },
      name: "失效世界",
      linkedMapId: "map-that-was-deleted",
    });
    // 直接构造历史遗留的悬空关联，验证编辑器能够识别并解除；正式仓储
    // 保存路径现在会拒绝继续写入这种非法状态。
    storage.setExternalText(
      "world/maps/records/map-topology-stale-link.json",
      serializeMapDocument({ ...topology.map, features: [node] }),
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("失效关联拓扑"));
    fireEvent.click(await screen.findByRole("button", { name: "失效世界" }));
    const topologyNode = await screen.findByLabelText("世界节点：失效世界");
    fireEvent.click(
      within(topologyNode).getByLabelText("失效世界更多节点操作"),
    );
    expect(
      within(topologyNode).getByText("打开关联地图").closest("button"),
    ).toBeDisabled();

    const linkedMapSelect = await screen.findByRole("button", {
      name: "关联地图",
    });
    expect(linkedMapSelect).toHaveTextContent("失效关联");
    fireEvent.click(linkedMapSelect);
    fireEvent.click(
      await screen.findByRole("button", { name: "（未关联地图）" }),
    );
    expect(linkedMapSelect).toHaveTextContent("未关联地图");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () => {
      const saved = await repository.loadMap(topology.map.id);
      expect(
        saved.map.features.find((feature) => feature.id === node.id)?.props
          .linkedMapId,
      ).toBeUndefined();
    });
  });

  it("拓扑节点可新建匹配投影的关联地图并立即持久化回节点", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-child-map",
      name: "星海拓扑",
      projectionType: "multiverse",
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const planetNode = createTopologyNodeFeature({
      id: "node-planet-child",
      layerId: "layer-main",
      point: { x: 320, y: 240 },
      kind: "planet",
      name: "玄穹星",
    });
    await repository.saveMap(topology, {
      ...topology.map,
      features: [planetNode],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("星海拓扑"));
    fireEvent.click(await screen.findByRole("button", { name: "玄穹星" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "新建关联地图" }),
    );

    expect(screen.getByRole("button", { name: "投影类型" })).toHaveTextContent(
      "星球投影",
    );
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(async () => {
      const loadedTopology = await repository.loadMap(topology.map.id);
      const linkedNode = loadedTopology.map.features.find(
        (feature) => feature.id === planetNode.id,
      );
      expect(linkedNode?.props.linkedMapId).toBeTruthy();
      const linkedMap = await repository.loadMap(
        linkedNode!.props.linkedMapId!,
      );
      expect(linkedMap.map).toMatchObject({
        name: "玄穹星",
        projectionType: "planet",
      });
    });
  });

  it("拓扑路线可通过依次点击节点创建，并写回 MapDocument", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-click-connect",
      name: "点选连线拓扑",
      projectionType: "multiverse",
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const source = createTopologyNodeFeature({
      id: "node-click-source",
      layerId: "layer-main",
      point: { x: 120, y: 180 },
      name: "起点世界",
    });
    const target = createTopologyNodeFeature({
      id: "node-click-target",
      layerId: "layer-main",
      point: { x: 580, y: 360 },
      name: "终点世界",
    });
    await repository.saveMap(topology, {
      ...topology.map,
      features: [source, target],
    });

    const { unmount } = render(
      <MapEditor storage={storage} projectTitle="测试小说" isActive />,
    );
    fireEvent.click(await screen.findByText("点选连线拓扑"));
    fireEvent.click(await screen.findByRole("button", { name: "绘制路线" }));
    expect(
      screen.getByText(
        "点击起点再点击目标节点创建通道；也可从节点端口拖动连接",
      ),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText("世界节点：起点世界"));
    expect(await screen.findByText(/已选择起点/u)).toBeInTheDocument();
    expect(screen.getByText("已选起点 · 点击目标节点")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByText("已选起点 · 点击目标节点"),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText("世界节点：起点世界"));
    fireEvent.click(await screen.findByLabelText("世界节点：终点世界"));
    fireEvent.click(screen.getByTitle("保存地图（Ctrl+S）"));

    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      expect(
        loaded.map.features.find(
          (feature) =>
            feature.kind === "route" &&
            feature.props.sourceNodeId === source.id &&
            feature.props.targetNodeId === target.id,
        ),
      ).toMatchObject({
        props: {
          topologyRouteRelation: "passage",
          topologyRouteDirection: "two-way",
        },
        points: [
          expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        ],
      });
    });
    unmount();
  });

  it("多选两个拓扑节点后可按当前关系模板直接创建通道", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-selection-connect",
      name: "多选连接拓扑",
      projectionType: "multiverse",
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const source = createTopologyNodeFeature({
      id: "node-selection-source",
      layerId: "layer-main",
      point: { x: 140, y: 180 },
      name: "来源宇宙",
    });
    const target = createTopologyNodeFeature({
      id: "node-selection-target",
      layerId: "layer-main",
      point: { x: 640, y: 360 },
      name: "目标宇宙",
    });
    await repository.saveMap(topology, {
      ...topology.map,
      features: [source, target],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("多选连接拓扑"));
    await waitFor(() =>
      expect(screen.getByLabelText("世界节点：来源宇宙").isConnected).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByLabelText("世界节点：来源宇宙"));
    await waitFor(() =>
      expect(screen.getByLabelText("世界节点：目标宇宙").isConnected).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByLabelText("世界节点：目标宇宙"), {
      shiftKey: true,
    });

    const connectButton = await screen.findByRole("button", {
      name: "连接已选拓扑节点",
    });
    expect(connectButton).toBeEnabled();
    fireEvent.click(connectButton);
    fireEvent.click(screen.getByTitle("保存地图（Ctrl+S）"));

    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      expect(
        loaded.map.features.find(
          (feature) =>
            feature.kind === "route" &&
            feature.props.sourceNodeId === source.id &&
            feature.props.targetNodeId === target.id,
        ),
      ).toMatchObject({
        props: {
          topologyRouteRelation: "passage",
          topologyRouteDirection: "two-way",
        },
      });
    });
  });

  it("点击同类型节点预设不会清空已配置的关联地图", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-topology-template-child",
      name: "模板子地图",
      projectionType: "continent",
    });
    await repository.createMap({
      id: "map-topology-template",
      name: "节点模板拓扑",
      projectionType: "multiverse",
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("节点模板拓扑"));
    const mapTemplate = await screen.findByRole("button", {
      name: "新建拓扑节点关联地图",
    });
    fireEvent.click(mapTemplate);
    fireEvent.click(
      screen.getAllByRole("button", { name: "模板子地图" }).at(-1)!,
    );
    expect(mapTemplate).toHaveTextContent("模板子地图");

    fireEvent.click(
      await screen.findByRole("button", { name: "放置世界节点" }),
    );
    expect(
      screen.getByRole("button", { name: "新建拓扑节点关联地图" }),
    ).toHaveTextContent("模板子地图");
  });

  it("新建拓扑节点可以直接关联地点实体", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-topology-entity-template",
      name: "实体拓扑模板",
      projectionType: "multiverse",
    });
    storage.setExternalText(
      "world/locations/index.json",
      `${JSON.stringify({
        schemaVersion: 1,
        storageVersion: 1,
        locations: [
          {
            id: "location-ancient-city",
            path: "world/locations/records/location-ancient-city.json",
          },
        ],
      })}\n`,
    );
    storage.setExternalText(
      "world/locations/records/location-ancient-city.json",
      `${JSON.stringify({
        id: "location-ancient-city",
        nodeId: "setting-world",
        parentLocationId: null,
        name: "古城",
        aliases: [],
        type: "城市",
        status: "planned",
        summary: "",
        appearanceNote: "",
        description: "",
        order: 0,
      })}\n`,
    );

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("实体拓扑模板"));

    const entitySelector = await screen.findByRole("button", {
      name: "新建拓扑节点关联设定或实体",
    });
    fireEvent.click(entitySelector);

    fireEvent.click(
      await screen.findByRole("button", { name: "古城（地点）" }),
    );
    expect(
      screen.getByRole("button", { name: "新建拓扑节点关联设定或实体" }),
    ).toHaveTextContent("古城（地点）");
  });

  it("拓扑节点检查器可以关联地点实体并保存", async () => {
    const storage = new NovelMemoryStorage({});
    const onOpenEntity = vi.fn();
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-entity-inspector",
      name: "实体检查拓扑",
      projectionType: "multiverse",
    });
    storage.setExternalText(
      "world/locations/index.json",
      `${JSON.stringify({
        schemaVersion: 1,
        storageVersion: 1,
        locations: [
          {
            id: "location-ancient-city",
            path: "world/locations/records/location-ancient-city.json",
          },
        ],
      })}\n`,
    );
    storage.setExternalText(
      "world/locations/records/location-ancient-city.json",
      `${JSON.stringify({
        id: "location-ancient-city",
        nodeId: "setting-world",
        parentLocationId: null,
        name: "古城",
        aliases: [],
        type: "城市",
        status: "planned",
        summary: "",
        appearanceNote: "",
        description: "",
        order: 0,
      })}\n`,
    );
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const node = createTopologyNodeFeature({
      id: "entity-inspector-node",
      layerId: "layer-main",
      point: { x: 180, y: 160 },
      name: "待关联地点",
    });
    await repository.saveMap(topology, {
      ...topology.map,
      features: [node],
    });

    render(
      <MapEditor
        storage={storage}
        projectTitle="测试小说"
        isActive
        onOpenEntity={onOpenEntity}
      />,
    );
    fireEvent.click(await screen.findByText("实体检查拓扑"));
    fireEvent.click(await screen.findByRole("button", { name: "待关联地点" }));

    const entitySelector = await screen.findByRole("button", {
      name: "拓扑节点关联设定或实体",
    });
    fireEvent.click(entitySelector);
    fireEvent.click(
      await screen.findByRole("button", { name: "古城（地点）" }),
    );
    expect(entitySelector).toHaveTextContent("古城（地点）");

    fireEvent.click(
      await screen.findByRole("button", { name: "打开关联实体" }),
    );
    expect(onOpenEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "location",
        id: "location-ancient-city",
        name: "古城",
        route: "lore",
        focus: { locationId: "location-ancient-city" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      expect(
        loaded.map.features.find((feature) => feature.id === node.id),
      ).toMatchObject({
        entityRef: { kind: "location", id: "location-ancient-city" },
      });
    });
  });

  it("拓扑筛选只改变画布可见节点，不删除 MapDocument 事实", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-filter",
      name: "拓扑筛选",
      projectionType: "multiverse",
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    await repository.saveMap(topology, {
      ...topology.map,
      features: [
        createTopologyNodeFeature({
          id: "node-filter-source",
          layerId: "layer-main",
          point: { x: 120, y: 180 },
          name: "起点宇宙",
        }),
        createTopologyNodeFeature({
          id: "node-filter-target",
          layerId: "layer-main",
          point: { x: 580, y: 360 },
          name: "终点宇宙",
        }),
      ],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("拓扑筛选"));
    const query = await screen.findByRole("textbox", {
      name: "筛选拓扑节点",
    });
    fireEvent.change(query, { target: { value: "终点" } });

    expect(
      await screen.findByText("筛选结果：1 个节点 · 0 条通道"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("世界节点：起点宇宙"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("世界节点：终点宇宙")).toBeInTheDocument();

    const loaded = await repository.loadMap(topology.map.id);
    expect(loaded.map.features.map((feature) => feature.id)).toEqual([
      "node-filter-source",
      "node-filter-target",
    ]);
  });

  it("可按世界架构范围导入拓扑节点，并以父子分支通道写入 MapDocument", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-world-import",
      name: "世界架构拓扑",
      projectionType: "multiverse",
    });
    const settingRepository = await import(
      "../../../settingLibraryRepository"
    ).then((module) => module.createNovelSettingLibraryRepository(storage));
    const library = await settingRepository.load("测试小说");
    const root = library.spatialTree.nodes.find(
      (node) => node.parentId === null,
    )!;
    await settingRepository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: [
        ...library.spatialTree.nodes,
        {
          id: "world-child-planet",
          parentId: root.id,
          name: "测试星球",
          typeId: "planet",
          order: 0,
        },
      ],
    });
    const rootLevel = library.meta.levelTypes.find(
      (level) => level.id === root.typeId,
    );
    const rootLabel = rootLevel
      ? `${root.name} · ${rootLevel.name}`
      : root.name;

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("世界架构拓扑"));

    const importScope = await screen.findByRole("button", {
      name: "拓扑导入世界架构范围",
    });
    fireEvent.click(importScope);
    fireEvent.click(await screen.findByRole("button", { name: rootLabel }));
    const importButton = screen.getByRole("button", {
      name: "从世界架构导入拓扑节点",
    });
    await waitFor(() => expect(importButton).toBeEnabled());
    fireEvent.click(importButton);
    const saveButton = await screen.findByTitle("保存地图（Ctrl+S）");
    fireEvent.click(saveButton);

    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      const importedRoot = loaded.map.features.find(
        (feature) =>
          feature.kind === "node" &&
          feature.entityRef?.kind === "setting" &&
          feature.entityRef.id === root.id,
      );
      expect(importedRoot).toBeTruthy();
      expect(
        loaded.map.features.some(
          (feature) =>
            feature.kind === "route" &&
            feature.props.topologyRouteRelation === "branch" &&
            feature.props.topologyRouteDirection === "one-way",
        ),
      ).toBe(true);
    });
  });

  it("已关联世界架构的拓扑节点可直接补齐其子树", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const topology = await repository.createMap({
      id: "map-topology-node-subtree",
      name: "节点补齐架构",
      projectionType: "multiverse",
    });
    const settingRepository = await import(
      "../../../settingLibraryRepository"
    ).then((module) => module.createNovelSettingLibraryRepository(storage));
    const library = await settingRepository.load("测试小说");
    const root = library.spatialTree.nodes.find(
      (node) => node.parentId === null,
    )!;
    const child = {
      id: "topology-node-subtree-child",
      parentId: root.id,
      name: "群星之海",
      typeId: "planet",
      order: 0,
    };
    await settingRepository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: [...library.spatialTree.nodes, child],
    });
    const { createTopologyNodeFeature } = await import(
      "../business/topologyMap"
    );
    const rootNode = createTopologyNodeFeature({
      id: "topology-node-subtree-root",
      layerId: "layer-main",
      point: { x: 240, y: 220 },
      name: root.name,
      entityRef: { kind: "setting", id: root.id },
    });
    await repository.saveMap(topology, {
      ...topology.map,
      features: [rootNode],
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("节点补齐架构"));

    const rootLevel = library.meta.levelTypes.find(
      (level) => level.id === root.typeId,
    );
    const rootLabel = rootLevel
      ? `${root.name} · ${rootLevel.name}`
      : root.name;
    fireEvent.click(
      await screen.findByRole("button", {
        name: "拓扑导入世界架构范围",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: rootLabel }));
    const rootTopologyNode = await screen.findByLabelText(
      `世界节点：${root.name}`,
    );
    fireEvent.click(
      within(rootTopologyNode).getByLabelText(`${root.name}更多节点操作`),
    );
    fireEvent.click(within(rootTopologyNode).getByText("补齐世界架构子树"));
    fireEvent.click(screen.getByTitle("保存地图（Ctrl+S）"));

    await waitFor(async () => {
      const loaded = await repository.loadMap(topology.map.id);
      const importedChild = loaded.map.features.find(
        (feature) =>
          feature.kind === "node" &&
          feature.entityRef?.kind === "setting" &&
          feature.entityRef.id === child.id,
      );
      expect(importedChild).toBeTruthy();
      expect(
        loaded.map.features.some(
          (feature) =>
            feature.kind === "route" &&
            feature.props.sourceNodeId === rootNode.id &&
            feature.props.targetNodeId === importedChild?.id &&
            feature.props.topologyRouteRelation === "branch" &&
            feature.props.topologyRouteDirection === "one-way",
        ),
      ).toBe(true);
    });
  });

  it("项目素材仅在文档保存成功后才清理二进制文件", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    const created = await repository.createMap({
      id: "map-project-artwork",
      name: "九州",
      projectionType: "continent",
    });
    const asset = createMapProjectArtworkAsset({
      mapId: created.map.id,
      id: "asset-pine-pack",
      name: "松林素材.png",
      mimeType: "image/png",
      width: 128,
      height: 64,
    });
    await storage.createBinary(
      asset.path,
      Uint8Array.from([137, 80, 78, 71]).buffer,
      { createParents: true },
    );
    await repository.saveMap(created, {
      ...created.map,
      artwork: {
        ...created.map.artwork,
        assets: [asset],
      },
    });

    render(<MapEditor storage={storage} projectTitle="测试小说" isActive />);
    fireEvent.click(await screen.findByText("九州"));
    fireEvent.click(await screen.findByRole("button", { name: "项目素材" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "移除松林素材" }),
    );

    expect((await storage.stat([asset.path]))[0]?.exists).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(async () => {
      expect((await storage.stat([asset.path]))[0]?.exists).toBe(false);
    });
    await expect(repository.loadMap(created.map.id)).resolves.toEqual(
      expect.objectContaining({
        map: expect.objectContaining({
          artwork: expect.objectContaining({ assets: [] }),
        }),
      }),
    );
  });

  it("Agent + Azgaar 先选择世界架构范围和生成层级，数量由 Agent 决定", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = await import("../data-access/mapRepository").then(
      (module) => module.createNovelMapRepository(storage),
    );
    await repository.createMap({
      id: "map-agent",
      name: "九州",
      projectionType: "continent",
    });
    const onLaunchMapAgent = vi.fn(async () => undefined);

    render(
      <MapEditor
        storage={storage}
        projectTitle="测试小说"
        isActive
        agentAvailable
        onLaunchMapAgent={onLaunchMapAgent}
      />,
    );
    fireEvent.click(await screen.findByText("九州"));
    fireEvent.click(await screen.findByRole("button", { name: "生成地图" }));

    expect(await screen.findAllByText("Agent + Azgaar")).not.toHaveLength(0);
    expect(screen.getByText("读取设定 · Agent Tool")).toBeInTheDocument();
    expect(screen.getByText("离线简化草图")).toBeInTheDocument();
    expect(screen.getByText("离线备选 · 不读取设定")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "世界架构范围" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "生成层级" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/大陆数量/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/区域数量/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/河流数量/u)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "交给 Agent 生成" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "交给 Agent 生成" }));
    await waitFor(() =>
      expect(onLaunchMapAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          mapId: "map-agent",
          mapName: "九州",
          worldNodeId: "world-root",
          generationLevelTypeId: "continent",
        }),
      ),
    );
    const request = (
      onLaunchMapAgent.mock.calls as unknown as readonly [
        Record<string, unknown>,
      ][]
    )[0]![0];
    expect(request).not.toHaveProperty("landmassCount");
    expect(request).not.toHaveProperty("regionCount");
    expect(request).not.toHaveProperty("riverCount");
  });

  it("handles a command-palette map request by opening the real create dialog", async () => {
    const storage = new NovelMemoryStorage({});
    render(
      <MapEditor
        storage={storage}
        projectTitle="测试小说"
        isActive
        quickCreateRequest={{ kind: "map", token: 1 }}
      />,
    );

    expect(await screen.findByText("新建地图")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeInTheDocument();
  });
});
