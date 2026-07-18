import {
  normalizeWorkbenchStoragePath,
  WorkbenchStorageUnavailableError,
  type WorkbenchStorage,
  type WorkbenchStorageEntry,
  type WorkbenchStorageEntryKind,
  type WorkbenchStorageSubscription,
} from "../../shared/workbench-sdk";

interface HostTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "dir";
}

interface WorkbenchStorageHost {
  readonly isAvailable: boolean;
  readonly workspacePath: string | null;
  checkPaths(args: { paths: string[] }): Promise<{
    results: Record<string, { exists: boolean; type: "file" | "dir" }>;
  }>;
  dirTree(): Promise<{ tree: { children?: HostTreeNode[] } }>;
  dirExpand(args: { path: string }): Promise<{ children: HostTreeNode[] }>;
  readPreview(args: {
    path: string;
  }): Promise<{ content: string; name: string; size: number }>;
  downloadFileBytes(args: { path: string }): Promise<ArrayBuffer>;
  newFile(args: { parentDir: string; name: string }): Promise<{ path: string }>;
  newFolder(args: {
    parentDir: string;
    name: string;
  }): Promise<{ path: string }>;
  saveFile(args: {
    path: string;
    content: string;
    expectedContent?: string;
  }): Promise<void>;
  copyInternal(args: { sourcePaths: string[]; targetDir: string }): Promise<{
    copiedFiles: Array<{ sourcePath: string; targetPath: string }>;
    errors: string[];
  }>;
  movePaths(args: { sourcePaths: string[]; targetDir: string }): Promise<{
    movedFiles: Array<{ oldPath: string; newPath: string }>;
    errors: string[];
  }>;
  rename(args: {
    oldPath: string;
    newName: string;
  }): Promise<{ newPath: string }>;
  deleteFile(args: {
    path: string;
    permanent?: boolean;
  }): Promise<{ deleted: boolean }>;
}

export type WorkbenchStorageWatchFactory = (
  listener: () => void,
) => Promise<WorkbenchStorageSubscription>;

/** Matches the Rust workspace check-paths command's per-request limit. */
const STAT_BATCH_SIZE = 200;

