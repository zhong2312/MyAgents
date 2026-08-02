import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import KnowledgeGraphView from "./KnowledgeGraphView";
import type { KnowledgeEdge, KnowledgeNode } from "./knowledgeGraph";

// jsdom 缺少 SVG 几何接口（d3-zoom 依赖），补齐最小实现
const svgProto = SVGElement.prototype as unknown as {
  getBBox?: () => unknown;
};
if (!svgProto.getBBox) {
  Object.defineProperty(svgProto, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
}
Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
  configurable: true,
  value: { baseVal: { x: 0, y: 0, width: 800, height: 500 } },
});

function nodes(count: number): KnowledgeNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    label: `节点${index}`,
    kind: (index % 3 === 0
      ? "entity"
      : index % 3 === 1
        ? "setting"
        : "entry") as KnowledgeNode["kind"],
    description: "",
    aliases: [],
    sourceRefs:
      index === 0
        ? [{ path: "characters/index.json", line: 1 }]
        : ([] as readonly { path: string; line?: number }[]),
  }));
}

function edgesBetween(nodes: KnowledgeNode[]): KnowledgeEdge[] {
  const edges: KnowledgeEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({
      id: `edge-${index}`,
      from: nodes[index - 1].id,
      to: nodes[index].id,
      kind: "mentions",
      label: "提及",
      sourceRefs: [],
    });
  }
  return edges;
}

describe("KnowledgeGraphView（图谱验收）", () => {
  it("渲染 200 个节点并支持点击选中（1 秒内可交互）", async () => {
    const testNodes = nodes(200);
    const testEdges = edgesBetween(testNodes);
    const onSelect = vi.fn();
    const onOpenSource = vi.fn();
    const start = performance.now();

    const { container } = render(
      <KnowledgeGraphView
        nodes={testNodes}
        edges={testEdges}
        selectedId=""
        onSelect={onSelect}
        onOpenSource={onOpenSource}
      />,
    );

    // d3 力导向在 jsdom 中渲染 SVG；等待 tick 完成
    await waitFor(() => {
      expect(container.querySelectorAll("circle").length).toBeGreaterThan(0);
    });

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);

    // 选中节点（检查器显示 label）
    const firstNode = screen.getByText("节点0");
    fireEvent.click(firstNode.closest("g") ?? firstNode);
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("node-0");
    });
  });

  it("超过 200 个节点时显示折叠提示（不渲染全部）", async () => {
    const testNodes = nodes(201);
    const testEdges = edgesBetween(testNodes);
    render(
      <KnowledgeGraphView
        nodes={testNodes}
        edges={testEdges}
        selectedId=""
        onSelect={vi.fn()}
        onOpenSource={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/已折叠到度最高的 200 个节点/)).toBeInTheDocument();
    });
  });

  it("图谱只读：无写盘接口，交互仅触发选择/来源回调", () => {
    // 静态契约：组件仅接收只读 props，不存在 storage 或写路径
    const testNodes = nodes(2);
    const testEdges = edgesBetween(testNodes);
    const onOpenSource = vi.fn();
    render(
      <KnowledgeGraphView
        nodes={testNodes}
        edges={testEdges}
        selectedId="node-0"
        onSelect={vi.fn()}
        onOpenSource={onOpenSource}
      />,
    );
    expect(screen.getByText("编辑来源")).toBeInTheDocument();
    fireEvent.click(screen.getByText("编辑来源"));
    expect(onOpenSource).toHaveBeenCalled();
  });
});
