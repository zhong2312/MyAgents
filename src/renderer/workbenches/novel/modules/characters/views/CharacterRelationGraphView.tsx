import { useMemo } from "react";

import ForceGraphView, {
  type ForceGraphEdge,
  type ForceGraphNode,
} from "../../../shared/views/ForceGraphView";

type CharacterRoleWeight = "main" | "secondary" | "npc" | "extra";

interface CharacterGraphRelation {
  readonly targetId: string;
  readonly type: string;
  readonly summary: string;
}

export interface CharacterRelationGraphCharacter {
  readonly id: string;
  readonly name: string;
  readonly roleWeight: CharacterRoleWeight;
  readonly archetype: string;
  readonly storyRole: string;
  readonly summary: string;
  readonly relations: readonly CharacterGraphRelation[];
}

interface CharacterRelationGraphViewProps {
  readonly characters: readonly CharacterRelationGraphCharacter[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
}

const ROLE_LABELS: Readonly<Record<CharacterRoleWeight, string>> =
  Object.freeze({
    main: "主要角色",
    secondary: "次要角色",
    npc: "NPC",
    extra: "路人",
  });

const ROLE_COLORS: Readonly<Record<CharacterRoleWeight, string>> =
  Object.freeze({
    main: "#e0935a",
    secondary: "#7aa2d8",
    npc: "#8fbf8f",
    extra: "#a8a29e",
  });

export default function CharacterRelationGraphView({
  characters,
  selectedId,
  onSelect,
}: CharacterRelationGraphViewProps) {
  const nodes = useMemo<readonly ForceGraphNode[]>(
    () =>
      characters.map((character) => ({
        id: character.id,
        label: character.name,
        kind: character.roleWeight,
        description: [
          character.archetype,
          character.storyRole,
          character.summary,
        ]
          .filter(Boolean)
          .join("\n"),
      })),
    [characters],
  );
  const edges = useMemo<readonly ForceGraphEdge[]>(
    () =>
      characters.flatMap((character) =>
        character.relations.map((relation, index) => ({
          id: `${character.id}:${relation.targetId}:${index}`,
          from: character.id,
          to: relation.targetId,
          label: relation.type || "人物关系",
          description: relation.summary,
        })),
      ),
    [characters],
  );
  const resolvedSelectedId = characters.some(
    (character) => character.id === selectedId,
  )
    ? selectedId
    : (characters[0]?.id ?? "");

  return (
    <ForceGraphView
      nodes={nodes}
      edges={edges}
      selectedId={resolvedSelectedId}
      onSelect={onSelect}
      kindLabels={ROLE_LABELS}
      nodeColors={ROLE_COLORS}
      ariaLabel="人物关系图谱（方向键选择人物，回车查看详情）"
      detailsTitle="人物详情与关系"
      detailsPosition="left"
      emptyDetailsText="点击图谱中的人物查看详情；双击人物以其为中心展开直接关系。"
    />
  );
}
