import { describe, expect, it } from "vitest";

import {
  arrangeTopologyNodes,
  canEditTopologyNodes,
  buildTopologyElements,
  canConnectTopologyNodes,
  createConnectedTopologyNode,
  createTopologyEdgeFeature,
  createTopologyNodeFeature,
  duplicateTopologyFeatures,
  getTopologyNodeKind,
  getTopologyNodeLocked,
  getTopologyNodeConnections,
  getTopologyNodeDescendants,
  getTopologyNodeAncestors,
  getTopologyNodeLinkedMapId,
  getTopologyNodeStatus,
  topologyNodeLabelVisible,
  getTopologyInvalidRouteDiagnostics,
  getTopologyRouteDirection,
  topologyRouteLabelVisible,
  getTopologyRouteRelation,
  getTopologySummary,
  insertTopologyNodeOnEdge,
  moveTopologyNode,
  moveTopologyNodes,
  reconnectTopologyEdge,
  removeTopologyFeature,
  removeTopologyFeatures,
  reverseTopologyEdge,
  updateTopologyRoute,
  topologyNodeKindForProjection,
  topologyNodeKindForSettingMapKind,
  topologyAdjacentNodePoint,
  topologyHierarchyAdjacentNodePoint,
  topologyProjectionForNodeKind,
  importTopologySettingSubtree,
  toggleTopologySelection,
} from "./topologyMap";
import {
  createEmptyMapDocument,
  mapDocumentSchema,
} from "../entities/mapSchema";
import { expandMapCanvasToContent } from "./mapCanvasBounds";

