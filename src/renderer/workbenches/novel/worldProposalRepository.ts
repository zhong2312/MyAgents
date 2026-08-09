import type { WorkbenchStorage } from "@/workbench-sdk";

import type { FileProposalConflictResolution } from "./fileProposal";
import {
  createNovelSettingLibraryRepository,
  SETTING_LIBRARY_PATHS,
  validateSettingLibraryReferences,
  type LoadedSettingLibrary,
} from "./settingLibraryRepository";
import {
  createNovelLocationLibraryRepository,
  type LoadedLocationLibrary,
} from "./modules/locations/data-access/locationLibraryRepository";
import {
  parseLocationLibraryIndex,
  serializeLocationLibraryIndex,
  validateLocationNodeReferences,
} from "./modules/locations/entities/locationLibrarySchema";
import {
  parseSettingEntriesFile,
  parseSettingLibraryMeta,
  parseSettingLibrarySettingsIndex,
  parseSettingLibrarySpatialTree,
  serializeSettingLibraryFile,
  type SettingInstance,
} from "./settingLibrarySchema";
import {
  parseWorldProposalManifest,
  serializeWorldProposalManifest,
  WORLD_PROPOSALS_DIRECTORY,
  WORLD_LOCATION_LIBRARY_PATH,
  worldProposalLegacySnapshotPath,
  worldProposalManifestPath,
  worldProposalSnapshotPath,
  worldProposalTargetPathFromSnapshotRelativePath,
  type WorldProposalChange,
  type WorldProposalManifest,
} from "./worldProposalSchema";

export interface LoadedWorldProposalChange extends WorldProposalChange {
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly currentContent: string | null;
  readonly conflict: boolean;
  readonly loadError: string | null;
  readonly inferred: boolean;
  /** Generated in memory to repair a legacy proposal that omitted settings.json. */
  readonly generated: boolean;
}

export interface LoadedWorldProposal {
  readonly manifest: WorldProposalManifest;
  readonly manifestPath: string;
  readonly manifestContent: string;
  readonly changes: readonly LoadedWorldProposalChange[];
}

export interface WorldProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export interface WorldProposalListResult {
  readonly proposals: readonly LoadedWorldProposal[];
  readonly errors: readonly WorldProposalLoadError[];
}

export type WorldProposalStatus =
  | "pending"
  | "partially-applied"
  | "applied"
  | "rejected";

