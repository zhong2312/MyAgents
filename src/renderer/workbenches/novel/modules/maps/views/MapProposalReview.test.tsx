import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MapGenerationPlan } from "../../../../../../shared/workbenches/novel/mapGenerationPlan";
import { NovelMemoryStorage } from "../../../shared/infrastructure/testStorage";
import { createNovelMapRepository } from "../data-access/mapRepository";
import {
  createEmptyMapDocument,
  serializeMapDocument,
} from "../entities/mapSchema";
import { serializeMapProposalManifest } from "../entities/mapProposalSchema";
import MapProposalReview from "./MapProposalReview";

const generationPlan: MapGenerationPlan = {
  schemaVersion: 1,
  styleId: "xuanhuan-zh",
  worldSourceHash: "a".repeat(64),
  scope: {
    worldNodeId: "world",
    nodeIds: ["world"],
    nodePath: "九州",
    generationLevelTypeId: "continent",
    generationLevelName: "大陆",
  },
  azgaar: {
    heightmapTemplate: "east-asia",
    landmassCount: 1,
    regionCount: 3,
    riverCount: 2,
    states: 2,
    cultures: 1,
    religions: 0,
    precipitation: 180,
  },
  spatialLayers: [
    {
      id: "layer-world",
      name: "九州",
      worldNodeId: "world",
      parentId: null,
      levelTypeId: "continent",
      role: "realm",
      zone: "center",
      climate: [],
      terrain: ["平原", "河网"],
      anchor: null,
      notes: "世界核心区域。",
    },
  ],
  entities: [],
  relations: [],
  visual: {
    paperPreset: "parchment",
    labelHierarchy: "balanced",
    borderStyle: "ink",
    reliefStyle: "ink-peaks",
    waterStyle: "indigo-ripple",
    terrainMaterials: ["grassland"],
    ornaments: [],
    notes: "玄幻舆图。",
  },
  rationale: "测试规划。",
};

function draft(phase: "planning" | "visual", title: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    domain: "maps",
    draftId: `draft-${phase}`,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    source: {
      promptId: "novel.maps.fantasy",
      promptVersion: "1.0.0",
      sessionId: "session-map-review",
    },
    validation: null,
    submittedProposalId: null,
    payload: {
      phase,
      title,
      description: "规划审阅内容。",
      generationPlan,
      operations: [],
    },
  });
}

describe("MapProposalReview", () => {
  it("展示待确认规划并隐藏已经进入视觉阶段的草稿", async () => {
    const storage = new NovelMemoryStorage({
      "world/maps/drafts/draft-planning/draft.json": draft(
        "planning",
        "待确认九州规划",
      ),
      "world/maps/drafts/draft-visual/draft.json": draft(
        "visual",
        "已确认九州规划",
      ),
    });

    render(
      <MapProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("地图规划草案")).toBeInTheDocument();
    expect(screen.getByText("待确认九州规划")).toBeInTheDocument();
    expect(screen.queryByText("已确认九州规划")).not.toBeInTheDocument();
    expect(screen.getByText(/会话 session-map-review/u)).toBeInTheDocument();
    expect(screen.getByText(/1 份待确认规划/u)).toBeInTheDocument();
  });

  it("允许作者确认规划并从待确认列表移除", async () => {
    const path = "world/maps/drafts/draft-planning/draft.json";
    const storage = new NovelMemoryStorage({
      [path]: draft("planning", "待确认九州规划"),
    });

    render(
      <MapProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "确认规划" }));

    await waitFor(() => {
      expect(screen.queryByText("待确认九州规划")).not.toBeInTheDocument();
    });
    expect(JSON.parse(storage.getText(path)!)).toMatchObject({
      revision: 2,
      payload: { phase: "visual" },
    });
  });

  it("将 Agent 写入的视觉候选预览、采纳并重载为正式可编辑地图", async () => {
    const candidate = {
      ...createEmptyMapDocument({
        id: "map-agent-visual",
        name: "玄天九域",
        projectionType: "continent",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      features: [
        {
          id: "feature-kunlun",
          kind: "marker" as const,
          name: "昆仑仙脉",
          entityRef: { kind: "setting" as const, id: "world" },
          layerId: "layer-main",
          points: [{ x: 640, y: 300 }],
          timeFrom: null,
          timeTo: null,
          props: {
            showLabel: "true",
            entityRole: "mountain-range",
            component: "mountain-ridge",
          },
          description: "Agent 按世界架构规划生成的主脉。",
        },
      ],
      generation: {
        runtime: "compatibility-adapter" as const,
        generatorAdapter: "fantasy-map-tool",
        plan: generationPlan,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const proposalId = "proposal-agent-visual";
    const candidateId = "candidate-agent-visual";
    const storage = new NovelMemoryStorage({
      [`world/maps/proposals/${proposalId}/proposal.json`]:
        serializeMapProposalManifest({
          schemaVersion: 2,
          proposalId,
          title: "Agent 视觉地图候选",
          description: "已由设定驱动生成器提交。",
          createdAt: "2026-01-01T00:00:00.000Z",
          source: {
            kind: "agent",
            promptId: "novel.maps.fantasy",
            promptVersion: "1.0.0",
            worldSourceHash: "a".repeat(64),
            runtime: "compatibility-adapter",
            generatorAdapter: "fantasy-map-tool",
            generationPlanVersion: 1,
          },
          operations: [
            {
              candidateId,
              kind: "map",
              action: "create",
              summary: "新建玄天九域中文玄幻地图",
              valuePath: `candidates/${candidateId}.json`,
              status: "pending",
            },
          ],
        }),
      [`world/maps/proposals/${proposalId}/candidates/${candidateId}.json`]:
        serializeMapDocument(candidate),
    });
    const onApplied = vi.fn();

    render(
      <MapProposalReview
        storage={storage}
        projectTitle="测试小说"
        onApplied={onApplied}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("玄天九域")).toBeInTheDocument();
    expect(screen.getByText("昆仑仙脉")).toBeInTheDocument();
    expect(screen.getByText(/设定驱动规划/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采纳" }));

    await waitFor(async () => {
      expect(onApplied).toHaveBeenCalledOnce();
      await expect(
        createNovelMapRepository(storage).loadMap("map-agent-visual"),
      ).resolves.toMatchObject({
        map: {
          name: "玄天九域",
          features: [
            expect.objectContaining({
              name: "昆仑仙脉",
              entityRef: { kind: "setting", id: "world" },
            }),
          ],
        },
      });
    });
    expect(
      storage.getText(`world/maps/proposals/${proposalId}/proposal.json`),
    ).toContain('"status": "applied"');
  });
});