function topologyDocument() {
  const document = createEmptyMapDocument({
    id: "map-1",
    name: "诸界",
    projectionType: "multiverse",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const left = createTopologyNodeFeature({
    id: "node-left",
    layerId: "layer-main",
    point: { x: 120, y: 180 },
  });
  const right = createTopologyNodeFeature({
    id: "node-right",
    layerId: "layer-main",
    point: { x: 580, y: 340 },
  });
  const edge = createTopologyEdgeFeature({
    id: "route-1",
    layerId: "layer-main",
    connection: { source: left.id, target: right.id },
    document: { ...document, features: [left, right] },
  });
  return { ...document, features: [left, right, edge!] };
}

describe("topologyMap", () => {
  it("以稳定顺序切换拓扑多选，并给出可用于检查器的主选项", () => {
    expect(toggleTopologySelection([], "node-left", false)).toEqual({
      ids: ["node-left"],
      primaryId: "node-left",
    });
    expect(toggleTopologySelection(["node-left"], "route-1", true)).toEqual({
      ids: ["node-left", "route-1"],
      primaryId: "route-1",
    });
    expect(
      toggleTopologySelection(["node-left", "route-1"], "node-left", true),
    ).toEqual({
      ids: ["route-1"],
      primaryId: "route-1",
    });
    expect(toggleTopologySelection(["node-left"], "node-left", true)).toEqual({
      ids: [],
      primaryId: null,
    });
  });

  it("把节点和带端点引用的路线映射为 XYFlow 元素", () => {
    const document = topologyDocument();
    const elements = buildTopologyElements(document, null);

    expect(elements.nodes.map((node) => node.id)).toEqual([
      "node-left",
      "node-right",
    ]);
    expect(elements.edges).toMatchObject([
      {
        id: "route-1",
        source: "node-left",
        target: "node-right",
        sourceHandle: "source-port-right",
        targetHandle: "target-port-left",
      },
    ]);
    expect(mapDocumentSchema.parse(document)).toEqual(document);
  });

  it("为世界节点和通道提供稳定的语义默认值与可视化数据", () => {
    const document = topologyDocument();
    const node = document.features.find(
      (feature) => feature.id === "node-left",
    )!;
    const edge = document.features.find((feature) => feature.id === "route-1")!;
    const elements = buildTopologyElements(document, null);

    expect(getTopologyNodeKind(node)).toBe("world");
    expect(getTopologyNodeLinkedMapId(node)).toBeNull();
    expect(getTopologyRouteRelation(edge)).toBe("passage");
    expect(getTopologyRouteDirection(edge)).toBe("two-way");
    expect(elements.nodes[0]).toMatchObject({
      type: "topology-world",
      style: { width: 176, height: 104 },
      data: {
        kind: "world",
        kindLabel: "世界",
        description: "",
        linkedMapId: null,
        connectionCount: 1,
        incomingCount: 1,
        outgoingCount: 1,
      },
    });
    expect(elements.edges[0]?.data).toEqual({
      relation: "passage",
      direction: "two-way",
    });
    expect(topologyRouteLabelVisible(edge)).toBe(true);
    expect(elements.edges[0]?.label).toBe("世界通道");
  });

  it("从节点的世界架构引用派生可继续下钻的设定标识", () => {
    const node = createTopologyNodeFeature({
      id: "node-setting",
      layerId: "layer-main",
      point: { x: 320, y: 180 },
      entityRef: { kind: "setting", id: "setting-root" },
    });
    const elements = buildTopologyElements(
      { ...topologyDocument(), features: [node] },
      null,
    );

    expect(elements.nodes[0]?.data.settingRefId).toBe("setting-root");
  });

  it("拓扑通道可以关闭标签且不影响路线事实", () => {
    const document = topologyDocument();
    const next = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === "route-1"
          ? { ...feature, props: { ...feature.props, showLabel: "false" } }
          : feature,
      ),
    };
    const edge = next.features.find((feature) => feature.id === "route-1")!;
    const elements = buildTopologyElements(next, null);

    expect(topologyRouteLabelVisible(edge)).toBe(false);
    expect(elements.edges[0]?.label).toBeUndefined();
    expect(edge.props.sourceNodeId).toBe("node-left");
    expect(edge.props.targetNodeId).toBe("node-right");
  });

  it("节点状态写入 MapDocument，并在拓扑元素中提供进出通道统计", () => {
    const document = topologyDocument();
    const sealed = createTopologyNodeFeature({
      id: "node-sealed",
      layerId: "layer-main",
      point: { x: 900, y: 340 },
      status: "sealed",
    });
    const route = createTopologyEdgeFeature({
      id: "route-sealed",
      layerId: "layer-main",
      connection: { source: "node-right", target: sealed.id },
      document: { ...document, features: [...document.features, sealed] },
      direction: "one-way",
    });
    const next = {
      ...document,
      features: [...document.features, sealed, route!],
    };
    const node = next.features.find((feature) => feature.id === sealed.id)!;
    const rendered = buildTopologyElements(next, null);

    expect(getTopologyNodeStatus(node)).toBe("sealed");
    expect(node.props.topologyNodeStatus).toBe("sealed");
    expect(
      rendered.nodes.find((candidate) => candidate.id === sealed.id),
    ).toMatchObject({
      data: { status: "sealed", incomingCount: 1, outgoingCount: 0 },
    });
    expect(route).toMatchObject({
      name: "世界通道",
      props: { topologyRouteDirection: "one-way" },
    });
  });

  it("节点连接检查器与画布共享可见、有效路线判定", () => {
    const document = topologyDocument();
    const hiddenRoute = {
      ...document.features.find((feature) => feature.id === "route-1")!,
      id: "route-hidden",
      layerId: "layer-hidden",
    };
    const hiddenLayer = {
      id: "layer-hidden",
      name: "隐藏拓扑",
      visible: false,
      locked: false,
      opacity: 1,
    };
    const danglingRoute = {
      ...document.features.find((feature) => feature.id === "route-1")!,
      id: "route-dangling",
      props: {
        ...document.features.find((feature) => feature.id === "route-1")!.props,
        targetNodeId: "missing-node",
      },
    };
    const next = {
      ...document,
      layers: [...document.layers, hiddenLayer],
      features: [...document.features, hiddenRoute, danglingRoute],
    };

    expect(getTopologyNodeConnections(next, "node-left")).toMatchObject({
      connectionCount: 1,
      incomingCount: 1,
      outgoingCount: 1,
      routes: [{ route: { id: "route-1" }, direction: "two-way" }],
    });
    expect(
      buildTopologyElements(next, null).edges.map((edge) => edge.id),
    ).toEqual(["route-1"]);
  });

  it("节点连接统计排除重复通道，与画布诊断保持一致", () => {
    const document = topologyDocument();
    const duplicate = {
      ...document.features.find((feature) => feature.id === "route-1")!,
      id: "route-duplicate",
    };
    const next = {
      ...document,
      features: [...document.features, duplicate],
    };

    expect(getTopologyNodeConnections(next, "node-left")).toMatchObject({
      connectionCount: 1,
      routes: [{ route: { id: "route-1" } }],
    });
    expect(
      getTopologyInvalidRouteDiagnostics(next).map((item) => item.route.id),
    ).toEqual(["route-duplicate"]);
  });

  it("时间切片会同步过滤节点连接检查器", () => {
    const document = topologyDocument();
    const timed = {
      ...document,
      features: document.features.map((feature) => ({
        ...feature,
        timeFrom: 10,
        timeTo: 20,
      })),
    };

    expect(getTopologyNodeConnections(timed, "node-left", 5)).toMatchObject({
      connectionCount: 0,
      routes: [],
    });
    expect(getTopologyNodeConnections(timed, "node-left", 15)).toMatchObject({
      connectionCount: 1,
      incomingCount: 1,
      outgoingCount: 1,
    });
  });

  it("按节点模板创建可直接关联地图的不同类型节点", () => {
    const node = createTopologyNodeFeature({
      id: "node-planet",
      layerId: "layer-main",
      point: { x: 240, y: 320 },
      kind: "planet",
      name: "九州星",
      linkedMapId: "map-planet",
    });

    expect(node).toMatchObject({
      name: "九州星",
      props: {
        color: "#657b55",
        topologyNodeKind: "planet",
        linkedMapId: "map-planet",
      },
    });
    expect(topologyNodeKindForProjection("multiverse")).toBe("universe");
    expect(topologyNodeKindForProjection("parallel")).toBe("timeline");
    expect(topologyNodeKindForProjection("planet")).toBe("planet");
    expect(topologyProjectionForNodeKind("universe")).toBe("multiverse");
    expect(topologyProjectionForNodeKind("timeline")).toBe("parallel");
    expect(topologyProjectionForNodeKind("planet")).toBe("planet");
    expect(topologyProjectionForNodeKind("world")).toBe("continent");
    expect(topologyProjectionForNodeKind("realm")).toBe("continent");
  });

  it("按世界架构层级推导拓扑节点类型", () => {
    expect(topologyNodeKindForSettingMapKind("cosmic-region")).toBe("universe");
    expect(topologyNodeKindForSettingMapKind("stellar-region")).toBe(
      "star-system",
    );
    expect(topologyNodeKindForSettingMapKind("geographic-area", "大陆")).toBe(
      "continent",
    );
    expect(topologyNodeKindForSettingMapKind("settlement-point", "城市")).toBe(
      "settlement",
    );
    expect(topologyNodeKindForSettingMapKind("planet-point")).toBe("planet");
    expect(topologyNodeKindForSettingMapKind("geographic-area")).toBe("world");
    expect(topologyNodeKindForSettingMapKind("settlement-point")).toBe("realm");
    expect(topologyProjectionForNodeKind("galaxy")).toBe("multiverse");
    expect(topologyProjectionForNodeKind("star-system")).toBe("multiverse");
    expect(topologyProjectionForNodeKind("continent")).toBe("continent");
    expect(topologyProjectionForNodeKind("settlement")).toBe("continent");
  });

  it("只把单向分支路线视为层级后代，并按树顺序返回全部后代", () => {
    const document = topologyDocument();
    const child = createTopologyNodeFeature({
      id: "node-child",
      layerId: "layer-main",
      point: { x: 820, y: 180 },
    });
    const grandchild = createTopologyNodeFeature({
      id: "node-grandchild",
      layerId: "layer-main",
      point: { x: 1080, y: 180 },
    });
    const withChild = {
      ...document,
      features: [...document.features, child],
    };
    const branch = createTopologyEdgeFeature({
      id: "route-branch-child",
      layerId: "layer-main",
      connection: { source: "node-left", target: child.id },
      document: withChild,
      relation: "branch",
      direction: "one-way",
    });
    const withGrandchild = {
      ...withChild,
      features: [...withChild.features, branch!, grandchild],
    };
    const nestedBranch = createTopologyEdgeFeature({
      id: "route-branch-grandchild",
      layerId: "layer-main",
      connection: { source: child.id, target: grandchild.id },
      document: withGrandchild,
      relation: "branch",
      direction: "one-way",
    });
    const next = {
      ...withGrandchild,
      features: [...withGrandchild.features, nestedBranch!],
    };

    expect(getTopologyNodeDescendants(next, "node-left")).toEqual([
      child.id,
      grandchild.id,
    ]);
    expect(getTopologyNodeDescendants(next, "node-right")).toEqual([]);
    expect(
      buildTopologyElements(next, null).nodes.find(
        (node) => node.id === "node-left",
      )?.data.descendantCount,
    ).toBe(2);
    expect(getTopologyNodeAncestors(next, grandchild.id)).toEqual([
      "node-left",
      child.id,
    ]);
    expect(
      buildTopologyElements(next, null).nodes.find(
        (node) => node.id === grandchild.id,
      )?.data.ancestorPath,
    ).toBe("新世界 / 新世界");
  });

  it("导入世界架构子树时原子创建节点和父子通道，重复导入不产生重复事实", () => {
    const document = topologyDocument();
    const settingNodes = [
      {
        id: "setting-root",
        parentId: null,
        name: "星海",
        typeId: "cosmos",
        order: 0,
      },
      {
        id: "setting-world",
        parentId: "setting-root",
        name: "九州",
        typeId: "world",
        order: 0,
      },
      {
        id: "setting-realm",
        parentId: "setting-world",
        name: "镜界",
        typeId: "realm",
        order: 0,
      },
      {
        id: "setting-outside",
        parentId: null,
        name: "不在范围",
        typeId: "world",
        order: 0,
      },
    ] as const;
    const imported = importTopologySettingSubtree(document, {
      rootSettingId: "setting-root",
      settingNodes,
      levelTypes: [
        { id: "cosmos", mapKind: "cosmic-region" },
        { id: "world", mapKind: "geographic-area" },
        { id: "realm", mapKind: "settlement-point" },
      ],
      layerId: "layer-main",
    });

    expect(imported.importedNodeIds).toHaveLength(3);
    expect(imported.importedRouteIds).toHaveLength(2);
    expect(imported.rootNodeId).toBe("topology-node-setting-root");
    expect(imported.map.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "topology-node-setting-root",
          name: "星海",
          entityRef: { kind: "setting", id: "setting-root" },
          props: expect.objectContaining({ topologyNodeKind: "universe" }),
        }),
        expect.objectContaining({
          id: "topology-node-setting-world",
          props: expect.objectContaining({ topologyNodeKind: "world" }),
        }),
        expect.objectContaining({
          id: "topology-node-setting-realm",
          props: expect.objectContaining({ topologyNodeKind: "realm" }),
        }),
        expect.objectContaining({
          kind: "route",
          props: expect.objectContaining({
            topologyRouteRelation: "branch",
            topologyRouteDirection: "one-way",
          }),
        }),
      ]),
    );
    expect(
      imported.map.features.find(
        (feature) => feature.id === "topology-node-setting-root",
      )?.points,
    ).toEqual([{ x: 160, y: 160 }]);
    expect(
      imported.map.features.find(
        (feature) => feature.id === "topology-node-setting-world",
      )?.points,
    ).toEqual([{ x: 440, y: 160 }]);
    expect(mapDocumentSchema.parse(imported.map)).toEqual(imported.map);

    const repeated = importTopologySettingSubtree(imported.map, {
      rootSettingId: "setting-root",
      settingNodes,
      levelTypes: [
        { id: "cosmos", mapKind: "cosmic-region" },
        { id: "world", mapKind: "geographic-area" },
        { id: "realm", mapKind: "settlement-point" },
      ],
      layerId: "layer-main",
    });
    expect(repeated.importedNodeIds).toEqual([]);
    expect(repeated.importedRouteIds).toEqual([]);
    expect(repeated.map).toBe(imported.map);

    const importedNodes = imported.map.features.filter(
      (feature) => feature.kind === "node",
    );
    const passage = createTopologyEdgeFeature({
      id: "route-setting-passage",
      layerId: "layer-main",
      connection: {
        source: "topology-node-setting-root",
        target: "topology-node-setting-world",
      },
      relation: "passage",
      document: {
        ...document,
        features: [...document.features, ...importedNodes],
      },
    })!;
    const branchAddedAlongsidePassage = importTopologySettingSubtree(
      {
        ...document,
        features: [...document.features, ...importedNodes, passage],
      },
      {
        rootSettingId: "setting-root",
        settingNodes,
        levelTypes: [
          { id: "cosmos", mapKind: "cosmic-region" },
          { id: "world", mapKind: "geographic-area" },
          { id: "realm", mapKind: "settlement-point" },
        ],
        layerId: "layer-main",
      },
    );
    expect(branchAddedAlongsidePassage.importedNodeIds).toEqual([]);
    expect(branchAddedAlongsidePassage.importedRouteIds).toHaveLength(2);
  });

  it("新建节点可以同时关联世界架构实体", () => {
    const node = createTopologyNodeFeature({
      id: "node-setting",
      layerId: "layer-main",
      point: { x: 240, y: 320 },
      entityRef: { kind: "setting", id: "world-root" },
    });

    expect(node.entityRef).toEqual({ kind: "setting", id: "world-root" });
    expect(
      mapDocumentSchema.parse({
        ...topologyDocument(),
        features: [...topologyDocument().features, node],
      }),
    ).toBeTruthy();
  });

  it("拓扑节点拒绝关联当前拓扑地图本身", () => {
    const document = topologyDocument();
    const selfLinkedNode = {
      ...document.features.find((feature) => feature.kind === "node")!,
      props: {
        ...document.features.find((feature) => feature.kind === "node")!.props,
        linkedMapId: document.id,
      },
    };
    expect(() =>
      mapDocumentSchema.parse({
        ...document,
        features: document.features.map((feature) =>
          feature.id === selfLinkedNode.id ? selfLinkedNode : feature,
        ),
      }),
    ).toThrow("拓扑节点不能关联当前地图本身");
  });

  it("从节点创建前置或后继节点时原子写入节点和通道", () => {
    const document = topologyDocument();
    const result = createConnectedTopologyNode(document, {
      anchorNodeId: "node-left",
      nodeId: "node-next",
      edgeId: "route-next",
      direction: "outgoing",
      point: { x: 360, y: 180 },
      node: { kind: "realm", name: "中转位面" },
      relation: "portal",
      routeDirection: "one-way",
    });

    expect(result?.map.features).toHaveLength(5);
    expect(result?.map.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "node-next", kind: "node" }),
        expect.objectContaining({
          id: "route-next",
          props: expect.objectContaining({
            sourceNodeId: "node-left",
            targetNodeId: "node-next",
            topologyRouteRelation: "portal",
            topologyRouteDirection: "one-way",
          }),
        }),
      ]),
    );
    expect(mapDocumentSchema.parse(result!.map)).toEqual(result!.map);
  });

  it("连续创建相邻节点时按确定性间距避让已有节点", () => {
    const document = topologyDocument();
    const first = topologyAdjacentNodePoint(document, "node-left", "outgoing");
    expect(first).toEqual({ x: 400, y: 180 });

    const occupied = createTopologyNodeFeature({
      id: "node-adjacent",
      layerId: "layer-main",
      point: first!,
    });
    const second = topologyAdjacentNodePoint(
      { ...document, features: [...document.features, occupied] },
      "node-left",
      "outgoing",
    );
    expect(second).toEqual({ x: 400, y: 316 });
  });

  it("层级节点按父上子下落位，并为同层节点稳定避让", () => {
    const document = topologyDocument();
    expect(
      topologyHierarchyAdjacentNodePoint(document, "node-left", "parent"),
    ).toEqual({ x: 120, y: -12 });
    expect(
      topologyHierarchyAdjacentNodePoint(document, "node-left", "child"),
    ).toEqual({ x: 120, y: 372 });

    const occupied = createTopologyNodeFeature({
      id: "node-child",
      layerId: "layer-main",
      point: { x: 120, y: 372 },
    });
    expect(
      topologyHierarchyAdjacentNodePoint(
        { ...document, features: [...document.features, occupied] },
        "node-left",
        "child",
      ),
    ).toEqual({ x: 328, y: 372 });
  });

  it("在通道中点插入节点时拆分端点并保留原通道属性", () => {
    const result = insertTopologyNodeOnEdge(topologyDocument(), {
      edgeId: "route-1",
      nodeId: "node-mid",
      trailingEdgeId: "route-1-tail",
      node: { name: "中继世界" },
    });

    const leading = result?.map.features.find(
      (feature) => feature.id === "route-1",
    );
    const trailing = result?.map.features.find(
      (feature) => feature.id === "route-1-tail",
    );
    expect(leading).toMatchObject({
      props: { sourceNodeId: "node-left", targetNodeId: "node-mid" },
      points: [
        { x: 120, y: 180 },
        { x: 350, y: 260 },
      ],
    });
    expect(trailing).toMatchObject({
      props: { sourceNodeId: "node-mid", targetNodeId: "node-right" },
      points: [
        { x: 350, y: 260 },
        { x: 580, y: 340 },
      ],
    });
    expect(mapDocumentSchema.parse(result!.map)).toEqual(result!.map);
  });

  it("反转通道时同步来源、目标和绘制端点", () => {
    const reversed = reverseTopologyEdge(topologyDocument(), "route-1");
    expect(
      reversed?.features.find((feature) => feature.id === "route-1"),
    ).toMatchObject({
      props: { sourceNodeId: "node-right", targetNodeId: "node-left" },
      points: [
        { x: 580, y: 340 },
        { x: 120, y: 180 },
      ],
    });
    expect(mapDocumentSchema.parse(reversed!)).toEqual(reversed);
  });

  it("隐藏图层和时间切片会同时过滤节点与连接", () => {
    const document = topologyDocument();
    const timed = {
      ...document,
      features: document.features.map((feature) => ({
        ...feature,
        timeFrom: 10,
        timeTo: 20,
      })),
    };
    expect(buildTopologyElements(timed, 5)).toEqual({ nodes: [], edges: [] });
    expect(buildTopologyElements(timed, 15).nodes).toHaveLength(2);
    expect(
      buildTopologyElements(
        {
          ...timed,
          layers: timed.layers.map((layer) => ({ ...layer, visible: false })),
        },
        15,
      ),
    ).toEqual({ nodes: [], edges: [] });
  });

  it("拒绝自环和不存在端点", () => {
    const document = topologyDocument();
    expect(
      createTopologyEdgeFeature({
        id: "route-invalid",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-left" },
        document,
      }),
    ).toBeNull();
    expect(
      createTopologyEdgeFeature({
        id: "route-invalid",
        layerId: "layer-main",
        connection: { source: "node-left", target: "missing" },
        document,
      }),
    ).toBeNull();
    expect(canConnectTopologyNodes(document, "node-left", "node-right")).toBe(
      true,
    );
  });

  it("不会把隐藏或锁定节点接入新通道，并能统计孤立节点", () => {
    const document = topologyDocument();
    const locked = {
      ...document,
      layers: document.layers.map((layer) =>
        layer.id === "layer-main" ? { ...layer, locked: true } : layer,
      ),
    };
    expect(
      createTopologyEdgeFeature({
        id: "route-locked",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-right" },
        document: locked,
      }),
    ).toBeNull();

    const isolated = createTopologyNodeFeature({
      id: "node-isolated",
      layerId: "layer-main",
      point: { x: 920, y: 120 },
    });
    const summary = getTopologySummary({
      ...document,
      features: [...document.features, isolated],
    });
    expect(summary).toEqual({
      nodeCount: 3,
      routeCount: 1,
      connectedNodeCount: 2,
      isolatedNodeCount: 1,
      invalidRouteCount: 0,
    });
  });

  it("锁定节点仍可查看，且悬空通道不会污染节点连接统计", () => {
    const document = topologyDocument();
    const locked = {
      ...document,
      layers: document.layers.map((layer) =>
        layer.id === "layer-main" ? { ...layer, locked: true } : layer,
      ),
    };
    const rendered = buildTopologyElements(locked, null);
    expect(rendered.nodes).toHaveLength(2);
    expect(rendered.nodes.every((node) => node.selectable)).toBe(true);
    expect(rendered.nodes.every((node) => !node.draggable)).toBe(true);
    expect(rendered.edges).toHaveLength(1);
    expect(rendered.edges[0]).toMatchObject({
      selectable: true,
      reconnectable: false,
    });

    const dangling = {
      ...document,
      features: [
        ...document.features,
        {
          ...document.features.find((feature) => feature.kind === "route")!,
          id: "route-dangling",
          props: {
            ...document.features.find((feature) => feature.kind === "route")!
              .props,
            targetNodeId: "missing-node",
          },
        },
      ],
    };
    const danglingRendered = buildTopologyElements(dangling, null);
    expect(
      danglingRendered.nodes.find((node) => node.id === "node-left")?.data,
    ).toMatchObject({
      connectionCount: 1,
      incomingCount: 1,
      outgoingCount: 1,
    });
    expect(danglingRendered.edges).toHaveLength(1);
  });

  it("为悬空、自环和不可见端点路线提供可定位诊断", () => {
    const document = topologyDocument();
    const route = document.features.find(
      (feature) => feature.kind === "route",
    )!;
    const selfLoop = {
      ...route,
      id: "route-self-loop",
      props: {
        ...route.props,
        sourceNodeId: "node-left",
        targetNodeId: "node-left",
      },
    };
    const dangling = {
      ...route,
      id: "route-missing-target",
      props: {
        ...route.props,
        targetNodeId: "missing-node",
      },
    };
    const hiddenNode = createTopologyNodeFeature({
      id: "node-hidden",
      layerId: "layer-hidden",
      point: { x: 900, y: 180 },
    });
    const hiddenRoute = {
      ...route,
      id: "route-hidden-target",
      props: {
        ...route.props,
        targetNodeId: hiddenNode.id,
      },
    };
    const withInvalidRoutes = {
      ...document,
      layers: [
        ...document.layers,
        {
          id: "layer-hidden",
          name: "隐藏图层",
          visible: false,
          locked: false,
          opacity: 1,
          order: 2,
        },
      ],
      features: [
        ...document.features,
        selfLoop,
        dangling,
        hiddenNode,
        hiddenRoute,
      ],
    };
    expect(
      getTopologyInvalidRouteDiagnostics(withInvalidRoutes).map((item) => ({
        id: item.route.id,
        reason: item.reason,
        label: item.reasonLabel,
      })),
    ).toEqual([
      { id: "route-self-loop", reason: "self-loop", label: "不能连接自身" },
      {
        id: "route-missing-target",
        reason: "missing-target",
        label: "缺少目标节点",
      },
      {
        id: "route-hidden-target",
        reason: "hidden-target",
        label: "目标节点不可见",
      },
    ]);
    expect(getTopologySummary(withInvalidRoutes).invalidRouteCount).toBe(3);
  });

  it("新建通道直接采用当前关系和方向预设", () => {
    const document = topologyDocument();
    const route = createTopologyEdgeFeature({
      id: "route-portal",
      layerId: "layer-main",
      connection: { source: "node-left", target: "node-right" },
      document,
      relation: "portal",
      direction: "one-way",
    });

    expect(route).toMatchObject({
      name: "传送门",
      props: {
        topologyRouteRelation: "portal",
        topologyRouteDirection: "one-way",
      },
    });
  });

  it("拒绝创建完全重复的通道，但允许不同关系或单向方向并存", () => {
    const document = topologyDocument();
    expect(
      createTopologyEdgeFeature({
        id: "route-duplicate",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-right" },
        document,
      }),
    ).toBeNull();
    expect(
      createTopologyEdgeFeature({
        id: "route-portal-alongside",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-right" },
        document,
        relation: "portal",
      }),
    ).not.toBeNull();
    expect(
      createTopologyEdgeFeature({
        id: "route-one-way-alongside",
        layerId: "layer-main",
        connection: { source: "node-left", target: "node-right" },
        document,
        direction: "one-way",
      }),
    ).not.toBeNull();
  });

  it("识别旧数据中的重复路线和分支环路，并从连通统计中排除", () => {
    const document = topologyDocument();
    const baseRoute = document.features.find(
      (feature) => feature.id === "route-1",
    )!;
    const duplicate = {
      ...baseRoute,
      id: "route-duplicate",
    };
    const branchForward = {
      ...baseRoute,
      id: "route-branch-forward",
      props: {
        ...baseRoute.props,
        topologyRouteRelation: "branch",
        topologyRouteDirection: "one-way",
      },
    };
    const branchBack = {
      ...baseRoute,
      id: "route-branch-back",
      points: [baseRoute.points[1]!, baseRoute.points[0]!],
      props: {
        ...baseRoute.props,
        sourceNodeId: "node-right",
        targetNodeId: "node-left",
        topologyRouteRelation: "branch",
        topologyRouteDirection: "one-way",
      },
    };
    const next = {
      ...document,
      features: [...document.features, duplicate, branchForward, branchBack],
    };

    expect(getTopologyInvalidRouteDiagnostics(next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: expect.objectContaining({ id: "route-duplicate" }),
          reason: "duplicate-route",
        }),
        expect.objectContaining({
          route: expect.objectContaining({ id: "route-branch-forward" }),
          reason: "branch-cycle",
        }),
        expect.objectContaining({
          route: expect.objectContaining({ id: "route-branch-back" }),
          reason: "branch-cycle",
        }),
      ]),
    );
    expect(
      buildTopologyElements(next, null).edges.map((edge) => edge.id),
    ).toEqual(["route-1"]);
    expect(getTopologySummary(next)).toMatchObject({
      routeCount: 1,
      invalidRouteCount: 3,
    });
  });

  it("为分支通道提供父子节点统计，并拒绝新建分支环路", () => {
    const document = topologyDocument();
    const branch = createTopologyEdgeFeature({
      id: "route-branch",
      layerId: "layer-main",
      connection: { source: "node-left", target: "node-right" },
      document,
      relation: "branch",
      direction: "one-way",
    });
    expect(branch).not.toBeNull();
    const next = { ...document, features: [...document.features, branch!] };
    expect(getTopologyNodeConnections(next, "node-left")).toMatchObject({
      parentCount: 0,
      childCount: 1,
    });
    expect(getTopologyNodeConnections(next, "node-right")).toMatchObject({
      parentCount: 1,
      childCount: 0,
    });
    expect(
      createTopologyEdgeFeature({
        id: "route-cycle",
        layerId: "layer-main",
        connection: { source: "node-right", target: "node-left" },
        document: next,
        relation: "branch",
        direction: "one-way",
      }),
    ).toBeNull();
  });

  it("重连、反转和检查器改关系时都拒绝生成重复通道", () => {
    const current = topologyDocument();
    const third = createTopologyNodeFeature({
      id: "node-third",
      layerId: "layer-main",
      point: { x: 900, y: 620 },
    });
    const alternateRoute = createTopologyEdgeFeature({
      id: "route-alternate",
      layerId: "layer-main",
      connection: { source: "node-left", target: third.id },
      document: { ...current, features: [...current.features, third] },
    })!;
    const withAlternate = {
      ...current,
      features: [...current.features, third, alternateRoute],
    };
    expect(
      reconnectTopologyEdge(withAlternate, "route-1", {
        sourceNodeId: "node-left",
        targetNodeId: third.id,
      }),
    ).toBeNull();

    const oneWay = createTopologyEdgeFeature({
      id: "route-one-way",
      layerId: "layer-main",
      connection: { source: "node-left", target: "node-right" },
      document: current,
      direction: "one-way",
    })!;
    const reverseCollision = {
      ...current,
      features: [
        ...current.features.filter((feature) => feature.id !== "route-1"),
        oneWay,
        {
          ...oneWay,
          id: "route-reverse-target",
          points: [
            current.features.find((feature) => feature.id === "node-right")!
              .points[0]!,
            current.features.find((feature) => feature.id === "node-left")!
              .points[0]!,
          ],
          props: {
            ...oneWay.props,
            sourceNodeId: "node-right",
            targetNodeId: "node-left",
          },
        },
      ],
    };
    expect(reverseTopologyEdge(reverseCollision, "route-one-way")).toBeNull();

    expect(
      updateTopologyRoute(withAlternate, "route-1", {
        relation: "passage",
        direction: "two-way",
      }),
    ).toBe(withAlternate);
    const routePortal = createTopologyEdgeFeature({
      id: "route-portal-existing",
      layerId: "layer-main",
      connection: { source: "node-left", target: "node-right" },
      document: current,
      relation: "portal",
    })!;
    expect(
      updateTopologyRoute(
        { ...current, features: [...current.features, routePortal] },
        "route-1",
        { relation: "portal" },
      ),
    ).toBeNull();
  });

  it("移动节点时原子更新关联路线端点", () => {
    const moved = moveTopologyNode(topologyDocument(), "node-left", {
      x: 260,
      y: 280,
    });

    expect(
      moved.features.find((feature) => feature.id === "node-left")?.points,
    ).toEqual([{ x: 260, y: 280 }]);
    expect(
      moved.features.find((feature) => feature.id === "route-1")?.points,
    ).toEqual([
      { x: 260, y: 280 },
      { x: 580, y: 340 },
    ]);
  });

  it("批量移动节点时一次性重建全部关联路线端点", () => {
    const moved = moveTopologyNodes(topologyDocument(), [
      { id: "node-left", point: { x: 180, y: 240 } },
      { id: "node-right", point: { x: 760, y: 520 } },
    ]);

    expect(
      moved.features.find((feature) => feature.id === "route-1")?.points,
    ).toEqual([
      { x: 180, y: 240 },
      { x: 760, y: 520 },
    ]);
    expect(mapDocumentSchema.parse(moved)).toEqual(moved);
  });

  it("拒绝把非有限坐标写入节点和关联路线", () => {
    const current = topologyDocument();
    const next = moveTopologyNodes(current, [
      { id: "node-left", point: { x: Number.NaN, y: 280 } },
      { id: "node-right", point: { x: 760, y: Number.POSITIVE_INFINITY } },
    ]);

    expect(next).toBe(current);
    expect(mapDocumentSchema.parse(next)).toEqual(current);
  });

  it("自动布局按通道方向重排节点，并同步所有路线端点", () => {
    const current = topologyDocument();
    const arranged = arrangeTopologyNodes(current, "vertical");
    const left = arranged.features.find(
      (feature) => feature.id === "node-left",
    )!;
    const right = arranged.features.find(
      (feature) => feature.id === "node-right",
    )!;
    const route = arranged.features.find(
      (feature) => feature.id === "route-1",
    )!;

    expect(left.points[0]).not.toEqual(current.features[0]?.points[0]);
    expect(route.points).toEqual([left.points[0], right.points[0]]);
    expect(mapDocumentSchema.parse(arranged)).toEqual(arranged);
  });

  it("重连通道时同时替换端点引用和绘制控制点", () => {
    const current = topologyDocument();
    const third = createTopologyNodeFeature({
      id: "node-third",
      layerId: "layer-main",
      point: { x: 900, y: 620 },
    });
    const document = { ...current, features: [...current.features, third] };
    const reconnected = reconnectTopologyEdge(document, "route-1", {
      sourceNodeId: "node-left",
      targetNodeId: "node-third",
    });

    expect(
      reconnected?.features.find((feature) => feature.id === "route-1"),
    ).toMatchObject({
      props: { sourceNodeId: "node-left", targetNodeId: "node-third" },
      points: [
        { x: 120, y: 180 },
        { x: 900, y: 620 },
      ],
    });
    expect(
      reconnectTopologyEdge(document, "route-1", {
        sourceNodeId: "node-left",
        targetNodeId: "node-left",
      }),
    ).toBeNull();
    expect(mapDocumentSchema.parse(reconnected!)).toEqual(reconnected);
  });

  it("节点移出任意边缘后由统一画布边界扩展并保持连接端点同步", () => {
    const moved = moveTopologyNode(topologyDocument(), "node-left", {
      x: -40,
      y: -20,
    });
    const expanded = expandMapCanvasToContent(moved);

    // 拓扑节点本体、标签和路线默认线宽都会计入内容外沿。
    expect(expanded.canvas).toMatchObject({ width: 1_848, height: 1_230 });
    expect(
      expanded.features.find((feature) => feature.id === "node-left")?.points,
    ).toEqual([{ x: 208, y: 210 }]);
    expect(
      expanded.features.find((feature) => feature.id === "route-1")?.points,
    ).toEqual([
      { x: 208, y: 210 },
      { x: 828, y: 570 },
    ]);
  });

  it("删除节点时清理关联路线", () => {
    const removed = removeTopologyFeature(topologyDocument(), "node-left");
    expect(removed.features.map((feature) => feature.id)).toEqual([
      "node-right",
    ]);
  });

  it("删除未锁定节点时不会留下指向锁定节点的悬空通道", () => {
    const document = topologyDocument();
    const lockedTarget = {
      ...document.features.find((feature) => feature.id === "node-right")!,
      props: {
        ...document.features.find((feature) => feature.id === "node-right")!
          .props,
        topologyNodeLocked: "true",
      },
    };
    const lockedDocument = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === lockedTarget.id ? lockedTarget : feature,
      ),
    };

    const removed = removeTopologyFeature(lockedDocument, "node-left");
    expect(removed).toBe(lockedDocument);
    expect(removed.features.map((feature) => feature.id)).toEqual([
      "node-left",
      "node-right",
      "route-1",
    ]);
    expect(mapDocumentSchema.parse(removed)).toEqual(removed);
    expect(removeTopologyFeature(lockedDocument, "route-1")).toBe(
      lockedDocument,
    );
  });

  it("批量删除节点时级联清理所有关联路线", () => {
    const removed = removeTopologyFeatures(topologyDocument(), [
      "node-left",
      "node-right",
    ]);
    expect(removed.features).toEqual([]);
    expect(mapDocumentSchema.parse(removed)).toEqual(removed);
  });

  it("复制节点组时保留组内通道并重映射到副本节点", () => {
    const duplicated = duplicateTopologyFeatures(topologyDocument(), [
      "node-left",
      "node-right",
    ]);
    const copiedRoute = duplicated.map.features.find(
      (feature) => feature.id === "route-1-copy",
    );

    expect(duplicated.duplicatedIds).toEqual([
      "node-left-copy",
      "node-right-copy",
      "route-1-copy",
    ]);
    expect(copiedRoute).toMatchObject({
      props: {
        sourceNodeId: "node-left-copy",
        targetNodeId: "node-right-copy",
      },
      points: [
        { x: 138, y: 198 },
        { x: 598, y: 358 },
      ],
    });
    expect(mapDocumentSchema.parse(duplicated.map)).toEqual(duplicated.map);
  });

  it("复制单条通道时不制造重复拓扑事实", () => {
    const document = topologyDocument();
    const duplicated = duplicateTopologyFeatures(document, ["route-1"]);

    expect(duplicated.map).toBe(document);
    expect(duplicated.duplicatedIds).toEqual([]);
  });

  it("拓扑地图拒绝缺少有效端点的通道事实", () => {
    const document = topologyDocument();
    const invalid = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === "route-1"
          ? {
              ...feature,
              props: { ...feature.props, targetNodeId: "missing" },
            }
          : feature,
      ),
    };

    expect(mapDocumentSchema.safeParse(invalid).success).toBe(false);
  });

  it("节点锁定会同时阻止移动、连线和相邻节点创建", () => {
    const document = topologyDocument();
    const locked = {
      ...document.features.find((feature) => feature.id === "node-left")!,
      props: {
        ...document.features.find((feature) => feature.id === "node-left")!
          .props,
        topologyNodeLocked: "true",
      },
    };
    const next = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === locked.id ? locked : feature,
      ),
    };

    expect(getTopologyNodeLocked(locked)).toBe(true);
    expect(canEditTopologyNodes(next, [locked.id])).toBe(false);
    expect(canConnectTopologyNodes(next, locked.id, "node-right")).toBe(false);
    expect(moveTopologyNode(next, locked.id, { x: 900, y: 900 })).toBe(next);
    expect(
      createConnectedTopologyNode(next, {
        anchorNodeId: locked.id,
        nodeId: "node-child",
        edgeId: "route-child",
        direction: "outgoing",
        point: { x: 900, y: 900 },
      }),
    ).toBeNull();
    expect(removeTopologyFeature(next, locked.id)).toBe(next);
    expect(duplicateTopologyFeatures(next, [locked.id]).map).toBe(next);
    expect(buildTopologyElements(next, null).nodes[0]).toMatchObject({
      draggable: false,
      connectable: false,
      data: { locked: true, nodeLocked: true },
    });
  });

  it("拓扑节点标签默认显示且明确关闭后可被画布语义读取", () => {
    const document = topologyDocument();
    const node = document.features.find(
      (feature) => feature.id === "node-left",
    )!;
    expect(topologyNodeLabelVisible(node)).toBe(true);
    expect(
      topologyNodeLabelVisible({
        ...node,
        props: { ...node.props, showLabel: "false" },
      }),
    ).toBe(false);
    expect(buildTopologyElements(document, null).nodes[0]?.data.showLabel).toBe(
      true,
    );
    expect(buildTopologyElements(document, null).nodes[0]?.dragHandle).toBe(
      ".topology-node-drag-handle",
    );
  });
});
