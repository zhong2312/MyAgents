import type { Node } from "@xyflow/react";

import type { CanvasNode } from "../data-access/inspirationBoard";

export interface InspirationFlowNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly kind: CanvasNode["kind"];
  readonly entityId: string | null;
  readonly width: number;
  readonly height: number;
}

export type InspirationFlowNode = Node<InspirationFlowNodeData>;

export function toInspirationFlowNode(node: CanvasNode): InspirationFlowNode {
  return {
    id: node.id,
    position: { x: node.x, y: node.y },
    data: {
      label: node.label,
      kind: node.kind,
      entityId: node.entityId,
      width: node.width,
      height: node.height,
    },
    style: { width: node.width, height: node.height },
  };
}

export function toCanvasNode(node: InspirationFlowNode): CanvasNode {
  return {
    id: node.id,
    kind: node.data.kind,
    entityId: node.data.entityId,
    label: node.data.label,
    x: node.position.x,
    y: node.position.y,
    width: node.data.width,
    height: node.data.height,
  };
}
