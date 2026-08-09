import { describe, expect, it } from "vitest";

import {
  createEmptyCultivationEcology,
  cultivationEcologySchema,
} from "../../../shared/workbenches/novel/cultivationEcologySchema";
import {
  createCultivationEcologyFiles,
  loadCultivationEcologyFiles,
} from "../../../shared/workbenches/novel/cultivationEcologyStorage";
import { createNovelCultivationProposalRepository } from "./cultivationProposalRepository";
import {
  cultivationProposalManifestPath,
  cultivationProposalSnapshotPath,
  serializeCultivationProposalManifest,
} from "./cultivationProposalSchema";
import { NovelMemoryStorage } from "./shared/infrastructure/testStorage";

describe("修炼体系目录提案仓储", () => {
  it("以一组文件变更应用提案并重新聚合事实源", async () => {
    const before = createEmptyCultivationEcology();
    const after = cultivationEcologySchema.parse({
      ...before,
      updatedAt: "2026-08-09T01:00:00.000Z",
      worldOrigins: [
        {
          id: "origin-1",
          name: "太初",
          summary: "",
          kind: "本源",
          ontologyStatement: "",
          status: "stable",
          scopes: [],
          constraints: [],
          manifestations: [],
          relations: [],
        },
      ],
    });
    const beforeFiles = new Map(
      createCultivationEcologyFiles(before).map((file) => [
        file.path,
        file.content,
      ]),
    );
    const afterFiles = new Map(
      createCultivationEcologyFiles(after).map((file) => [
        file.path,
        file.content,
      ]),
    );
    const changed = [...afterFiles.entries()].filter(
      ([path, content]) => beforeFiles.get(path) !== content,
    );
    const proposalId = "cultivation-proposal-1";
    const changes = changed.map(([targetPath], index) => ({
      id: `change-${index + 1}`,
      targetPath,
      operation: beforeFiles.has(targetPath)
        ? ("modify" as const)
        : ("create" as const),
      summary: "新增世界本源",
      status: "pending" as const,
    }));
    const initialFiles: Record<string, string> =
      Object.fromEntries(beforeFiles);
    initialFiles[cultivationProposalManifestPath(proposalId)] =
      serializeCultivationProposalManifest({
        schemaVersion: 1,
        proposalId,
        title: "新增本源",
        description: "",
        createdAt: "2026-08-09T01:00:00.000Z",
        source: {
          kind: "agent",
          promptId: "novel.cultivation.assist",
          promptVersion: "1.0.0",
        },
        changes,
      });
    for (const change of changes) {
      initialFiles[
        cultivationProposalSnapshotPath(proposalId, "before", change.targetPath)
      ] = beforeFiles.get(change.targetPath) ?? "";
      initialFiles[
        cultivationProposalSnapshotPath(proposalId, "after", change.targetPath)
      ] = afterFiles.get(change.targetPath) ?? "";
    }

    const storage = new NovelMemoryStorage(initialFiles);
    const repository = createNovelCultivationProposalRepository(storage);
    const applied = await repository.apply(
      proposalId,
      changes.map((change) => change.id),
      "测试小说",
    );
    expect(applied.changes.every((change) => change.status === "applied")).toBe(
      true,
    );

    const loaded = await loadCultivationEcologyFiles(
      async (path) => (await storage.readText(path)).content,
    );
    expect(loaded.ecology.worldOrigins).toHaveLength(1);
    expect(loaded.ecology.worldOrigins[0]?.name).toBe("太初");
  });
});
