import type { ForceGraphNode } from "../../../shared/views/ForceGraphView";
import ForceGraphView from "../../../shared/views/ForceGraphView";

import {
  type KnowledgeEdge,
  type KnowledgeNode,
  type KnowledgeSourceRef,
} from "../business/knowledgeGraph";

const KIND_LABELS: Readonly<Record<KnowledgeNode["kind"], string>> =
  Object.freeze({
    entity: "实体",
    setting: "设定",
    entry: "词条",
    heading: "正文标题",
    fact: "事实",
  });

const NODE_COLORS: Readonly<Record<KnowledgeNode["kind"], string>> =
  Object.freeze({
    entity: "#e0935a",
    setting: "#7aa2d8",
    entry: "#8fbf8f",
    heading: "#b89ad8",
    fact: "#d8b07a",
  });

interface KnowledgeGraphViewProps {
  readonly nodes: readonly KnowledgeNode[];
  readonly edges: readonly KnowledgeEdge[];
  readonly selectedId: string;
  readonly onSelect: (nodeId: string) => void;
  readonly onOpenSource: (source: KnowledgeSourceRef) => void;
}

/** 知识图谱领域适配器；布局与交互由小说工作台共享图谱组件负责。 */
export default function KnowledgeGraphView({
  nodes,
  edges,
  selectedId,
  onSelect,
  onOpenSource,
}: KnowledgeGraphViewProps) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  return (
    <ForceGraphView
      nodes={nodes}
      edges={edges}
      selectedId={selectedId}
      onSelect={onSelect}
      kindLabels={KIND_LABELS}
      nodeColors={NODE_COLORS}
      ariaLabel="知识图谱视图（方向键选择节点，回车查看详情）"
      interactionHint="单击/方向键选中 · 双击设为中心 · 拖拽调整 · 列表视图可用键盘完整操作"
      openNodeLabel="编辑来源"
      canOpenNode={(node) =>
        (nodeById.get(node.id)?.sourceRefs.length ?? 0) > 0
      }
      onOpenNode={(node: ForceGraphNode) => {
        const source = nodeById.get(node.id)?.sourceRefs[0];
        if (source) onOpenSource(source);
      }}
    />
  );
}

export { Loader2 } from "lucide-react";
