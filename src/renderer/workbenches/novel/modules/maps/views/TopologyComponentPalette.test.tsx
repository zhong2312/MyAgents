import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TopologyComponentPalette from "./TopologyComponentPalette";
import { TOPOLOGY_NODE_DRAG_MIME } from "../business/topologyMap";

describe("拓扑构件库", () => {
  it("展示节点和关系预设，并把选择交给编辑器", () => {
    const onNodePreset = vi.fn();
    const onRoutePreset = vi.fn();
    render(
      <TopologyComponentPalette
        disabled={false}
        nodeCount={3}
        routeCount={2}
        isolatedNodeCount={1}
        invalidRouteCount={0}
        activeNodeKind="world"
        activeRouteRelation="passage"
        activeRouteDirection="two-way"
        onNodePreset={onNodePreset}
        onRoutePreset={onRoutePreset}
      />,
    );

    expect(screen.getByText("节点 3")).toBeInTheDocument();
    expect(screen.getByText("通道 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放置星球节点" }));
    fireEvent.click(screen.getByRole("button", { name: "使用世界分支" }));
    fireEvent.click(
      screen.getByRole("button", { name: "展开更多拓扑节点类型" }),
    );

    expect(onNodePreset).toHaveBeenCalledWith("planet");
    expect(onRoutePreset).toHaveBeenCalledWith("branch", "one-way");
    expect(
      screen.getByRole("button", { name: "放置星系节点" }),
    ).toBeInTheDocument();
  });

  it("节点预设拖放时携带完整节点模板", () => {
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
    };
    render(
      <TopologyComponentPalette
        disabled={false}
        nodeCount={0}
        routeCount={0}
        isolatedNodeCount={0}
        invalidRouteCount={0}
        activeNodeKind="world"
        activeRouteRelation="passage"
        activeRouteDirection="two-way"
        topologyNodeTemplate={{
          kind: "planet",
          status: "sealed",
          name: "灰烬星",
          color: "#657b55",
          linkedMapId: "map-planet",
          entityRef: { kind: "setting", id: "setting-planet" },
        }}
        onNodePreset={vi.fn()}
        onRoutePreset={vi.fn()}
      />,
    );

    fireEvent.dragStart(screen.getByRole("button", { name: "放置星球节点" }), {
      dataTransfer,
    });

    expect(dataTransfer.setData).toHaveBeenCalledWith(
      TOPOLOGY_NODE_DRAG_MIME,
      expect.stringContaining('"kind":"planet"'),
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      TOPOLOGY_NODE_DRAG_MIME,
      expect.stringContaining('"name":"灰烬星"'),
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      TOPOLOGY_NODE_DRAG_MIME,
      expect.stringContaining('"status":"sealed"'),
    );
  });

  it("始终显示当前投影正在使用的节点类型", () => {
    render(
      <TopologyComponentPalette
        disabled={false}
        nodeCount={0}
        routeCount={0}
        isolatedNodeCount={0}
        invalidRouteCount={0}
        activeNodeKind="timeline"
        activeRouteRelation="branch"
        activeRouteDirection="one-way"
        onNodePreset={vi.fn()}
        onRoutePreset={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "放置时间分支节点" }),
    ).toBeInTheDocument();
  });
});
