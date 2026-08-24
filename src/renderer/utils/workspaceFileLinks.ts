export interface WorkspaceFileLinkTarget {
  path: string;
  initialLineNumber?: number;
}

export type FileActionTarget =
  | { scope: 'workspace'; path: string; initialLineNumber?: number }
  | { scope: 'local'; path: string; initialLineNumber?: number };

const EXTENSIONLESS_FILE_NAMES = new Set([
  'makefile',
  'dockerfile',
  'license',
  'readme',
  'changelog',
  'agents',
]);

export function resolveWorkspaceFileLinkTarget(
  href: string,
  workspacePath: string | null | undefined,
): WorkspaceFileLinkTarget | null {
  const target = resolveFileLinkTarget(href, workspacePath);
  if (target?.scope !== 'workspace') return null;
  return target.initialLineNumber
    ? { path: target.path, initialLineNumber: target.initialLineNumber }
    : { path: target.path };
}

export function resolveFileLinkTarget(
  href: string,
  workspacePath: string | null | undefined,
): FileActionTarget | null {
  const workspace = workspacePath?.trim();
  const raw = href?.trim();
  if (!raw) return null;

  const { base, line: hashLine } = stripHashLine(raw);
  // Parse file URLs before generic URI decoding so encoded `#` / `?` remain
  // filename characters instead of being reinterpreted as URL delimiters.
  const localPath = fileUrlToPath(base) ?? decodeUriLoose(base);
  if (hasUnsupportedScheme(localPath)) return null;

  const { path: pathWithoutLine, line: suffixLine } = stripLineSuffix(localPath);
  const initialLineNumber = suffixLine ?? hashLine;
  const relativePath = workspace ? toWorkspaceRelativePath(pathWithoutLine, workspace) : null;
  if (relativePath) {
    return initialLineNumber
      ? { scope: 'workspace', path: relativePath, initialLineNumber }
      : { scope: 'workspace', path: relativePath };
  }

  if (isAbsolutePath(pathWithoutLine)) {
    return initialLineNumber
      ? { scope: 'local', path: pathWithoutLine, initialLineNumber }
      : { scope: 'local', path: pathWithoutLine };
  }

  return null;
}

export function resolveFileActionTarget(
  rawPath: string,
  workspacePath: string | null | undefined,
  options?: { parseLineReference?: boolean },
): FileActionTarget | null {
  if (options?.parseLineReference || /^file:\/\//i.test(rawPath.trim())) {
    return resolveFileLinkTarget(rawPath, workspacePath);
  }

  // Structured tool `file_path` values are native filenames, not Markdown
  // references. Preserve legal POSIX names such as `report:12` / `note#L3`
  // verbatim; only inline/Markdown references opt into line parsing above.
  const path = rawPath?.trim();
  if (!path || hasUnsupportedScheme(path)) return null;
  const workspaceRelative = workspacePath ? toWorkspaceRelativePath(path, workspacePath) : null;
  if (workspaceRelative) return { scope: 'workspace', path: workspaceRelative };
  if (isAbsolutePath(path)) return { scope: 'local', path };
  return null;
}

/**
 * Resolve a (possibly workspace-relative) path to an ABSOLUTE path against the
 * given workspace root. Returns the input unchanged when it is already
 * absolute, or `null` when it is relative and no workspace is known (or the
 * relative path escapes the workspace via `..`).
 *
 * Why: model-authored chat text usually contains workspace-relative paths
 * (e.g. `myagents_files/generated_audio/tts_x.mp3`). Absolute-path-only
 * consumers — notably the audio player's `cmd_read_file_base64`, which rejects
 * any non-absolute path with "Path must be absolute" — need them resolved
 * first. Joins with `/`; Rust `PathBuf` normalizes mixed separators on Windows.
 */
export function resolveAgainstWorkspace(
  rawPath: string,
  workspacePath: string | null | undefined,
): string | null {
  const path = rawPath?.trim();
  if (!path) return null;
  if (isAbsolutePath(path)) return path;
  const workspace = workspacePath?.trim();
  if (!workspace) return null;
  const rel = normalizeRelativePath(path); // collapses ./ .. ; null if it escapes
  if (!rel) return null;
  return `${stripTrailingSlash(workspace)}/${rel}`;
}

function stripHashLine(raw: string): { base: string; line?: number } {
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) return { base: raw };

  const base = raw.slice(0, hashIndex);
  const hash = raw.slice(hashIndex + 1);
  const match = /^L(\d+)(?:-L?\d+)?$/i.exec(hash);
  const line = match ? positiveLine(match[1]) : undefined;
  return line ? { base, line } : { base: raw };
}

function stripLineSuffix(rawPath: string): { path: string; line?: number } {
  const match = /^(.*):(\d+)(?::\d+)?$/.exec(rawPath);
  if (!match) return { path: rawPath };

  const base = match[1];
  if (!base || /^[A-Za-z]$/.test(base)) return { path: rawPath };

  const line = positiveLine(match[2]);
  return line ? { path: base, line } : { path: rawPath };
}

