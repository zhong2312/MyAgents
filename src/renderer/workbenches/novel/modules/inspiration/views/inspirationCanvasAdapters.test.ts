import { describe, expect, it } from "vitest";

import {
  toCanvasNode,
  toInspirationFlowNode,
} from "./inspirationCanvasAdapters";

describe("灵感画布节点适配", () => {
  it("往返转换时保留实体引用和节点尺寸", () => {
    const node = {
      id: "node-idea",
      kind: "inspiration" as const,
      entityId: "inspiration-idea",
      label: "雨夜相逢",
      x: 120,
      y: 80,
      width: 280,
      height: 180,
    };

    const flowNode = toInspirationFlowNode(node);
    expect(flowNode.data).toEqual({
      label: "雨夜相逢",
      kind: "inspiration",
      entityId: "inspiration-idea",
      width: 280,
      height: 180,
    });
    expect(toCanvasNode(flowNode)).toEqual(node);
  });
});
