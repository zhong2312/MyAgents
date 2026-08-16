import { describe, expect, it } from "vitest";

import {
  buildWorldProposalAgentInstructions,
  parseWorldProposalManifest,
  worldProposalSnapshotPath,
} from "./worldProposalSchema";

const VALID_MANIFEST = {
  schemaVersion: 1,
  proposalId: "first-world-draft",
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
      targetPath: "world/setting-library/spatial-tree.json",
      operation: "modify",
      summary: "更新空间树",
      status: "pending",
    },
  ],
};

describe("worldProposalSchema", () => {
  it("parses a Git-friendly proposal manifest and derives snapshot paths", () => {
    const manifest = parseWorldProposalManifest(
      JSON.stringify(VALID_MANIFEST),
      "proposal.json",
    );
    expect(manifest.proposalId).toBe("first-world-draft");
    expect(
      worldProposalSnapshotPath(
        manifest.proposalId,
        "after",
        manifest.changes[0]!.targetPath,
      ),
    ).toBe(
      "world/setting-library/proposals/first-world-draft/after/spatial-tree.json",
    );
  });

  it("rejects traversal, unsupported files and duplicate targets", () => {
    expect(() =>
      parseWorldProposalManifest(
        JSON.stringify({
          ...VALID_MANIFEST,
          changes: [
            ...VALID_MANIFEST.changes,
            {
              ...VALID_MANIFEST.changes[0],
              id: "duplicate-tree",
            },
          ],
        }),
        "proposal.json",
      ),
    ).toThrow("重复修改同一个目标文件");
    expect(() =>
      parseWorldProposalManifest(
        JSON.stringify({
          ...VALID_MANIFEST,
          changes: [
            {
              ...VALID_MANIFEST.changes[0],
              targetPath: "world/setting-library/proposals/escape.json",
            },
          ],
        }),
        "proposal.json",
      ),
    ).toThrow("提案只能修改设定库");
  });

  it("向世界架构 Agent 提供增量 settings 与成对路径契约", () => {
    const instructions = buildWorldProposalAgentInstructions();

    expect(instructions).toContain("novel_world_patch_draft_changes");
    expect(instructions).toContain("未修改条目由工具保留");
    expect(instructions).toContain(
      "id`、`nodeId`、`templateId`、`name`、`group`、`status`、`pagePath`、`entriesPath",
    );
    expect(instructions).toContain(
      "world/setting-library/pages/great-universe/page-great-universe-universe-overview.md",
    );
    expect(instructions).toContain(
      "world/setting-library/entries/great-universe/page-great-universe-universe-overview.json",
    );
    expect(instructions).toContain("严禁把 Markdown");
    expect(instructions).toContain('"source": "project"');
    expect(instructions).toContain("严禁使用 `custom`");
    expect(instructions).toContain("只有 `valid=true`");
  });
});