export interface NovelWorldProposalRepository {
  list(): Promise<WorldProposalListResult>;
  load(proposalId: string): Promise<LoadedWorldProposal>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
  apply(
    proposalId: string,
    changeIds: readonly string[],
    projectTitle: string,
  ): Promise<LoadedWorldProposal>;
  reject(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<LoadedWorldProposal>;
  delete(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<LoadedWorldProposal | null>;
  resolveConflict(
    proposalId: string,
    changeId: string,
    resolution: FileProposalConflictResolution,
    projectTitle: string,
  ): Promise<LoadedWorldProposal>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptionalText(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  const [info] = await storage.stat([path]);
  return info?.exists ? (await storage.readText(path)).content : null;
}

async function readCurrentTargetContent(
  storage: WorkbenchStorage,
  path: string,
): Promise<string | null> {
  if (path !== WORLD_LOCATION_LIBRARY_PATH) {
    return readOptionalText(storage, path);
  }
  const [info] = await storage.stat([WORLD_LOCATION_LIBRARY_PATH]);
  if (!info?.exists) return null;
  const loaded = await createNovelLocationLibraryRepository(storage).load();
  return serializeLocationLibraryIndex(loaded.index);
}

function snapshotRoot(proposalId: string, side: "before" | "after"): string {
  return `${WORLD_PROPOSALS_DIRECTORY}/${proposalId}/${side}`;
}

async function listFilesRecursively(
  storage: WorkbenchStorage,
  directory: string,
): Promise<readonly string[]> {
  const [info] = await storage.stat([directory]);
  if (!info?.exists) return [];
  if (info.kind !== "directory") {
    throw new Error(`提案快照路径不是目录：${directory}`);
  }
  const entries = await storage.list(directory);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.kind === "file"
        ? Promise.resolve([entry.path] as readonly string[])
        : listFilesRecursively(storage, entry.path),
    ),
  );
  return nested.flat();
}

async function readProposalSnapshot(
  storage: WorkbenchStorage,
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): Promise<string> {
  const canonicalPath = worldProposalSnapshotPath(proposalId, side, targetPath);
  const legacyPath = worldProposalLegacySnapshotPath(
    proposalId,
    side,
    targetPath,
  );
  const candidates =
    canonicalPath === legacyPath
      ? [canonicalPath]
      : [canonicalPath, legacyPath];
  const info = await storage.stat(candidates);
  const foundIndex = info.findIndex(
    (entry) => entry.exists && entry.kind === "file",
  );
  if (foundIndex < 0) {
    throw new Error(
      `${side === "before" ? "修改前" : "建议后"}快照不存在：${candidates.join(" 或 ")}`,
    );
  }
  return (await storage.readText(candidates[foundIndex])).content;
}

async function readOptionalProposalSnapshot(
  storage: WorkbenchStorage,
  proposalId: string,
  side: "before" | "after",
  targetPath: string,
): Promise<string | null> {
  try {
    return await readProposalSnapshot(storage, proposalId, side, targetPath);
  } catch {
    return null;
  }
}

function discoveredChangeId(targetPath: string, usedIds: Set<string>): string {
  let hash = 0x811c9dc5;
  for (const character of targetPath) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const base = `discovered-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

async function discoverUnlistedChanges(
  storage: WorkbenchStorage,
  proposalId: string,
  manifest: WorldProposalManifest,
): Promise<readonly WorldProposalChange[]> {
  const root = snapshotRoot(proposalId, "after");
  const files = await listFilesRecursively(storage, root);
  const targets = new Set<string>();
  for (const file of files) {
    const relative = file.slice(root.length + 1);
    targets.add(worldProposalTargetPathFromSnapshotRelativePath(relative));
  }

  const declaredTargets = new Set(
    manifest.changes.map((change) => change.targetPath),
  );
  const usedIds = new Set(manifest.changes.map((change) => change.id));
  const discovered: WorldProposalChange[] = [];
  for (const targetPath of [...targets].sort()) {
    if (declaredTargets.has(targetPath)) continue;
    const [beforeContent, currentContent] = await Promise.all([
      readOptionalProposalSnapshot(storage, proposalId, "before", targetPath),
      readCurrentTargetContent(storage, targetPath),
    ]);
    discovered.push({
      id: discoveredChangeId(targetPath, usedIds),
      targetPath,
      operation:
        beforeContent !== null || currentContent !== null ? "modify" : "create",
      summary: `自动补录 Agent 已生成但未登记的快照：${targetPath.split("/").at(-1)}`,
      status: "pending",
    });
  }
  return discovered;
}

function updateManifestChanges(
  manifest: WorldProposalManifest,
  changeIds: ReadonlySet<string>,
  status: WorldProposalChange["status"],
): WorldProposalManifest {
  return {
    ...manifest,
    changes: manifest.changes.map((change) =>
      changeIds.has(change.id) ? { ...change, status } : change,
    ),
  };
}

function prospectiveLibrary(
  current: LoadedSettingLibrary,
  changes: readonly LoadedWorldProposalChange[],
): LoadedSettingLibrary {
  let next = current;
  for (const change of changes) {
    if (change.targetPath === SETTING_LIBRARY_PATHS.meta) {
      next = {
        ...next,
        meta: parseSettingLibraryMeta(change.afterContent),
        metaContent: change.afterContent,
      };
      continue;
    }
    if (change.targetPath === SETTING_LIBRARY_PATHS.spatialTree) {
      next = {
        ...next,
        spatialTree: parseSettingLibrarySpatialTree(change.afterContent),
        spatialTreeContent: change.afterContent,
      };
      continue;
    }
    if (change.targetPath === SETTING_LIBRARY_PATHS.settings) {
      next = {
        ...next,
        settingsIndex: parseSettingLibrarySettingsIndex(change.afterContent),
        settingsIndexContent: change.afterContent,
      };
      continue;
    }
    if (change.targetPath.startsWith("world/setting-library/entries/")) {
      parseSettingEntriesFile(change.afterContent);
    }
  }
  validateSettingLibraryReferences(next);
  return next;
}

function validateLocationProposalChanges(
  library: LoadedSettingLibrary,
  changes: readonly LoadedWorldProposalChange[],
): void {
  const locationChange = changes.find(
    (change) => change.targetPath === WORLD_LOCATION_LIBRARY_PATH,
  );
  if (!locationChange) return;
  validateLocationNodeReferences(
    parseLocationLibraryIndex(locationChange.afterContent),
    library.spatialTree.nodes.map((node) => node.id),
  );
}

async function loadPersistedSettingLibrary(
  storage: WorkbenchStorage,
): Promise<LoadedSettingLibrary> {
  const [metaFile, spatialTreeFile, settingsFile] = await Promise.all([
    storage.readText(SETTING_LIBRARY_PATHS.meta),
    storage.readText(SETTING_LIBRARY_PATHS.spatialTree),
    storage.readText(SETTING_LIBRARY_PATHS.settings),
  ]);
  const library: LoadedSettingLibrary = Object.freeze({
    meta: parseSettingLibraryMeta(metaFile.content),
    metaContent: metaFile.content,
    spatialTree: parseSettingLibrarySpatialTree(spatialTreeFile.content),
    spatialTreeContent: spatialTreeFile.content,
    settingsIndex: parseSettingLibrarySettingsIndex(settingsFile.content),
    settingsIndexContent: settingsFile.content,
  });
  validateSettingLibraryReferences(library);
  return library;
}

function isMaterializedSettingPath(path: string): boolean {
  return (
    path.startsWith("world/setting-library/pages/") ||
    path.startsWith("world/setting-library/entries/")
  );
}

interface GeneratedSettingsIndexChange {
  readonly change: WorldProposalChange;
  readonly beforeContent: string;
  readonly afterContent: string;
}

function inferMissingSettingsIndexChange(
  library: LoadedSettingLibrary,
  changes: readonly WorldProposalChange[],
): GeneratedSettingsIndexChange | null {
  if (
    changes.some(
      (change) => change.targetPath === SETTING_LIBRARY_PATHS.settings,
    )
  ) {
    return null;
  }

  const referencedPaths = new Set(
    library.settingsIndex.settings.flatMap((setting) => [
      setting.pagePath,
      setting.entriesPath,
    ]),
  );
  const pendingByTarget = new Map(
    changes
      .filter((change) => change.status === "pending")
      .map((change) => [change.targetPath, change] as const),
  );
  const orphanTargets = [...pendingByTarget.keys()].filter(
    (path) => isMaterializedSettingPath(path) && !referencedPaths.has(path),
  );
  if (orphanTargets.length === 0) return null;

  const pairedTargets = new Set<string>();
  const inferredInstances: SettingInstance[] = [];
  const existingSettingIds = new Set(
    library.settingsIndex.settings.map((setting) => setting.id),
  );
  for (const pagePath of orphanTargets.filter((path) =>
    path.startsWith("world/setting-library/pages/"),
  )) {
    const match =
      /^world\/setting-library\/pages\/([a-z0-9-]+)\/([a-z0-9-]+)\.md$/.exec(
        pagePath,
      );
    if (!match) return null;
    const [, nodeId, settingId] = match;
    const entriesPath = `world/setting-library/entries/${nodeId}/${settingId}.json`;
    if (!pendingByTarget.has(entriesPath)) return null;

    const node = library.spatialTree.nodes.find((item) => item.id === nodeId);
    const settingPrefix = `page-${nodeId}-`;
    const templateId = settingId.startsWith(settingPrefix)
      ? settingId.slice(settingPrefix.length)
      : "";
    const template = library.meta.settingTemplates.find(
      (item) => item.id === templateId,
    );
    if (!node || !template || existingSettingIds.has(settingId)) return null;

    inferredInstances.push({
      id: settingId,
      nodeId,
      templateId: template.id,
      name: template.name,
      group: template.group,
      status: "draft",
      pagePath,
      entriesPath,
    });
    existingSettingIds.add(settingId);
    pairedTargets.add(pagePath);
    pairedTargets.add(entriesPath);
  }

  if (
    inferredInstances.length === 0 ||
    orphanTargets.some((path) => !pairedTargets.has(path))
  ) {
    return null;
  }

  const usedIds = new Set(changes.map((change) => change.id));
  const afterContent = serializeSettingLibraryFile({
    ...library.settingsIndex,
    settings: [...library.settingsIndex.settings, ...inferredInstances],
  });
  parseSettingLibrarySettingsIndex(afterContent);
  return {
    change: {
      id: discoveredChangeId(SETTING_LIBRARY_PATHS.settings, usedIds),
      targetPath: SETTING_LIBRARY_PATHS.settings,
      operation: "modify",
      summary: `自动补齐 ${inferredInstances.length} 个页面的设定索引`,
      status: "pending",
    },
    beforeContent: library.settingsIndexContent,
    afterContent,
  };
}

async function persistGeneratedProposalSnapshots(
  storage: WorkbenchStorage,
  proposalId: string,
  changes: readonly LoadedWorldProposalChange[],
): Promise<void> {
  for (const change of changes.filter((item) => item.generated)) {
    const snapshots = [
      ...(change.operation === "modify"
        ? ([
            {
              path: worldProposalSnapshotPath(
                proposalId,
                "before",
                change.targetPath,
              ),
              content: change.beforeContent,
            },
          ] as const)
        : []),
      {
        path: worldProposalSnapshotPath(proposalId, "after", change.targetPath),
        content: change.afterContent,
      },
    ];
    for (const snapshot of snapshots) {
      const existing = await readOptionalText(storage, snapshot.path);
      if (existing === null) {
        await storage.createText(snapshot.path, snapshot.content, {
          createParents: true,
        });
      } else if (existing !== snapshot.content) {
        throw new Error(`自动补录快照已发生变化：${snapshot.path}`);
      }
    }
  }
}

async function removeProposalChangeSnapshots(
  storage: WorkbenchStorage,
  proposalId: string,
  changes: readonly LoadedWorldProposalChange[],
): Promise<void> {
  const paths = new Set<string>();
  for (const change of changes) {
    for (const side of ["before", "after"] as const) {
      if (side === "before" && change.operation === "create") continue;
      paths.add(worldProposalSnapshotPath(proposalId, side, change.targetPath));
      paths.add(
        worldProposalLegacySnapshotPath(proposalId, side, change.targetPath),
      );
    }
  }
  for (const path of paths) {
    const [info] = await storage.stat([path]);
    if (info?.exists) {
      await storage.remove(path, { permanent: true });
    }
  }
}

async function validateMaterializedSettingFiles(
  storage: WorkbenchStorage,
  library: LoadedSettingLibrary,
  selectedChanges: readonly LoadedWorldProposalChange[],
  allowSelectedSnapshots: boolean,
): Promise<void> {
  const referencedPaths = new Set(
    library.settingsIndex.settings.flatMap((setting) => [
      setting.pagePath,
      setting.entriesPath,
    ]),
  );
  const selectedPaths = new Set(
    selectedChanges.map((change) => change.targetPath),
  );

  const orphan = selectedChanges.find(
    (change) =>
      isMaterializedSettingPath(change.targetPath) &&
      !referencedPaths.has(change.targetPath),
  );
  if (orphan) {
    throw new Error(
      `提案文件未被最终 settings.json 引用：${orphan.targetPath}`,
    );
  }

  const pathsToCheck = [...referencedPaths].filter(
    (path) => !allowSelectedSnapshots || !selectedPaths.has(path),
  );
  const pathInfo =
    pathsToCheck.length > 0 ? await storage.stat(pathsToCheck) : [];
  const missingIndex = pathInfo.findIndex(
    (info) => !info.exists || info.kind !== "file",
  );
  if (missingIndex >= 0) {
    throw new Error(
      `最终 settings.json 引用了不存在的设定文件：${pathsToCheck[missingIndex]}`,
    );
  }

  if (!allowSelectedSnapshots) {
    for (const change of selectedChanges) {
      const currentContent = await readCurrentTargetContent(
        storage,
        change.targetPath,
      );
      if (currentContent !== change.afterContent) {
        throw new Error(`提案目标在写入后发生变化：${change.targetPath}`);
      }
    }
  }
}

async function rollbackAppliedChanges(
  storage: WorkbenchStorage,
  changes: readonly LoadedWorldProposalChange[],
): Promise<void> {
  const failures: string[] = [];
  for (const change of [...changes].reverse()) {
    try {
      if (change.targetPath === WORLD_LOCATION_LIBRARY_PATH) {
        const repository = createNovelLocationLibraryRepository(storage);
        const current = await repository.load();
        const currentContent = serializeLocationLibraryIndex(current.index);
        if (currentContent !== change.afterContent) {
          throw new Error("地点库已在回滚前发生变化，已保留当前内容");
        }
        if (change.operation === "create") {
          const paths = [...current.files.keys()].sort((left, right) =>
            left === WORLD_LOCATION_LIBRARY_PATH
              ? 1
              : right === WORLD_LOCATION_LIBRARY_PATH
                ? -1
                : left.localeCompare(right),
          );
          for (const path of paths) {
            await storage.remove(path, { permanent: true });
          }
        } else {
          await repository.save(
            current,
            parseLocationLibraryIndex(change.beforeContent),
          );
        }
        continue;
      }
      if (change.operation === "create") {
        const currentContent = await readOptionalText(
          storage,
          change.targetPath,
        );
        if (currentContent !== change.afterContent) {
          throw new Error("目标文件已在回滚前发生变化，已保留当前内容");
        }
        await storage.remove(change.targetPath, { permanent: true });
      } else {
        await storage.writeText(change.targetPath, change.beforeContent, {
          expectedContent: change.afterContent,
        });
      }
    } catch (error) {
      failures.push(`${change.targetPath}: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`提案回滚失败：${failures.join("；")}`);
  }
}

