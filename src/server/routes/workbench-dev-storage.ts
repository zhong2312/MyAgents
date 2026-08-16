import { lstat, mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "path";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const MAX_BINARY_WRITE_BYTES = 12 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string") throw new Error("path must be a string");
  const normalized = value.trim().replace(/\\/gu, "/");
  if (!normalized) {
    if (allowRoot) return "";
    throw new Error("path must not be empty");
  }
  if (isAbsolute(normalized) || /^[a-z]:/iu.test(normalized)) {
    throw new Error("absolute paths are not allowed");
  }
  const segments = normalized
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment.includes("\0"))) {
    throw new Error("path traversal is not allowed");
  }
  if (!segments.length && !allowRoot)
    throw new Error("path must identify an entry");
  return segments.join("/");
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/").filter(Boolean));
  const prefix = `${resolve(root).toLowerCase()}${sep}`;
  if (
    target.toLowerCase() !== resolve(root).toLowerCase() &&
    !target.toLowerCase().startsWith(prefix)
  ) {
    throw new Error("path escapes the development workspace");
  }
  return target;
}

async function rejectSymlinkPath(
  root: string,
  relativePath: string,
): Promise<void> {
  let current = resolve(root);
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(
          "symbolic links are not supported by browser development storage",
        );
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function entryNode(root: string, fullPath: string) {
  const metadata = await lstat(fullPath);
  if (metadata.isSymbolicLink()) return null;
  return {
    id: relative(root, fullPath).replace(/\\/gu, "/"),
    name: basename(fullPath),
    path: relative(root, fullPath).replace(/\\/gu, "/"),
    type: metadata.isDirectory() ? ("dir" as const) : ("file" as const),
  };
}

async function listChildren(root: string, relativePath: string) {
  const directory = resolveInside(root, relativePath);
  await rejectSymlinkPath(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => entryNode(root, resolve(directory, entry.name))),
  );
  return nodes
    .filter((node): node is NonNullable<typeof node> => node !== null)
    .sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === "dir"
          ? -1
          : 1,
    );
}