function entryKind(type: HostTreeNode["type"]): WorkbenchStorageEntryKind {
  return type === "dir" ? "directory" : "file";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function splitParent(path: string): { parent: string; name: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { parent: "", name: path }
    : { parent: path.slice(0, separator), name: path.slice(separator + 1) };
}

function normalizeEntry(node: HostTreeNode): WorkbenchStorageEntry {
  return Object.freeze({
    path: normalizeWorkbenchStoragePath(node.path),
    name: node.name,
    kind: entryKind(node.type),
  });
}

function textSize(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function createWorkbenchStorage(
  host: WorkbenchStorageHost,
  watchFactory?: WorkbenchStorageWatchFactory,
): WorkbenchStorage {
  const requireAvailable = (): void => {
    if (!host.isAvailable || !host.workspacePath)
      throw new WorkbenchStorageUnavailableError();
  };

  const stat: WorkbenchStorage["stat"] = async (paths) => {
    requireAvailable();
    const normalized = paths.map((path) =>
      normalizeWorkbenchStoragePath(path, true),
    );
    const nonRoot = normalized.filter(Boolean);
    const results: Record<string, { exists: boolean; type: "file" | "dir" }> =
      {};
    for (let start = 0; start < nonRoot.length; start += STAT_BATCH_SIZE) {
      const response = await host.checkPaths({
        paths: nonRoot.slice(start, start + STAT_BATCH_SIZE),
      });
      Object.assign(results, response.results);
    }
    return Object.freeze(
      normalized.map((path) => {
        if (!path)
          return Object.freeze({
            path,
            exists: true,
            kind: "directory" as const,
          });
        const info = results[path];
        if (!info?.exists) return Object.freeze({ path, exists: false });
        return Object.freeze({
          path,
          exists: true,
          kind: entryKind(info.type),
        });
      }),
    );
  };

  const createDirectory: WorkbenchStorage["createDirectory"] = async (path) => {
    requireAvailable();
    const normalized = normalizeWorkbenchStoragePath(path, true);
    if (!normalized)
      return Object.freeze({ path: "", name: "", kind: "directory" as const });

    let current = "";
    for (const segment of normalized.split("/")) {
      const parent = current;
      current = current ? `${current}/${segment}` : segment;
      const [info] = await stat([current]);
      if (info.exists) {
        if (info.kind !== "directory")
          throw new Error(`Storage path is not a directory: ${current}`);
        continue;
      }
      await host.newFolder({ parentDir: parent, name: segment });
    }
    return Object.freeze({
      path: normalized,
      name: basename(normalized),
      kind: "directory" as const,
    });
  };

  const storage: WorkbenchStorage = {
    rootPath: host.workspacePath ?? "",
    isAvailable: host.isAvailable && host.workspacePath !== null,
    stat,
    async list(directory = "") {
      requireAvailable();
      const normalized = normalizeWorkbenchStoragePath(directory, true);
      const nodes = normalized
        ? (await host.dirExpand({ path: normalized })).children
        : ((await host.dirTree()).tree.children ?? []);
      return Object.freeze(nodes.map(normalizeEntry));
    },
    async readText(path) {
      requireAvailable();
      const normalized = normalizeWorkbenchStoragePath(path);
      const result = await host.readPreview({ path: normalized });
      return Object.freeze({ path: normalized, ...result });
    },
    async readBinary(path) {
      requireAvailable();
      return host.downloadFileBytes({
        path: normalizeWorkbenchStoragePath(path),
      });
    },
    createDirectory,
    async createText(path, content = "", options = {}) {
      requireAvailable();
      const normalized = normalizeWorkbenchStoragePath(path);
      const { parent, name } = splitParent(normalized);
      if (options.createParents && parent) await createDirectory(parent);
      const created = await host.newFile({ parentDir: parent, name });
      const createdPath = normalizeWorkbenchStoragePath(created.path);
      if (content) {
        try {
          await host.saveFile({
            path: createdPath,
            content,
            expectedContent: "",
          });
        } catch (error) {
          await host
            .deleteFile({ path: createdPath, permanent: true })
            .catch(() => {});
          throw error;
        }
      }
      return Object.freeze({
        path: createdPath,
        name,
        size: textSize(content),
        content,
      });
    },
    async writeText(path, content, options = {}) {
      requireAvailable();
      const normalized = normalizeWorkbenchStoragePath(path);
      await host.saveFile({
        path: normalized,
        content,
        expectedContent: options.expectedContent,
      });
      return Object.freeze({
        path: normalized,
        name: basename(normalized),
        size: textSize(content),
        content,
      });
    },
    async copy(paths, targetDirectory) {
      requireAvailable();
      const sourcePaths = paths.map((path) =>
        normalizeWorkbenchStoragePath(path),
      );
      const targetDir = normalizeWorkbenchStoragePath(targetDirectory, true);
      const result = await host.copyInternal({ sourcePaths, targetDir });
      return Object.freeze({
        transfers: Object.freeze(
          result.copiedFiles.map((file) =>
            Object.freeze({
              sourcePath: normalizeWorkbenchStoragePath(file.sourcePath),
              targetPath: normalizeWorkbenchStoragePath(file.targetPath),
            }),
          ),
        ),
        errors: Object.freeze([...result.errors]),
      });
    },
    async move(paths, targetDirectory) {
      requireAvailable();
      const sourcePaths = paths.map((path) =>
        normalizeWorkbenchStoragePath(path),
      );
      const targetDir = normalizeWorkbenchStoragePath(targetDirectory, true);
      const result = await host.movePaths({ sourcePaths, targetDir });
      return Object.freeze({
        transfers: Object.freeze(
          result.movedFiles.map((file) =>
            Object.freeze({
              sourcePath: normalizeWorkbenchStoragePath(file.oldPath),
              targetPath: normalizeWorkbenchStoragePath(file.newPath),
            }),
          ),
        ),
        errors: Object.freeze([...result.errors]),
      });
    },
    async rename(path, newName) {
      requireAvailable();
      const normalized = normalizeWorkbenchStoragePath(path);
      const normalizedName = normalizeWorkbenchStoragePath(newName);
      if (normalizedName.includes("/"))
        throw new Error("Storage entry name must contain one path segment.");
      const [before] = await stat([normalized]);
      if (!before.exists || !before.kind)
        throw new Error(`Storage entry not found: ${normalized}`);
      const result = await host.rename({
        oldPath: normalized,
        newName: normalizedName,
      });
      return Object.freeze({
        path: normalizeWorkbenchStoragePath(result.newPath),
        name: normalizedName,
        kind: before.kind,
      });
    },
    async remove(path, options = {}) {
      requireAvailable();
      const result = await host.deleteFile({
        path: normalizeWorkbenchStoragePath(path),
        permanent: options.permanent,
      });
      return result.deleted;
    },
    async watch(listener) {
      requireAvailable();
      if (!watchFactory) throw new WorkbenchStorageUnavailableError();
      return watchFactory(() =>
        listener(Object.freeze({ kind: "workspace-changed" })),
      );
    },
  };

  return Object.freeze(storage);
}
