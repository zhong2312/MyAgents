export type WorkbenchStorageEntryKind = "file" | "directory";

export interface WorkbenchStorageEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: WorkbenchStorageEntryKind;
}

export interface WorkbenchStoragePathInfo {
  readonly path: string;
  readonly exists: boolean;
  readonly kind?: WorkbenchStorageEntryKind;
}

export interface WorkbenchTextFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly content: string;
}

export interface WorkbenchStorageTransfer {
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface WorkbenchStorageTransferResult {
  readonly transfers: readonly WorkbenchStorageTransfer[];
  readonly errors: readonly string[];
}

export interface WorkbenchStorageChange {
  readonly kind: "workspace-changed";
}

export interface WorkbenchStorageSubscription {
  dispose(): Promise<void>;
}

export interface WorkbenchCreateTextOptions {
  readonly createParents?: boolean;
}

export interface WorkbenchWriteTextOptions {
  /** Reject the write when the current file no longer equals this content. */
  readonly expectedContent?: string;
}

export interface WorkbenchRemoveOptions {
  /** Permanent deletion is intended for scratch data only. The default uses the OS trash. */
  readonly permanent?: boolean;
}

/**
 * Workspace-root-bound storage capability exposed to trusted workbenches.
 * Every path is workspace-relative and uses `/` separators.
 */
export interface WorkbenchStorage {
  readonly rootPath: string;
  readonly isAvailable: boolean;

  stat(paths: readonly string[]): Promise<readonly WorkbenchStoragePathInfo[]>;
  list(directory?: string): Promise<readonly WorkbenchStorageEntry[]>;
  readText(path: string): Promise<WorkbenchTextFile>;
  readBinary(path: string): Promise<ArrayBuffer>;

  createDirectory(path: string): Promise<WorkbenchStorageEntry>;
  createText(
    path: string,
    content?: string,
    options?: WorkbenchCreateTextOptions,
  ): Promise<WorkbenchTextFile>;
  writeText(
    path: string,
    content: string,
    options?: WorkbenchWriteTextOptions,
  ): Promise<WorkbenchTextFile>;

  copy(
    paths: readonly string[],
    targetDirectory: string,
  ): Promise<WorkbenchStorageTransferResult>;
  move(
    paths: readonly string[],
    targetDirectory: string,
  ): Promise<WorkbenchStorageTransferResult>;
  rename(path: string, newName: string): Promise<WorkbenchStorageEntry>;
  remove(path: string, options?: WorkbenchRemoveOptions): Promise<boolean>;

  watch(
    listener: (change: WorkbenchStorageChange) => void,
  ): Promise<WorkbenchStorageSubscription>;
}

export class WorkbenchStoragePathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Invalid workbench storage path "${path}": ${message}`);
    this.name = "WorkbenchStoragePathError";
  }
}

export class WorkbenchStorageUnavailableError extends Error {
  constructor() {
    super("Workbench storage is unavailable in the current environment.");
    this.name = "WorkbenchStorageUnavailableError";
  }
}

export function normalizeWorkbenchStoragePath(
  path: string,
  allowRoot = false,
): string {
  const value = path.trim().replace(/\\/g, "/");
  if (!value) {
    if (allowRoot) return "";
    throw new WorkbenchStoragePathError(path, "path must not be empty");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new WorkbenchStoragePathError(path, "absolute paths are not allowed");
  }

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new WorkbenchStoragePathError(
        path,
        "parent traversal is not allowed",
      );
    }
    if (segment.includes("\0")) {
      throw new WorkbenchStoragePathError(path, "NUL bytes are not allowed");
    }
    segments.push(segment);
  }
  if (!segments.length) {
    if (allowRoot) return "";
    throw new WorkbenchStoragePathError(path, "path must identify an entry");
  }
  return segments.join("/");
}

export function joinWorkbenchStoragePath(...parts: readonly string[]): string {
  return normalizeWorkbenchStoragePath(parts.filter(Boolean).join("/"));
}

/**
 * 读取文本文件；文件缺失时创建默认内容。并发创建被其它调用方抢先完成时，
 * 回退读取已落盘的最终内容。
 */
export async function ensureWorkbenchTextFile(
  storage: WorkbenchStorage,
  path: string,
  fallbackContent: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, fallbackContent, {
      createParents: true,
    });
  } catch {
    return storage.readText(path);
  }
}