export async function handleWorkbenchDevStorageRoute(
  pathname: string,
  request: Request,
  workspaceRoot: string,
): Promise<Response | null> {
  if (
    pathname !== "/api/workbench-dev-storage/request" ||
    request.method !== "POST"
  ) {
    return null;
  }
  if (process.env.MYAGENTS_BROWSER_DEV_STORAGE !== "1") {
    return jsonResponse(
      { success: false, error: "Browser development storage is disabled." },
      404,
    );
  }

  try {
    const payload: unknown = await request.json();
    if (!isRecord(payload) || !isRecord(payload.args)) {
      throw new Error("Invalid development storage request.");
    }
    if (
      typeof payload.workspacePath !== "string" ||
      !samePath(payload.workspacePath, workspaceRoot)
    ) {
      throw new Error(
        "The requested workspace is not the active development workspace.",
      );
    }
    const command = typeof payload.command === "string" ? payload.command : "";
    const args = payload.args;
    let data: unknown;

    if (command === "cmd_list_slash_commands") {
      data = { commands: [], globalSkillFolderNames: [] };
    } else if (command === "cmd_workspace_check_paths") {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const results: Record<string, { exists: boolean; type: "file" | "dir" }> =
        {};
      for (const value of paths.slice(0, 200)) {
        const path = normalizeRelativePath(value, true);
        await rejectSymlinkPath(workspaceRoot, path);
        try {
          const metadata = await stat(resolveInside(workspaceRoot, path));
          results[path] = {
            exists: true,
            type: metadata.isDirectory() ? "dir" : "file",
          };
        } catch (error) {
          if (isRecord(error) && error.code === "ENOENT") {
            results[path] = { exists: false, type: "file" };
          } else {
            throw error;
          }
        }
      }
      data = { results };
    } else if (command === "cmd_workspace_dir_tree") {
      data = {
        root: workspaceRoot,
        summary: { totalFiles: 0, totalDirs: 0 },
        tree: {
          id: "",
          name: basename(workspaceRoot),
          path: "",
          type: "dir",
          loaded: true,
          children: await listChildren(workspaceRoot, ""),
        },
        truncated: false,
      };
    } else if (command === "cmd_workspace_dir_expand") {
      const path = normalizeRelativePath(args.path, true);
      data = {
        children: await listChildren(workspaceRoot, path),
        loaded: true,
      };
    } else if (command === "cmd_workspace_read_preview") {
      const path = normalizeRelativePath(args.path);
      await rejectSymlinkPath(workspaceRoot, path);
      const fullPath = resolveInside(workspaceRoot, path);
      const metadata = await stat(fullPath);
      if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) {
        throw new Error("File is not a previewable text file.");
      }
      data = {
        content: await readFile(fullPath, "utf8"),
        name: basename(fullPath),
        size: metadata.size,
      };
    } else if (command === "cmd_workspace_download_bytes") {
      const path = normalizeRelativePath(args.path);
      await rejectSymlinkPath(workspaceRoot, path);
      const fullPath = resolveInside(workspaceRoot, path);
      const metadata = await stat(fullPath);
      if (!metadata.isFile() || metadata.size > MAX_BINARY_BYTES) {
        throw new Error("File is too large for bounded binary storage access.");
      }
      data = { content: (await readFile(fullPath)).toString("base64") };
    } else if (command === "cmd_workspace_new_folder") {
      const parent = normalizeRelativePath(args.parentDir, true);
      const name = normalizeRelativePath(args.name);
      if (name.includes("/"))
        throw new Error("name must contain one path segment");
      const path = parent ? `${parent}/${name}` : name;
      await rejectSymlinkPath(workspaceRoot, parent);
      await mkdir(resolveInside(workspaceRoot, path));
      data = { success: true, path };
    } else if (command === "cmd_workspace_new_file") {
      const parent = normalizeRelativePath(args.parentDir, true);
      const name = normalizeRelativePath(args.name);
      if (name.includes("/"))
        throw new Error("name must contain one path segment");
      const path = parent ? `${parent}/${name}` : name;
      await rejectSymlinkPath(workspaceRoot, parent);
      await writeFile(resolveInside(workspaceRoot, path), "", { flag: "wx" });
      data = { success: true, path };
    } else if (command === "cmd_workspace_save_file") {
      const path = normalizeRelativePath(args.path);
      if (
        typeof args.content !== "string" ||
        Buffer.byteLength(args.content, "utf8") > MAX_TEXT_BYTES
      ) {
        throw new Error("content exceeds the 2 MB development limit");
      }
      await rejectSymlinkPath(workspaceRoot, path);
      const fullPath = resolveInside(workspaceRoot, path);
      if (typeof args.expectedContent === "string") {
        const current = await readFile(fullPath, "utf8");
        if (current !== args.expectedContent) {
          return jsonResponse(
            { success: false, error: "File changed since it was read." },
            409,
          );
        }
      }
      await writeFile(fullPath, args.content, "utf8");
      data = null;
    } else if (command === "cmd_workspace_save_binary_file") {
      const path = normalizeRelativePath(args.path);
      if (typeof args.contentBase64 !== "string") {
        throw new Error("binary content must be base64 text");
      }
      const bytes = Buffer.from(args.contentBase64, "base64");
      if (!bytes.length || bytes.byteLength > MAX_BINARY_WRITE_BYTES) {
        throw new Error("binary content exceeds the 12 MB development limit");
      }
      await rejectSymlinkPath(workspaceRoot, path);
      const fullPath = resolveInside(workspaceRoot, path);
      const metadata = await stat(fullPath);
      if (!metadata.isFile()) throw new Error("binary target must be a file");
      await writeFile(fullPath, bytes);
      data = null;
    } else {
      return jsonResponse(
        {
          success: false,
          error: `Unsupported browser development storage command: ${command}`,
        },
        400,
      );
    }

    return jsonResponse({ success: true, data });
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
}
