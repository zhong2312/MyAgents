import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/workbench-sdk/DiffViewer", () => ({
  default: ({
    original,
    modified,
    renderSideBySide,
  }: {
    original: string;
    modified: string;
    renderSideBySide: boolean;
  }) => (
    <div
      data-testid="monaco-diff-viewer"
      data-original={original}
      data-modified={modified}
      data-side-by-side={String(renderSideBySide)}
    />
  ),
}));

import { createNovelSettingLibraryRepository } from "./settingLibraryRepository";
import { createEmptyNovelStorage } from "./testStorage";
import WorldProposalReview from "./WorldProposalReview";
import {
  serializeWorldProposalManifest,
  worldProposalManifestPath,
  worldProposalSnapshotPath,
  type WorldProposalManifest,
} from "./worldProposalSchema";

async function seedProposal() {
  const storage = createEmptyNovelStorage();
  const library =
    await createNovelSettingLibraryRepository(storage).load("测试小说");
  const proposalId = "first-world-draft";
  const targetPath = "world/setting-library/spatial-tree.json";
  const afterContent = `${JSON.stringify(
    {
      ...library.spatialTree,
      nodes: [
        ...library.spatialTree.nodes,
        {
          id: "first-continent",
          parentId: "world-root",
          name: "第一大陆",
          typeId: "continent",
          order: 1,
        },
      ],
    },
    null,
    2,
  )}\n`;
  const manifest: WorldProposalManifest = {
    schemaVersion: 1,
    proposalId,
    title: "第一版世界架构",
    description: "",
    createdAt: "2026-07-16T08:00:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.world.guide",
      promptVersion: "1.2.0",
    },
    changes: [
      {
        id: "update-tree",
        targetPath,
        operation: "modify",
        summary: "新增第一大陆",
        status: "pending",
      },
    ],
  };
  await storage.createText(
    worldProposalSnapshotPath(proposalId, "before", targetPath),
    library.spatialTreeContent,
    { createParents: true },
  );
  await storage.createText(
    worldProposalSnapshotPath(proposalId, "after", targetPath),
    afterContent,
    { createParents: true },
  );
  await storage.createText(
    worldProposalManifestPath(proposalId),
    serializeWorldProposalManifest(manifest),
    { createParents: true },
  );
  return {
    storage,
    targetPath,
    beforeContent: library.spatialTreeContent,
    afterContent,
  };
}

describe("WorldProposalReview", () => {
  it("reviews snapshots through Monaco and applies the selected file", async () => {
    const { storage, targetPath, beforeContent, afterContent } =
      await seedProposal();
    render(
      <WorldProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "世界架构提案" }),
    ).toBeInTheDocument();
    expect(screen.getByText("第一版世界架构")).toBeInTheDocument();
    const diff = await screen.findByTestId("monaco-diff-viewer");
    expect(diff).toHaveAttribute("data-original", beforeContent);
    expect(diff).toHaveAttribute("data-modified", afterContent);
    expect(diff).toHaveAttribute("data-side-by-side", "true");

    fireEvent.click(screen.getByRole("button", { name: "行内" }));
    expect(diff).toHaveAttribute("data-side-by-side", "false");
    fireEvent.click(screen.getByRole("button", { name: "应用选中" }));

    await waitFor(() => {
      expect(storage.getText(targetPath)).toBe(afterContent);
      expect(screen.getAllByText("已应用").length).toBeGreaterThan(0);
    });
  });

  it("allows a conflicted pending change to be selected and rejected", async () => {
    const { storage, targetPath } = await seedProposal();
    storage.setExternalText(targetPath, "人工修改后的空间树\n");
    render(
      <WorldProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={vi.fn()}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "选择变更 新增第一大陆",
    });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.getByRole("button", { name: "应用选中" })).toBeDisabled();

    fireEvent.click(checkbox);
    const rejectButton = screen.getByRole("button", { name: "拒绝选中" });
    expect(rejectButton).toBeEnabled();
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(screen.getAllByText("已拒绝").length).toBeGreaterThan(0);
    });
    expect(storage.getText(targetPath)).toBe("人工修改后的空间树\n");
  });

  it("keeps malformed proposals visible beside valid proposals", async () => {
    const { storage } = await seedProposal();
    await storage.createText(
      worldProposalManifestPath("broken-proposal"),
      "{ invalid json\n",
      { createParents: true },
    );
    render(
      <WorldProposalReview
        storage={storage}
        projectTitle="测试小说"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("第一版世界架构")).toBeInTheDocument();
    expect(screen.getByText("broken-proposal")).toBeInTheDocument();
  });
});
