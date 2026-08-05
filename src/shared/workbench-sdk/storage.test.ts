import { describe, expect, it, vi } from "vitest";

import {
  ensureWorkbenchTextFile,
  joinWorkbenchStoragePath,
  normalizeWorkbenchStoragePath,
  type WorkbenchStorage,
  type WorkbenchTextFile,
  WorkbenchStoragePathError,
} from "./storage";

describe("workbench storage paths", () => {
  it("normalizes workspace-relative paths to portable separators", () => {
    expect(
      normalizeWorkbenchStoragePath(" planning\\chapters//./one.md "),
    ).toBe("planning/chapters/one.md");
    expect(joinWorkbenchStoragePath("planning", "chapters", "one.md")).toBe(
      "planning/chapters/one.md",
    );
    expect(normalizeWorkbenchStoragePath("  ", true)).toBe("");
  });

  it.each([
    "../outside.md",
    "notes/../../outside.md",
    "/absolute/path.md",
    "C:\\absolute\\path.md",
    "\\\\server\\share\\path.md",
    "bad\0name.md",
  ])("rejects paths outside the workspace contract: %s", (path) => {
    expect(() => normalizeWorkbenchStoragePath(path)).toThrow(
      WorkbenchStoragePathError,
    );
  });
});

function textFile(path: string, content: string): WorkbenchTextFile {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    size: new TextEncoder().encode(content).byteLength,
    content,
  };
}

function storageForEnsureTextFile(
  overrides: Partial<Pick<WorkbenchStorage, "stat" | "readText" | "createText">>,
): WorkbenchStorage {
  return {
    rootPath: "F:/workspace",
    isAvailable: true,
    stat: vi.fn(),
    list: vi.fn(),
    readText: vi.fn(),
    readBinary: vi.fn(),
    createDirectory: vi.fn(),
    createText: vi.fn(),
    writeText: vi.fn(),
    copy: vi.fn(),
    move: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    watch: vi.fn(),
    ...overrides,
  };
}

describe("ensureWorkbenchTextFile", () => {
  const path = "libraries/index.json";

  it("文件已存在时直接读取", async () => {
    const existing = textFile(path, "existing");
    const storage = storageForEnsureTextFile({
      stat: vi.fn().mockResolvedValue([{ path, exists: true }]),
      readText: vi.fn().mockResolvedValue(existing),
    });

    await expect(ensureWorkbenchTextFile(storage, path, "fallback")).resolves.toEqual(existing);
    expect(storage.createText).not.toHaveBeenCalled();
  });

  it("文件不存在时创建默认内容", async () => {
    const created = textFile(path, "fallback");
    const storage = storageForEnsureTextFile({
      stat: vi.fn().mockResolvedValue([{ path, exists: false }]),
      createText: vi.fn().mockResolvedValue(created),
    });

    await expect(ensureWorkbenchTextFile(storage, path, "fallback")).resolves.toEqual(created);
    expect(storage.createText).toHaveBeenCalledWith(path, "fallback", {
      createParents: true,
    });
  });

  it("创建发生并发冲突时读取最终文件", async () => {
    const existing = textFile(path, "created elsewhere");
    const storage = storageForEnsureTextFile({
      stat: vi.fn().mockResolvedValue([{ path, exists: false }]),
      createText: vi.fn().mockRejectedValue(new Error("Already exists")),
      readText: vi.fn().mockResolvedValue(existing),
    });

    await expect(ensureWorkbenchTextFile(storage, path, "fallback")).resolves.toEqual(existing);
    expect(storage.readText).toHaveBeenCalledWith(path);
  });
});
