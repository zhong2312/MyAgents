import { describe, expect, it, vi } from "vitest";

import { createWorkbenchStorage } from "./storageAdapter";

function createHost(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: true,
    workspacePath: "F:\\Novels\\Example",
    checkPaths: vi.fn(async ({ paths }: { paths: string[] }) => ({
      results: Object.fromEntries(
        paths.map((path) => [path, { exists: false, type: "file" as const }]),
      ),
    })),
    dirTree: vi.fn(async () => ({ tree: { children: [] } })),
    dirExpand: vi.fn(async () => ({ children: [] })),
    readPreview: vi.fn(async ({ path }: { path: string }) => ({
      content: "old",
      name: path.split("/").at(-1) ?? path,
      size: 3,
    })),
    downloadFileBytes: vi.fn(async () => new ArrayBuffer(0)),
    newFile: vi.fn(
      async ({ parentDir, name }: { parentDir: string; name: string }) => ({
        path: parentDir ? `${parentDir}/${name}` : name,
      }),
    ),
    newFolder: vi.fn(
      async ({ parentDir, name }: { parentDir: string; name: string }) => ({
        path: parentDir ? `${parentDir}/${name}` : name,
      }),
    ),
    saveFile: vi.fn(async () => {}),
    copyInternal: vi.fn(async () => ({ copiedFiles: [], errors: [] })),
    movePaths: vi.fn(async () => ({ movedFiles: [], errors: [] })),
    rename: vi.fn(
      async ({ oldPath, newName }: { oldPath: string; newName: string }) => ({
        newPath: `${oldPath.slice(0, Math.max(0, oldPath.lastIndexOf("/") + 1))}${newName}`,
      }),
    ),
    deleteFile: vi.fn(async () => ({ deleted: true })),
    ...overrides,
  };
}

describe("createWorkbenchStorage", () => {
  it("maps host reads, listings, and optimistic text writes to the public contract", async () => {
    const host = createHost({
      dirExpand: vi.fn(async () => ({
        children: [
          { name: "one.md", path: "notes/one.md", type: "file" as const },
        ],
      })),
    });
    const storage = createWorkbenchStorage(host);

    await expect(storage.readText("notes\\one.md")).resolves.toMatchObject({
      path: "notes/one.md",
      content: "old",
      size: 3,
    });
    await expect(storage.list("notes")).resolves.toEqual([
      { path: "notes/one.md", name: "one.md", kind: "file" },
    ]);
    await storage.writeText("notes/one.md", "new text", {
      expectedContent: "old",
    });

    expect(host.saveFile).toHaveBeenCalledWith({
      path: "notes/one.md",
      content: "new text",
      expectedContent: "old",
    });
  });

  it("creates missing parent directories before creating a text file", async () => {
    const host = createHost();
    const storage = createWorkbenchStorage(host);

    await expect(
      storage.createText("planning/arcs/main.md", "# Main\n", {
        createParents: true,
      }),
    ).resolves.toMatchObject({
      path: "planning/arcs/main.md",
      content: "# Main\n",
    });

    expect(host.newFolder.mock.calls).toEqual([
      [{ parentDir: "", name: "planning" }],
      [{ parentDir: "planning", name: "arcs" }],
    ]);
    expect(host.newFile).toHaveBeenCalledWith({
      parentDir: "planning/arcs",
      name: "main.md",
    });
    expect(host.saveFile).toHaveBeenCalledWith({
      path: "planning/arcs/main.md",
      content: "# Main\n",
      expectedContent: "",
    });
  });

  it("removes a newly-created blank file when its initial write fails", async () => {
    const failure = new Error("disk full");
    const host = createHost({
      saveFile: vi.fn(async () => {
        throw failure;
      }),
    });
    const storage = createWorkbenchStorage(host);

    await expect(storage.createText("notes/one.md", "content")).rejects.toBe(
      failure,
    );
    expect(host.deleteFile).toHaveBeenCalledWith({
      path: "notes/one.md",
      permanent: true,
    });
  });

  it("delegates coarse workspace change subscriptions without exposing host handles", async () => {
    const dispose = vi.fn(async () => {});
    const watchFactory = vi.fn(async (listener: () => void) => {
      listener();
      return { dispose };
    });
    const storage = createWorkbenchStorage(createHost(), watchFactory);
    const listener = vi.fn();

    const subscription = await storage.watch(listener);
    expect(listener).toHaveBeenCalledWith({ kind: "workspace-changed" });
    await subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