function positiveLine(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function fileUrlToPath(raw: string): string | null {
  if (!/^file:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.host && url.host !== 'localhost') {
      const pathname = decodeURIComponent(url.pathname).replace(/\//g, '\\');
      return pathname ? `\\\\${url.host}${pathname}` : null;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:[/\\]/.test(pathname)) {
      pathname = pathname.slice(1).replace(/\//g, '\\');
    }
    return pathname || null;
  } catch {
    return null;
  }
}

function hasUnsupportedScheme(raw: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false;
  return /^[a-z][a-z0-9+\-.]*:/i.test(raw);
}

/**
 * Normalize a path to its workspace-relative form.
 *
 * - Absolute path inside the workspace → relative (e.g.
 *   `/ws/src/a.ts` → `src/a.ts`); absolute path outside the workspace,
 *   or equal to the workspace root, → `null`.
 * - Relative path that looks like a file reference → cleaned relative; other
 *   relative inputs → `null`.
 *
 * File-tool cards (Write/Edit/Read/NotebookEdit) carry ABSOLUTE `file_path`
 * values, but the workspace existence-check + read commands only accept
 * workspace-relative paths (Rust `resolve_inside_workspace` rejects absolute
 * paths outright). Callers normalize here so absolute and relative paths flow
 * through the same backend path, matching how inline AI-text paths behave.
 */
export function toWorkspaceRelativePath(rawPath: string | null | undefined, workspacePath: string): string | null {
  // Total by construction: a path util must never throw on a missing path —
  // an uncaught throw here reaches the root error boundary and kills the whole
  // app. Callers (file-tool chips) can pass an undefined `file_path`.
  const path = rawPath?.trim();
  if (!path) return null;

  if (isAbsolutePath(path)) {
    return absoluteToWorkspaceRelative(path, workspacePath);
  }

  if (!looksLikeRelativeFileReference(path)) return null;
  return normalizeRelativePath(path);
}

/**
 * Resolve the path to use for backend existence checks + context-menu actions
 * from a raw path that may be absolute or workspace-relative.
 *
 * In-workspace absolute paths are normalized to workspace-relative form (the
 * Rust `resolve_inside_workspace` resolver rejects absolute paths outright);
 * everything else — relative paths, or absolute paths outside the workspace —
 * passes through unchanged so the backend reports them as not-found.
 *
 * Shared by the two surfaces that turn paths into clickable chips so they
 * resolve identically: the inline-code path detector (`markdown/InlineCode`)
 * and the file-tool chip (`tools/FilePath`). Before this was shared, only the
 * tool chip normalized — inline absolute paths in AI text silently stayed plain
 * because the absolute form was sent straight to the rejecting resolver.
 */
export function resolveActionPath(rawPath: string, workspacePath: string | null | undefined): string {
  return (workspacePath ? toWorkspaceRelativePath(rawPath, workspacePath) : null) ?? rawPath;
}

function absoluteToWorkspaceRelative(rawPath: string, rawWorkspace: string): string | null {
  const path = stripTrailingSlash(normalizeSlashes(rawPath));
  const workspace = stripTrailingSlash(normalizeSlashes(rawWorkspace));
  const comparablePath = normalizeForCompare(path);
  const comparableWorkspace = normalizeForCompare(workspace);

  if (comparablePath === comparableWorkspace) return null;
  if (!comparablePath.startsWith(`${comparableWorkspace}/`)) return null;

  return normalizeRelativePath(path.slice(workspace.length + 1));
}

function normalizeRelativePath(rawPath: string): string | null {
  if (isAbsolutePath(rawPath)) return null;

  const parts = normalizeSlashes(rawPath).split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return stack.length > 0 ? stack.join('/') : null;
}

function looksLikeRelativeFileReference(rawPath: string): boolean {
  const path = normalizeSlashes(rawPath.trim());
  if (!path || path.startsWith('#')) return false;
  if (path.startsWith('./') || path.startsWith('../')) return true;
  if (path.includes('/')) return true;

  const name = path.toLowerCase();
  if (name.startsWith('.')) return true;
  if (EXTENSIONLESS_FILE_NAMES.has(name)) return true;
  return /\.[^./\\]+$/.test(path);
}

function isAbsolutePath(rawPath: string): boolean {
  return rawPath.startsWith('/') || /^[/\\]{2}/.test(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath);
}

function normalizeSlashes(rawPath: string): string {
  return decodeUriLoose(rawPath).replace(/\\/g, '/');
}

function normalizeForCompare(rawPath: string): string {
  const normalized = normalizeSlashes(rawPath);
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function stripTrailingSlash(rawPath: string): string {
  const normalized = normalizeSlashes(rawPath);
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function decodeUriLoose(raw: string): string {
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}
