import type {
  WorkbenchStorage,
  WorkbenchStorageChange,
  WorkbenchStorageEntry,
  WorkbenchStoragePathInfo,
} from "@/workbench-sdk";

function textSize(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export class NovelMemoryStorage implements WorkbenchStorage {
  readonly rootPath = "F:/novels/test";
  readonly isAvailable = true;
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>([""]);
  private readonly listeners = new Set<
    (change: WorkbenchStorageChange) => void
  >();
  failNextIndexWrite = false;
  failWritePathOnce: string | null = null;
  afterWriteOnce: ((path: string) => void) | null = null;

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content);
      const segments = path.split("/");
      segments.pop();
      for (let length = 1; length <= segments.length; length += 1) {
        this.directories.add(segments.slice(0, length).join("/"));
      }
    }
  }

  getText(path: string): string | undefined {
    return this.files.get(path);
  }

  setExternalText(path: string, content: string): void {
    this.files.set(path, content);
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners)
      listener({ kind: "workspace-changed" });
  }

  async stat(
    paths: readonly string[],
  ): Promise<readonly WorkbenchStoragePathInfo[]> {
    return paths.map((path) =>
      this.files.has(path)
        ? { path, exists: true, kind: "file" as const }
        : this.directories.has(path)
          ? { path, exists: true, kind: "directory" as const }
          : { path, exists: false },
    );
  }

  async list(directory = ""): Promise<readonly WorkbenchStorageEntry[]> {
    const prefix = directory ? `${directory}/` : "";
    const entries = new Map<string, WorkbenchStorageEntry>();
    for (const path of [...this.directories, ...this.files.keys()]) {
      if (!path.startsWith(prefix) || path === directory) continue;
      const remainder = path.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      const kind = this.files.has(path)
        ? ("file" as const)
        : ("directory" as const);
      entries.set(path, { path, name: remainder, kind });
    }
    return [...entries.values()];
  }

  async readText(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return {
      path,
      name: path.split("/").at(-1) ?? path,
      size: textSize(content),
      content,
    };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const content = (await this.readText(path)).content;
    return Uint8Array.from(new TextEncoder().encode(content)).buffer;
  }

  async createDirectory(path: string): Promise<WorkbenchStorageEntry> {
    this.directories.add(path);
    return { path, name: path.split("/").at(-1) ?? path, kind: "directory" };
  }

  async createText(
    path: string,
    content = "",
    options: { createParents?: boolean } = {},
  ) {
    if (this.files.has(path) || this.directories.has(path))
      throw new Error(`Already exists: ${path}`);
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.directories.has(parent)) {
      if (!options.createParents)
        throw new Error(`Parent not found: ${parent}`);
      const segments = parent.split("/");
      for (let length = 1; length <= segments.length; length += 1) {
        this.directories.add(segments.slice(0, length).join("/"));
      }
    }
    this.files.set(path, content);
    return {
      path,
      name: path.split("/").at(-1) ?? path,
      size: textSize(content),
      content,
    };
  }

  async writeText(
    path: string,
    content: string,
    options: { expectedContent?: string } = {},
  ) {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`File not found: ${path}`);
    if (
      options.expectedContent !== undefined &&
      current !== options.expectedContent
    ) {
      throw new Error("File changed externally");
    }
    if (path === "manuscript/index.json" && this.failNextIndexWrite) {
      this.failNextIndexWrite = false;
      throw new Error("Index write failed");
    }
    if (path === this.failWritePathOnce) {
      this.failWritePathOnce = null;
      throw new Error(`Injected write failure: ${path}`);
    }
    this.files.set(path, content);
    const afterWrite = this.afterWriteOnce;
    this.afterWriteOnce = null;
    afterWrite?.(path);
    return {
      path,
      name: path.split("/").at(-1) ?? path,
      size: textSize(content),
      content,
    };
  }

  async copy() {
    return { transfers: [], errors: [] };
  }

  async move() {
    return { transfers: [], errors: [] };
  }

  async rename(path: string, newName: string): Promise<WorkbenchStorageEntry> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    const parent = path.split("/").slice(0, -1).join("/");
    const nextPath = parent ? `${parent}/${newName}` : newName;
    this.files.delete(path);
    this.files.set(nextPath, content);
    return { path: nextPath, name: newName, kind: "file" };
  }

  async remove(path: string): Promise<boolean> {
    return this.files.delete(path) || this.directories.delete(path);
  }

  async watch(listener: (change: WorkbenchStorageChange) => void) {
    this.listeners.add(listener);
    return {
      dispose: async () => {
        this.listeners.delete(listener);
      },
    };
  }
}

export function createEmptyNovelStorage(): NovelMemoryStorage {
  return new NovelMemoryStorage({
    "novel.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "novel-test",
        workbenchId: "io.myagents.novel",
        title: "测试小说",
        genres: ["悬疑", "推理侦探"],
        targetWordCount: 300_000,
        status: "planning",
        language: "zh-CN",
        createdAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "manuscript/index.json": `${JSON.stringify(
      {
        schemaVersion: 1,
        nextChapterNumber: 1,
        chapters: [],
      },
      null,
      2,
    )}\n`,
  });
}