async function applyProposalChange(
  storage: WorkbenchStorage,
  change: LoadedWorldProposalChange,
): Promise<void> {
  if (change.targetPath !== WORLD_LOCATION_LIBRARY_PATH) {
    if (change.operation === "create") {
      await storage.createText(change.targetPath, change.afterContent, {
        createParents: true,
      });
    } else {
      await storage.writeText(change.targetPath, change.afterContent, {
        expectedContent: change.beforeContent,
      });
    }
    return;
  }

  const repository = createNovelLocationLibraryRepository(storage);
  let current: LoadedLocationLibrary;
  const [info] = await storage.stat([WORLD_LOCATION_LIBRARY_PATH]);
  if (!info?.exists) {
    if (change.operation !== "create") {
      throw new Error("地点库不存在，无法应用修改提案");
    }
    current = await repository.load();
  } else {
    current = await repository.load();
    if (change.operation === "create") {
      throw new Error("地点库已经存在，无法应用创建提案");
    }
  }
  const currentContent = serializeLocationLibraryIndex(current.index);
  const expectedContent =
    change.operation === "create" ? "" : change.beforeContent;
  if (change.operation !== "create" && currentContent !== expectedContent) {
    throw new Error("地点事实源已被外部修改，请重新加载提案");
  }
  await repository.save(
    current,
    parseLocationLibraryIndex(change.afterContent),
  );
}

