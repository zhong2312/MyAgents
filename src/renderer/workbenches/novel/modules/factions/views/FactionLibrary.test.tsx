import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/workbench-sdk/DiffViewer", () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div
      data-testid="faction-diff-viewer"
      data-original={original}
      data-modified={modified}
    />
  ),
}));

import { createEmptyNovelStorage } from "../../../testStorage";
import { createNovelFactionLibraryRepository } from "../data-access/factionLibraryRepository";
import {
  factionProposalManifestPath,
  serializeFactionProposalManifest,
  type FactionProposalManifest,
} from "../entities/factionProposalSchema";
import type { FactionRecord } from "../entities/factionLibrarySchema";
import FactionLibrary from "./FactionLibrary";

function faction(): FactionRecord {
  return {
    id: "faction-qingyun",
    name: "青云宗",
    type: "宗门",
    status: "active",
    summary: "东境宗门",
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function proposal(): FactionProposalManifest {
  return {
    schemaVersion: 1,
    proposalId: "proposal-first-faction",
    title: "首批势力",
    description: "",
    createdAt: "2026-08-10T00:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.factions.assist",
      promptVersion: "1.0.0",
    },
    operations: [
      {
        candidateId: "candidate-qingyun",
        kind: "faction",
        action: "create",
        summary: "新建青云宗",
        value: faction(),
        status: "pending",
      },
    ],
  };
}

describe("FactionLibrary 势力提案入口", () => {
  it("空势力库也能打开审阅器并批量采纳首份提案", async () => {
    const storage = createEmptyNovelStorage();
    const manifest = proposal();
    await storage.createText(
      factionProposalManifestPath(manifest.proposalId),
      serializeFactionProposalManifest(manifest),
      { createParents: true },
    );

    render(
      <FactionLibrary storage={storage} projectTitle="测试小说" isActive />,
    );

    const reviewButton = await screen.findByRole("button", {
      name: "审阅势力提案",
    });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);

    expect(
      await screen.findByRole("heading", { name: "势力组织提案" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("checkbox", { name: "全选待处理变更" }),
    ).toBeChecked();
    const diff = await screen.findByTestId("faction-diff-viewer");
    expect(diff).toHaveAttribute(
      "data-modified",
      `${JSON.stringify(faction(), null, 2)}\n`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "应用选中" }));

    await waitFor(async () => {
      const loaded = await createNovelFactionLibraryRepository(storage).load();
      expect(loaded.library.factions.map((item) => item.id)).toEqual([
        "faction-qingyun",
      ]);
    });
  });
});
