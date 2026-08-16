import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import MapEditor from "./MapEditor";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { MAP_COMPONENT_DRAG_MIME } from "../business/mapComponents";
import { createMapProjectArtworkAsset } from "../business/mapProjectArtwork";

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

  it("六类要素工具齐全，绘制草稿后可以保存并重新加载", async () => {
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
      for (const label of [
        "+ 标记点",
        "+ 文本标签",
        "+ 区域",
        "+ 多边形",
        "+ 路线",
        "+ 拓扑节点",
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
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
      expect(screen.getByLabelText("地图构件库")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "画布背景" }),
      ).toBeInTheDocument();
    });
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
    fireEvent.click(screen.getByRole("button", { name: "放置河流" }));

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
    fireEvent.click(screen.getByRole("button", { name: "大陆板块" }));
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
          type === MAP_COMPONENT_DRAG_MIME ? "forest" : "",
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
    await repository.saveMap(created, {
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
    });

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
      ).toEqual({ x: 720, y: 420 });
      expect(
        saved.features?.find((item) => item.id === "feature-outer-island-copy")
          ?.points[0],
      ).toEqual({ x: 748, y: 438 });
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
    await repository.saveMap(created, {
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
    });

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
      clientX: 320,
      clientY: 240,
      pointerId: 1,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 320,
      clientY: 240,
      pointerId: 1,
    });
    fireMapPointer(canvas, "pointerdown", {
      clientX: 520,
      clientY: 340,
      pointerId: 2,
      shiftKey: true,
    });
    fireMapPointer(canvas, "pointerup", {
      clientX: 520,
      clientY: 340,
      pointerId: 2,
      shiftKey: true,
    });

    fireEvent.keyDown(window, { key: "ArrowUp", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const saved = JSON.parse(
        storage.getText("world/maps/records/map-keyboard-selection.json") ??
          "{}",
      ) as {
        features?: Array<{
          id: string;
          points: Array<{ x: number; y: number }>;
        }>;
      };
      expect(
        saved.features?.find((item) => item.id === "feature-west-city")
          ?.points[0],
      ).toEqual({ x: 320, y: 230 });
      expect(
        saved.features?.find((item) => item.id === "feature-east-city")
          ?.points[0],
      ).toEqual({ x: 520, y: 330 });
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

    const topologyCanvas = await screen.findByLabelText("世界拓扑画布");
    expect(topologyCanvas).toBeInTheDocument();
    expect(topologyCanvas.querySelector('[aria-hidden="true"]')).toHaveStyle({
      width: "1600px",
      height: "1000px",
    });
    expect(screen.getByText("+ 拓扑节点")).toBeInTheDocument();
    expect(screen.getByText("+ 路线")).toBeInTheDocument();
    expect(screen.queryByText("+ 多边形")).not.toBeInTheDocument();
    expect(screen.queryByText("生成地图")).not.toBeInTheDocument();
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