export function getWorldProposalStatus(
  proposal: Pick<LoadedWorldProposal, "manifest">,
): WorldProposalStatus {
  const statuses = proposal.manifest.changes.map((change) => change.status);
  if (statuses.every((status) => status === "applied")) return "applied";
  if (statuses.every((status) => status === "rejected")) return "rejected";
  if (statuses.some((status) => status === "applied")) {
    return "partially-applied";
  }
  return "pending";
}

export function createNovelWorldProposalRepository(
  storage: WorkbenchStorage,
): NovelWorldProposalRepository {
  const load = async (proposalId: string): Promise<LoadedWorldProposal> => {
    const manifestPath = worldProposalManifestPath(proposalId);
    const manifestFile = await storage.readText(manifestPath);
    const parsedManifest = parseWorldProposalManifest(
      manifestFile.content,
      manifestPath,
    );
    if (parsedManifest.proposalId !== proposalId) {
      throw new Error(
        `提案目录与 proposalId 不一致：${proposalId} / ${parsedManifest.proposalId}`,
      );
    }
    const discoveredChanges = await discoverUnlistedChanges(
      storage,
      proposalId,
      parsedManifest,
    );
    const declaredAndDiscoveredChanges = [
      ...parsedManifest.changes,
      ...discoveredChanges,
    ];
    const generatedSettingsChange =
      !declaredAndDiscoveredChanges.some(
        (change) => change.targetPath === SETTING_LIBRARY_PATHS.settings,
      ) &&
      declaredAndDiscoveredChanges.some((change) =>
        isMaterializedSettingPath(change.targetPath),
      )
        ? inferMissingSettingsIndexChange(
            await loadPersistedSettingLibrary(storage),
            declaredAndDiscoveredChanges,
          )
        : null;
    const inferredIds = new Set(
      [
        ...discoveredChanges,
        ...(generatedSettingsChange ? [generatedSettingsChange.change] : []),
      ].map((change) => change.id),
    );
    const manifest: WorldProposalManifest = {
      ...parsedManifest,
      changes: [
        ...declaredAndDiscoveredChanges,
        ...(generatedSettingsChange ? [generatedSettingsChange.change] : []),
      ],
    };
    const changes = await Promise.all(
      manifest.changes.map(
        async (change): Promise<LoadedWorldProposalChange> => {
          const currentContent = await readCurrentTargetContent(
            storage,
            change.targetPath,
          );
          if (change.id === generatedSettingsChange?.change.id) {
            return {
              ...change,
              beforeContent: generatedSettingsChange.beforeContent,
              afterContent: generatedSettingsChange.afterContent,
              currentContent,
              conflict:
                change.status === "pending" &&
                currentContent !== generatedSettingsChange.beforeContent,
              loadError: null,
              inferred: true,
              generated: true,
            };
          }
          try {
            const beforeContent =
              change.operation === "modify"
                ? await readProposalSnapshot(
                    storage,
                    proposalId,
                    "before",
                    change.targetPath,
                  )
                : "";
            const afterContent = await readProposalSnapshot(
              storage,
              proposalId,
              "after",
              change.targetPath,
            );
            const conflict =
              change.status === "pending" &&
              (change.operation === "create"
                ? currentContent !== null
                : currentContent !== beforeContent);
            return {
              ...change,
              beforeContent,
              afterContent,
              currentContent,
              conflict,
              loadError: null,
              inferred: inferredIds.has(change.id),
              generated: false,
            };
          } catch (error) {
            return {
              ...change,
              beforeContent: "",
              afterContent: "",
              currentContent,
              conflict: false,
              loadError: errorMessage(error),
              inferred: inferredIds.has(change.id),
              generated: false,
            };
          }
        },
      ),
    );
    return Object.freeze({
      manifest,
      manifestPath,
      manifestContent: manifestFile.content,
      changes: Object.freeze(changes),
    });
  };

  const applySelectedChanges = async (
    proposal: LoadedWorldProposal,
    selected: readonly LoadedWorldProposalChange[],
    projectTitle: string,
  ): Promise<LoadedWorldProposal> => {
    const selectedIds = new Set(selected.map((change) => change.id));
    const settingLibrary =
      await createNovelSettingLibraryRepository(storage).load(projectTitle);
    const prospective = prospectiveLibrary(settingLibrary, selected);
    validateLocationProposalChanges(prospective, selected);
    await validateMaterializedSettingFiles(
      storage,
      prospective,
      selected,
      true,
    );

    const applied: LoadedWorldProposalChange[] = [];
    try {
      await persistGeneratedProposalSnapshots(
        storage,
        proposal.manifest.proposalId,
        proposal.changes,
      );
      for (const change of selected) {
        await applyProposalChange(storage, change);
        applied.push(change);
      }

      const persistedLibrary = await loadPersistedSettingLibrary(storage);
      await validateMaterializedSettingFiles(
        storage,
        persistedLibrary,
        selected,
        false,
      );

      const nextManifest = updateManifestChanges(
        proposal.manifest,
        selectedIds,
        "applied",
      );
      await storage.writeText(
        proposal.manifestPath,
        serializeWorldProposalManifest(nextManifest),
        { expectedContent: proposal.manifestContent },
      );
    } catch (error) {
      try {
        await rollbackAppliedChanges(storage, applied);
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}；${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
    return load(proposal.manifest.proposalId);
  };

  const repository: NovelWorldProposalRepository = {
    async list() {
      const [directory] = await storage.stat([WORLD_PROPOSALS_DIRECTORY]);
      if (!directory?.exists) {
        return Object.freeze({
          proposals: Object.freeze([]),
          errors: Object.freeze([]),
        });
      }
      const entries = await storage.list(WORLD_PROPOSALS_DIRECTORY);
      const proposalEntries = entries.filter(
        (entry) => entry.kind === "directory",
      );
      const settled = await Promise.allSettled(
        proposalEntries.map((entry) => load(entry.name)),
      );
      const proposals: LoadedWorldProposal[] = [];
      const errors: WorldProposalLoadError[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          proposals.push(result.value);
          return;
        }
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
      return Object.freeze({
        proposals: Object.freeze(proposals),
        errors: Object.freeze(errors),
      });
    },

    load,

    async deleteProposals(proposalIds) {
      const selectedIds = [...new Set(proposalIds)];
      if (selectedIds.length === 0) throw new Error("请至少选择一份待删除提案");
      for (const proposalId of selectedIds) {
        if (
          !proposalId ||
          proposalId === "." ||
          proposalId === ".." ||
          /[\\/]/.test(proposalId) ||
          Array.from(proposalId).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        ) {
          throw new Error(`提案 ID 非法：${proposalId}`);
        }
      }
      for (const proposalId of selectedIds) {
        await storage.remove(`${WORLD_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
      }
    },

    async apply(proposalId, changeIds, projectTitle) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待应用变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (selected.length !== selectedIds.size) {
        throw new Error("选择中包含不存在的提案变更");
      }
      const unavailable = selected.find(
        (change) =>
          change.status !== "pending" || change.conflict || change.loadError,
      );
      if (unavailable) {
        throw new Error(
          unavailable.loadError
            ? unavailable.loadError
            : unavailable.conflict
              ? `目标文件已变化，无法应用：${unavailable.targetPath}`
              : `变更已处理，无法再次应用：${unavailable.id}`,
        );
      }

      return applySelectedChanges(proposal, selected, projectTitle);
    },

    async resolveConflict(proposalId, changeId, resolution, projectTitle) {
      const proposal = await load(proposalId);
      const change = proposal.changes.find((item) => item.id === changeId);
      if (!change) throw new Error("提案变更不存在");
      if (change.status !== "pending") {
        throw new Error("已处理的变更不能再次解决冲突");
      }
      if (change.loadError) throw new Error(change.loadError);
      if (!change.conflict) {
        throw new Error("正式内容当前没有冲突，请直接应用提案");
      }
      if (change.currentContent !== resolution.expectedCurrentContent) {
        throw new Error("正式内容在冲突处理期间再次变化，请重新读取后再处理");
      }

      const resolvedChange: LoadedWorldProposalChange = {
        ...change,
        operation: change.currentContent === null ? "create" : "modify",
        beforeContent: change.currentContent ?? "",
        afterContent:
          resolution.strategy === "merge"
            ? resolution.content
            : change.afterContent,
        conflict: false,
      };
      return applySelectedChanges(proposal, [resolvedChange], projectTitle);
    },

    async reject(proposalId, changeIds) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待拒绝变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (selected.length !== selectedIds.size) {
        throw new Error("选择中包含不存在的提案变更");
      }
      if (selected.some((change) => change.status !== "pending")) {
        throw new Error("已处理的变更不能再次拒绝");
      }
      await persistGeneratedProposalSnapshots(
        storage,
        proposalId,
        proposal.changes,
      );
      const nextManifest = updateManifestChanges(
        proposal.manifest,
        selectedIds,
        "rejected",
      );
      await storage.writeText(
        proposal.manifestPath,
        serializeWorldProposalManifest(nextManifest),
        { expectedContent: proposal.manifestContent },
      );
      return load(proposalId);
    },

    async delete(proposalId, changeIds) {
      const selectedIds = new Set(changeIds);
      if (selectedIds.size === 0) throw new Error("请至少选择一个待删除变更");
      const proposal = await load(proposalId);
      const selected = proposal.changes.filter((change) =>
        selectedIds.has(change.id),
      );
      if (selected.length !== selectedIds.size) {
        throw new Error("选择中包含不存在的提案变更");
      }
      if (selected.some((change) => change.status !== "pending")) {
        throw new Error("只能删除尚未处理的提案变更");
      }

      if (selected.length === proposal.changes.length) {
        await storage.remove(`${WORLD_PROPOSALS_DIRECTORY}/${proposalId}`, {
          permanent: true,
        });
        return null;
      }

      await persistGeneratedProposalSnapshots(
        storage,
        proposalId,
        proposal.changes,
      );
      const nextManifest: WorldProposalManifest = {
        ...proposal.manifest,
        changes: proposal.manifest.changes.filter(
          (change) => !selectedIds.has(change.id),
        ),
      };
      await storage.writeText(
        proposal.manifestPath,
        serializeWorldProposalManifest(nextManifest),
        { expectedContent: proposal.manifestContent },
      );
      await removeProposalChangeSnapshots(storage, proposalId, selected);
      return load(proposalId);
    },
  };
  return Object.freeze(repository);
}
