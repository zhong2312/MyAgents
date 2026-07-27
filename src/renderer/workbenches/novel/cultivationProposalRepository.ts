import type { WorkbenchStorage } from "@/workbench-sdk";

import type {
  FileProposal,
  FileProposalChange,
  FileProposalLoadError,
  FileProposalRepository,
} from "./WorldProposalReview";
import {
  CULTIVATION_ECOLOGY_PATH,
  CULTIVATION_PROPOSALS_DIRECTORY,
  cultivationProposalManifestPath,
  cultivationProposalSnapshotPath,
  cultivationProposalManifestSchema,
  type CultivationProposalManifest,
  serializeCultivationProposalManifest,
} from "./cultivationProposalSchema";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [entry] = await storage.stat([path]);
  return entry?.exists ? (await storage.readText(path)).content : null;
}

function proposalStatus(change: FileProposalChange): FileProposal["manifest"]["changes"][number]["status"] {
  return change.status;
}

export function createNovelCultivationProposalRepository(
  storage: WorkbenchStorage,
): FileProposalRepository {
  const load = async (proposalId: string): Promise<FileProposal> => {
    const manifestPath = cultivationProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const parsed = cultivationProposalManifestSchema.safeParse(
      JSON.parse(manifestFile.content),
    );
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("；"),
      );
    }
    const manifest: CultivationProposalManifest = parsed.data;
    if (manifest.proposalId !== proposalId)
      throw new Error("提案目录与 proposalId 不一致");
    const change = manifest.changes[0];
    const beforeContent =
      (await readOptional(
        storage,
        cultivationProposalSnapshotPath(proposalId, "before"),
      )) ?? "";
    const afterContent =
      (await readOptional(
        storage,
        cultivationProposalSnapshotPath(proposalId, "after"),
      )) ?? "";
    const currentContent = await readOptional(storage, CULTIVATION_ECOLOGY_PATH);
    const loadedChange: FileProposalChange = {
      id: change.id,
      targetPath: change.targetPath,
      operation: change.operation,
      summary: change.summary,
      status: change.status,
      beforeContent,
      afterContent,
      conflict:
        change.status === "pending" && currentContent !== beforeContent,
      loadError:
        beforeContent && afterContent ? null : "提案快照缺失",
    };
    return {
      manifest: {
        proposalId: manifest.proposalId,
        title: manifest.title,
        description: manifest.description,
        createdAt: manifest.createdAt,
        changes: manifest.changes.map((item) => ({
          status: proposalStatus(loadedChange),
        })),
      },
      changes: [loadedChange],
    };
  };

  const updateStatus = async (
    proposalId: string,
    status: "applied" | "rejected",
  ): Promise<FileProposal> => {
    const manifestPath = cultivationProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const parsed = cultivationProposalManifestSchema.parse(
      JSON.parse(manifestFile.content),
    );
    if (parsed.changes[0].status !== "pending")
      throw new Error("已处理的修行体系提案不能重复操作");
    const next: CultivationProposalManifest = {
      ...parsed,
      changes: [{ ...parsed.changes[0], status }],
    };
    await storage.writeText(manifestPath, serializeCultivationProposalManifest(next), {
      expectedContent: manifestFile.content,
    });
    return load(proposalId);
  };

  return {
    async list() {
      const [directory] = await storage.stat([CULTIVATION_PROPOSALS_DIRECTORY]);
      if (!directory?.exists)
        return { proposals: [] as FileProposal[], errors: [] as FileProposalLoadError[] };
      const entries = await storage.list(CULTIVATION_PROPOSALS_DIRECTORY);
      const proposalEntries = entries.filter((entry) => entry.kind === "directory");
      const settled = await Promise.allSettled(
        proposalEntries.map((entry) => load(entry.name)),
      );
      const proposals: FileProposal[] = [];
      const errors: FileProposalLoadError[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") proposals.push(result.value);
        else
          errors.push({
            proposalId: proposalEntries[index]?.name ?? "unknown",
            message: errorMessage(result.reason),
          });
      });
      proposals.sort(
        (left, right) =>
          Date.parse(right.manifest.createdAt) -
          Date.parse(left.manifest.createdAt),
      );
      return { proposals, errors };
    },
    async deleteProposals(proposalIds) {
      for (const proposalId of new Set(proposalIds))
        await storage.remove(`${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
    },
    async apply(proposalId, changeIds) {
      if (changeIds.length !== 1) throw new Error("修行体系提案只能应用一项快照变更");
      const proposal = await load(proposalId);
      const change = proposal.changes[0];
      if (
        change.id !== changeIds[0] ||
        change.status !== "pending" ||
        change.conflict ||
        change.loadError
      )
        throw new Error(change.conflict ? "修行生态事实源已变化，无法应用提案" : "提案变更不可应用");
      await storage.writeText(CULTIVATION_ECOLOGY_PATH, change.afterContent, {
        expectedContent: change.beforeContent,
      });
      return updateStatus(proposalId, "applied");
    },
    async reject(proposalId, changeIds) {
      if (changeIds.length !== 1) throw new Error("修行体系提案只能拒绝一项快照变更");
      const proposal = await load(proposalId);
      if (proposal.changes[0].id !== changeIds[0]) throw new Error("提案变更不存在");
      return updateStatus(proposalId, "rejected");
    },
    async delete(proposalId, changeIds) {
      if (changeIds.length !== 1) throw new Error("修行体系提案只能删除一项快照变更");
      const proposal = await load(proposalId);
      if (proposal.changes[0].id !== changeIds[0]) throw new Error("提案变更不存在");
      await storage.remove(`${CULTIVATION_PROPOSALS_DIRECTORY}/${proposalId}`, {
        permanent: true,
      });
      return null;
    },
  };
}

