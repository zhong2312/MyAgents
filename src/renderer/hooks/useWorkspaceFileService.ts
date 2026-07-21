// Workspace file service hook — Phase C of PRD 0.2.7.
//
// One stable callable surface that wraps the Rust `cmd_workspace_*` invokes.
// Both SimpleChatInput (launcher + chat-tab modes) and DirectoryPanel (Phase D
// follow-up) call into this so the rest of the renderer never reaches into
// `@tauri-apps/api/core` directly.
//
// Design constraints:
//   - Browser dev mode (isTauriEnvironment === false) gracefully throws at
//     call time. We DO NOT silently no-op — silent no-op would hide a bug
//     where the helper is wired up in a context that has no Tauri. The toast
//     in the caller turns this into a visible error.
//   - workspacePath is a hook param (not threaded through every call) so
//     callers can't accidentally mix paths within one input session.
//   - No React state lives in here; stable reference identity comes from
//     useCallback so consumers can put it in effect deps without churn.

import { useCallback, useMemo } from 'react';

import { i18n } from '@/i18n';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { apiPostJson } from '@/api/apiFetch';
import type { WorkbenchProjectInitialization } from '../../shared/workbench-sdk';

function workspaceFileText(key: string): string {
  return String(i18n.t(`app:workspaceFile.${key}`));
}

interface CopiedFile {
  sourcePath: string;
  targetPath: string;
  renamed: boolean;
}

// Phase D additions — DirectoryPanel calls these for tree / preview / CRUD.
// Shapes mirror the sidecar JSON these commands replace, so the React tree
// model and preview modal don't need parallel branches.

interface DirectoryTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: DirectoryTreeNode[];
  loaded?: boolean;
}

interface DirectoryTreeResult {
  root: string;
  summary: { totalFiles: number; totalDirs: number };
  tree: DirectoryTreeNode;
  truncated: boolean;
}

interface ExpandDirectoryResult {
  children: DirectoryTreeNode[];
  loaded: boolean;
}

interface PreviewResult {
  content: string;
  name: string;
  size: number;
}

interface DownloadResult {
  name: string;
  mimeType: string;
  data: string;
}

interface CreatePathResult {
  success: boolean;
  path: string;
}

interface RenameResult {
  success: boolean;
  newPath: string;
}

interface MovedFile {
  oldPath: string;
  newPath: string;
}

interface MoveResult {
  success: boolean;
  movedFiles: MovedFile[];
  errors: string[];
}

interface GitBranchResult {
  branch: string | null;
}

interface ImportResult {
  success: boolean;
  files: string[];
}

interface CopyResult {
  success: boolean;
  copiedFiles: CopiedFile[];
  /** Per-file failures (blacklist reject, fs error) — the batch keeps going,
   *  but callers must surface these: an all-rejected drop otherwise looks
   *  like a silent no-op refresh (cross-review 0.2.33, Codex W3). */
  errors: string[];
}

interface InternalCopyResult {
  success: boolean;
  copiedFiles: CopiedFile[];
  errors: string[];
}

interface ReadAsBase64Item {
  path: string;
  name: string;
  mimeType: string;
  data: string;
  error?: string | null;
}

interface ReadAsBase64Response {
  success: boolean;
  files: ReadAsBase64Item[];
}

interface PreparedUserImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
}

interface PrepareUserImageAttachmentError {
  path: string;
  name: string;
  code: string;
  message: string;
}

interface PrepareUserImageAttachmentsResponse {
  success: boolean;
  attachments: PreparedUserImageAttachment[];
  errors: PrepareUserImageAttachmentError[];
}

interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'custom' | 'skill';
  scope?: 'user' | 'project';
  path?: string;
  folderName?: string;
  fileName?: string;
}

interface SlashCommandsResponse {
  success: boolean;
  commands: SlashCommand[];
  globalSkillFolderNames: string[];
}

// Phase D.5 — batch existence check for inline-code paths in AI output.
interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

interface CheckPathsResult {
  results: Record<string, PathInfo>;
}

interface ReadClaudeMdResult {
  exists: boolean;
  path: string;
  content: string;
}

// Phase D.5 — token-based watcher handle. The renderer holds `token` for the
// lifetime of the watch, then passes it to `watchStop`. `eventKey` is the
// suffix to subscribe to via Tauri `listen()`.
interface WatchHandle {
  token: string;
  eventKey: string;
}

interface DeleteResult {
  success: boolean;
  deleted: boolean;
}

interface GitignoreResult {
  success: boolean;
  added: boolean;
  reason: string;
}

export interface InitializeWorkspaceProjectResult {
  workspacePath: string;
  gitInitialized: boolean;
  directoriesCreated: number;
  filesCreated: number;
}

/**
 * `WorkspaceFileService` exposes Rust workspace_files commands as a stable
 * callable surface.
 *
 * # Methods that REQUIRE a workspace (throw "请先选择工作区" if `workspacePath`
 * is null):
 * `importBase64Files`, `copyPaths`, `addGitignore`, `searchFiles`,
 * `deleteFile`, `listSlashCommands`, `dirTree`, `dirExpand`, `readPreview`,
 * `downloadFile`, `newFile`, `newFolder`, `rename`, `movePaths`,
 * `openInFinder`, `openWithDefault`, `readFileAsBlobUrl`, `gitBranch`,
 * `watchStart`, `checkPaths`.
 *
 * # Methods that DO NOT require a workspace (callable with `useWorkspaceFileService(null)`):
 * `initializeProject`, `openPathExternal`, `openPathWithDefault`, `checkLocalPaths`,
 * `readLocalPreview`, `downloadLocalFile`, `downloadLocalFileBytes`,
 * `readLocalFileAsBlobUrl` (all take absolute paths), `readPathsAsBase64`
 * (legacy absolute image path → base64), `prepareUserImageAttachments`
 * (absolute image path → app-owned attachment ref), `watchStop` (takes opaque token).
 *
 * Cross-review round 2 (Codex HIGH-3): consumers like SkillDetailPanel /
 * CommandDetailPanel pass `null` because they only need workspace-free
 * methods. Adding a workspace-required method to those panels would throw
 * at runtime — the JSDoc above is the source-of-truth for which methods
 * are safe to call when the hook was instantiated with `null`.
 */
export interface WorkspaceFileService {
  /** [workspace-free] Atomically create a brand-new workspace from a validated text blueprint. */
  initializeProject(args: {
    workspacePath: string;
    initialization: WorkbenchProjectInitialization;
  }): Promise<InitializeWorkspaceProjectResult>;
  /** [requires workspace] Import base64-encoded files into `<workspace>/<targetDir>/`. */
  importBase64Files(args: {
    files: { name: string; content: string }[];
    targetDir?: string;
  }): Promise<ImportResult>;
  /** [requires workspace] Copy absolute paths (drag-drop / file picker) into `<workspace>/<targetDir>/`. */
  copyPaths(args: {
    sourcePaths: string[];
    targetDir: string;
    autoRename?: boolean;
  }): Promise<CopyResult>;
  /** [requires workspace] Copy WORKSPACE-RELATIVE paths to another dir inside
   *  the same workspace (tree copy/paste). Collisions auto-rename. */
  copyInternal(args: {
    sourcePaths: string[];
    targetDir: string;
  }): Promise<InternalCopyResult>;
  /** [workspace-free] Read absolute image paths and return base64 (for Tauri image drops). */
  readPathsAsBase64(args: { paths: string[] }): Promise<ReadAsBase64Response>;
  /** [workspace-free] Copy absolute image paths into `~/.myagents/attachments/<sessionId>/`
   *  and return ref metadata. This is the primary path for chat image drops. */
  prepareUserImageAttachments(args: {
    sessionId: string;
    paths: string[];
  }): Promise<PrepareUserImageAttachmentsResponse>;
  /** [requires workspace] Append a pattern to `<workspace>/.gitignore` if not already present. */
  addGitignore(args: { pattern: string }): Promise<GitignoreResult>;
  /** [requires workspace] Fuzzy file-name search for the @ mention picker. */
  searchFiles(args: { query: string }): Promise<FileSearchResult[]>;
  /** [requires workspace] Delete a workspace-relative path (file / dir /
   *  broken symlink). Default goes to the OS trash; `permanent: true` keeps
   *  unlink semantics for scratch-file cleanup (don't pollute the trash with
   *  files the user never saw). */
  deleteFile(args: { path: string; permanent?: boolean }): Promise<DeleteResult>;
  /** [requires workspace] List slash-command picker entries — global + project skills + builtins. */
  listSlashCommands(): Promise<SlashCommandsResponse>;
  // ─── Phase D: DirectoryPanel ops ───
  /** [requires workspace] Initial directory tree walk (depth + entry capped on the Rust side). */
  dirTree(): Promise<DirectoryTreeResult>;
  /** [requires workspace] Lazy-expand a single directory marked `loaded:false` in the tree. */
  dirExpand(args: { path: string }): Promise<ExpandDirectoryResult>;
  /** [requires workspace] Read a previewable text file for the preview modal (≤2MB). */
  readPreview(args: { path: string }): Promise<PreviewResult>;
  /** [requires workspace] Read a binary file (image, etc.) as base64 for blob reconstruction. */
  downloadFile(args: { path: string }): Promise<DownloadResult>;
  /** [requires workspace] Read a binary file as RAW BYTES (ArrayBuffer) via
   *  `tauri::ipc::Response` — no base64 inflation / main-thread `atob`. Used by the
   *  rich-document viewers (pdf/docx/xlsx/pptx), where bytes go straight to the
   *  parser. ≤50MB. */
  downloadFileBytes(args: { path: string }): Promise<ArrayBuffer>;
  /** [requires workspace] */
  newFile(args: { parentDir: string; name: string }): Promise<CreatePathResult>;
  /** [requires workspace] */
  newFolder(args: { parentDir: string; name: string }): Promise<CreatePathResult>;
  /** [requires workspace] */
  rename(args: { oldPath: string; newName: string }): Promise<RenameResult>;
  /** [requires workspace] */
  movePaths(args: { sourcePaths: string[]; targetDir: string }): Promise<MoveResult>;
  /** [requires workspace] */
  openInFinder(args: { path: string }): Promise<void>;
  /** [requires workspace] */
  openWithDefault(args: { path: string }): Promise<void>;
  /** [workspace-free] Reveal an absolute path (NOT workspace-relative) in the
   *  OS file manager. Used by Skill/Command detail panels for
   *  `~/.myagents/skills/...`. The Rust side validates the path canonicalizes
   *  to under home_dir or tmp AND passes the credential blacklist.
   *
   *  Optional `workspace` widens the trusted-prefix list for project-scope
   *  callers whose path may live under `<project>/.claude/skills/...` on a
   *  non-system drive (issue #125 follow-up — Windows workspaces on `D:\`).
   *  Credential blacklist still applies. */
  openPathExternal(args: { fullPath: string; workspace?: string | null }): Promise<void>;
  /** [workspace-free] Open an absolute path with the OS default app (hand off like
   *  `open <path>`). Same safety surface as `openPathExternal` (home/tmp prefix +
   *  credential blacklist). Used by the audio attachment "more" menu (PRD 0.2.30). */
  openPathWithDefault(args: { fullPath: string; workspace?: string | null }): Promise<void>;
  /** [workspace-free] Batch existence check for absolute local paths. */
  checkLocalPaths(args: { paths: string[]; workspace?: string | null }): Promise<CheckPathsResult>;
  /** [workspace-free] Read an absolute local text file for preview. */
  readLocalPreview(args: { fullPath: string; workspace?: string | null }): Promise<PreviewResult>;
  /** [workspace-free] Read an absolute local file as base64 for image preview. */
  downloadLocalFile(args: { fullPath: string; workspace?: string | null }): Promise<DownloadResult>;
  /** [workspace-free] Read an absolute local file as raw bytes for rich-doc preview. */
  downloadLocalFileBytes(args: { fullPath: string; workspace?: string | null }): Promise<ArrayBuffer>;
  /** [requires workspace] Batch existence check — input order is preserved in the returned map. */
  checkPaths(args: { paths: string[] }): Promise<CheckPathsResult>;
  /** [requires workspace] Read a workspace file as a Blob URL (for `<img src=...>`
   *  in AI markdown / inline-code preview). Returns `{ blobUrl, mimeType,
   *  name, revoke }`. Caller MUST call `revoke()` on cleanup to free the
   *  object URL. */
  readFileAsBlobUrl(args: { path: string }): Promise<BlobUrlHandle>;
  /** [workspace-free] Read an absolute local file as a Blob URL (for image preview). */
  readLocalFileAsBlobUrl(args: { fullPath: string; workspace?: string | null }): Promise<BlobUrlHandle>;
  /** [requires workspace] Save edited content back to a workspace file.
   *  The file MUST already exist (no create-on-save). 2MB content cap.
   *  Atomic via tmp + rename. Resolves on success; rejects on failure. */
  saveFile(args: { path: string; content: string; expectedContent?: string }): Promise<void>;
  /** [requires workspace] Read `<workspace>/CLAUDE.md`. `exists:false` is
   *  not an error — Settings UI shows an empty editor in that case. */
  readClaudeMd(): Promise<ReadClaudeMdResult>;
  /** [requires workspace] Write `<workspace>/CLAUDE.md`. Creates if missing.
   *  Resolves on success; rejects on failure. */
  writeClaudeMd(args: { content: string }): Promise<void>;
  /** [requires workspace] */
  gitBranch(): Promise<GitBranchResult>;
  /** [requires workspace] Start the per-workspace fs watcher (ref-counted
   *  process-wide). Returns `{ token, eventKey }`: the renderer holds `token`
   *  for the lifetime of the watch and passes it to `watchStop`; `eventKey`
   *  is the suffix to subscribe to via Tauri
   *  `listen('workspace:files-changed:<eventKey>', ...)`. */
  watchStart(): Promise<WatchHandle>;
  /** [workspace-free] Release a watch handle issued by `watchStart`. Bad/stale
   *  tokens are a no-op (matches the "stop is best-effort" contract on the
   *  Rust side). */
  watchStop(args: { token: string }): Promise<void>;
  /** Whether the current environment supports these calls. False in browser dev mode. */
  isAvailable: boolean;
  /** The workspace path bound to this service. Useful for debug toasts. */
  workspacePath: string | null;
}

interface BlobUrlHandle {
  blobUrl: string;
  mimeType: string;
  name: string;
  /** Releases the object URL. Calling more than once is safe. */
  revoke: () => void;
}

export function useWorkspaceFileService(workspacePath: string | null): WorkspaceFileService {
  const tauri = isTauriEnvironment();
  const browserDev = isBrowserDevMode();

  const invokeIfTauri = useCallback(async <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    if (!tauri) {
      if (!browserDev || !workspacePath) {
        throw new Error(workspaceFileText('desktopOnly'));
      }
      const response = await apiPostJson<{ success: true; data: T }>(
        '/api/workbench-dev-storage/request',
        { workspacePath, command: cmd, args },
      );
      return response.data;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }, [browserDev, tauri, workspacePath]);

  const requireWorkspace = useCallback(() => {
    if (!workspacePath) {
      throw new Error(workspaceFileText('selectWorkspaceFirst'));
    }
    return workspacePath;
  }, [workspacePath]);

  const initializeProject: WorkspaceFileService['initializeProject'] = useCallback(
    async ({ workspacePath: targetPath, initialization }) => {
      return invokeIfTauri<InitializeWorkspaceProjectResult>('cmd_workspace_initialize_project', {
        workspacePath: targetPath,
        initialization,
      });
    },
    [invokeIfTauri],
  );

  const importBase64Files: WorkspaceFileService['importBase64Files'] = useCallback(
    async ({ files, targetDir }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<ImportResult>('cmd_workspace_import_files_b64', {
        workspace: ws,
        files,
        targetDir,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const copyPaths: WorkspaceFileService['copyPaths'] = useCallback(
    async ({ sourcePaths, targetDir, autoRename }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CopyResult>('cmd_workspace_copy_paths', {
        workspace: ws,
        sourcePaths,
        targetDir,
        autoRename,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const copyInternal: WorkspaceFileService['copyInternal'] = useCallback(
    async ({ sourcePaths, targetDir }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<InternalCopyResult>('cmd_workspace_copy_internal', {
        workspace: ws,
        sourcePaths,
        targetDir,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readPathsAsBase64: WorkspaceFileService['readPathsAsBase64'] = useCallback(
    async ({ paths }) => {
      // Doesn't need a workspace — paths are absolute.
      return invokeIfTauri<ReadAsBase64Response>('cmd_workspace_read_files_b64', { paths });
    },
    [invokeIfTauri],
  );

  const prepareUserImageAttachments: WorkspaceFileService['prepareUserImageAttachments'] = useCallback(
    async ({ sessionId, paths }) => {
      // Doesn't need a workspace — paths are absolute and destination is app-owned.
      return invokeIfTauri<PrepareUserImageAttachmentsResponse>('cmd_prepare_user_image_attachments', {
        sessionId,
        paths,
      });
    },
    [invokeIfTauri],
  );

  const addGitignore: WorkspaceFileService['addGitignore'] = useCallback(
    async ({ pattern }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<GitignoreResult>('cmd_workspace_add_gitignore', {
        workspace: ws,
        pattern,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const searchFiles: WorkspaceFileService['searchFiles'] = useCallback(
    async ({ query }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<FileSearchResult[]>('cmd_workspace_search_files_fuzzy', {
        workspace: ws,
        query,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const deleteFile: WorkspaceFileService['deleteFile'] = useCallback(
    async ({ path, permanent }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<DeleteResult>('cmd_workspace_delete', {
        workspace: ws,
        path,
        permanent,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const listSlashCommands: WorkspaceFileService['listSlashCommands'] = useCallback(
    async () => {
      const ws = requireWorkspace();
      return invokeIfTauri<SlashCommandsResponse>('cmd_list_slash_commands', {
        workspace: ws,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const dirTree: WorkspaceFileService['dirTree'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<DirectoryTreeResult>('cmd_workspace_dir_tree', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const dirExpand: WorkspaceFileService['dirExpand'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<ExpandDirectoryResult>('cmd_workspace_dir_expand', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readPreview: WorkspaceFileService['readPreview'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<PreviewResult>('cmd_workspace_read_preview', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const downloadFile: WorkspaceFileService['downloadFile'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<DownloadResult>('cmd_workspace_download_file', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const downloadFileBytes: WorkspaceFileService['downloadFileBytes'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      // Raw bytes via `tauri::ipc::Response` → invoke resolves to an ArrayBuffer.
      return invokeIfTauri<ArrayBuffer>('cmd_workspace_download_bytes', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const newFile: WorkspaceFileService['newFile'] = useCallback(
    async ({ parentDir, name }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CreatePathResult>('cmd_workspace_new_file', {
        workspace: ws,
        parentDir,
        name,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const newFolder: WorkspaceFileService['newFolder'] = useCallback(
    async ({ parentDir, name }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CreatePathResult>('cmd_workspace_new_folder', {
        workspace: ws,
        parentDir,
        name,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const rename: WorkspaceFileService['rename'] = useCallback(
    async ({ oldPath, newName }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<RenameResult>('cmd_workspace_rename', {
        workspace: ws,
        oldPath,
        newName,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const movePaths: WorkspaceFileService['movePaths'] = useCallback(
    async ({ sourcePaths, targetDir }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<MoveResult>('cmd_workspace_move', {
        workspace: ws,
        sourcePaths,
        targetDir,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openInFinder: WorkspaceFileService['openInFinder'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_open_in_finder', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openWithDefault: WorkspaceFileService['openWithDefault'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_open_with_default', {
        workspace: ws,
        path,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const openPathExternal: WorkspaceFileService['openPathExternal'] = useCallback(
    async ({ fullPath, workspace }) => {
      // No workspace required — this command takes an absolute path.
      // `workspace` is optional: when present (project-scope skill/command
      // on a non-system drive), Rust adds it to the trusted-prefix list.
      await invokeIfTauri<void>('cmd_open_path_external', {
        fullPath,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const openPathWithDefault: WorkspaceFileService['openPathWithDefault'] = useCallback(
    async ({ fullPath, workspace }) => {
      // No workspace required — absolute path. Mirrors openPathExternal but hands
      // off to the OS default app (cmd_open_path_with_default → spawn_default_open).
      await invokeIfTauri<void>('cmd_open_path_with_default', {
        fullPath,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const checkLocalPaths: WorkspaceFileService['checkLocalPaths'] = useCallback(
    async ({ paths, workspace }) => {
      return invokeIfTauri<CheckPathsResult>('cmd_check_local_paths', {
        paths,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const readLocalPreview: WorkspaceFileService['readLocalPreview'] = useCallback(
    async ({ fullPath, workspace }) => {
      return invokeIfTauri<PreviewResult>('cmd_read_local_preview', {
        fullPath,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const downloadLocalFile: WorkspaceFileService['downloadLocalFile'] = useCallback(
    async ({ fullPath, workspace }) => {
      return invokeIfTauri<DownloadResult>('cmd_download_local_file', {
        fullPath,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const downloadLocalFileBytes: WorkspaceFileService['downloadLocalFileBytes'] = useCallback(
    async ({ fullPath, workspace }) => {
      return invokeIfTauri<ArrayBuffer>('cmd_download_local_bytes', {
        fullPath,
        workspace: workspace?.trim() || null,
      });
    },
    [invokeIfTauri],
  );

  const checkPaths: WorkspaceFileService['checkPaths'] = useCallback(
    async ({ paths }) => {
      const ws = requireWorkspace();
      return invokeIfTauri<CheckPathsResult>('cmd_workspace_check_paths', {
        workspace: ws,
        paths,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readFileAsBlobUrl: WorkspaceFileService['readFileAsBlobUrl'] = useCallback(
    async ({ path }) => {
      const ws = requireWorkspace();
      const result = await invokeIfTauri<DownloadResult>('cmd_workspace_download_file', {
        workspace: ws,
        path,
      });
      // Decode base64 → Uint8Array → Blob → object URL. The Rust side caps
      // payload at 25MB so this can't blow up the renderer heap. The decoded
      // intermediate buffer is freed once the Blob takes ownership.
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      let revoked = false;
      const revoke = () => {
        if (revoked) return;
        revoked = true;
        URL.revokeObjectURL(blobUrl);
      };
      return { blobUrl, mimeType: result.mimeType, name: result.name, revoke };
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readLocalFileAsBlobUrl: WorkspaceFileService['readLocalFileAsBlobUrl'] = useCallback(
    async ({ fullPath, workspace }) => {
      const result = await downloadLocalFile({ fullPath, workspace });
      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: result.mimeType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      let revoked = false;
      const revoke = () => {
        if (revoked) return;
        revoked = true;
        URL.revokeObjectURL(blobUrl);
      };
      return { blobUrl, mimeType: result.mimeType, name: result.name, revoke };
    },
    [downloadLocalFile],
  );

  const saveFile: WorkspaceFileService['saveFile'] = useCallback(
    async ({ path, content, expectedContent }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_save_file', {
        workspace: ws,
        path,
        content,
        expectedContent,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const readClaudeMd: WorkspaceFileService['readClaudeMd'] = useCallback(
    async () => {
      const ws = requireWorkspace();
      return invokeIfTauri<ReadClaudeMdResult>('cmd_workspace_read_claude_md', {
        workspace: ws,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const writeClaudeMd: WorkspaceFileService['writeClaudeMd'] = useCallback(
    async ({ content }) => {
      const ws = requireWorkspace();
      await invokeIfTauri<void>('cmd_workspace_write_claude_md', {
        workspace: ws,
        content,
      });
    },
    [requireWorkspace, invokeIfTauri],
  );

  const gitBranch: WorkspaceFileService['gitBranch'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<GitBranchResult>('cmd_workspace_git_branch', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const watchStart: WorkspaceFileService['watchStart'] = useCallback(async () => {
    const ws = requireWorkspace();
    return invokeIfTauri<WatchHandle>('cmd_workspace_watch_start', { workspace: ws });
  }, [requireWorkspace, invokeIfTauri]);

  const watchStop: WorkspaceFileService['watchStop'] = useCallback(
    async ({ token }) => {
      // No workspace required — token is the registry key on the Rust side.
      await invokeIfTauri<void>('cmd_workspace_watch_stop', { token });
    },
    [invokeIfTauri],
  );

  // Wrap the returned object in useMemo so consumers that put `fileService`
  // in `useCallback` deps (e.g. SimpleChatInput's processDroppedFiles,
  // searchFiles, fetchCommands — ~10 sites) don't rebuild on every keystroke.
  // Pre-PRD-0.2.7 the legacy `apiPost`/`apiGet` came from a stable Tab context;
  // this useMemo restores that render-loop stability.
  const isAvailable = (tauri || browserDev) && workspacePath != null;
  return useMemo(
    () => ({
      initializeProject,
      importBase64Files,
      copyPaths,
      copyInternal,
      readPathsAsBase64,
      prepareUserImageAttachments,
      addGitignore,
      searchFiles,
      deleteFile,
      listSlashCommands,
      // Phase D
      dirTree,
      dirExpand,
      readPreview,
      downloadFile,
      downloadFileBytes,
      newFile,
      newFolder,
      rename,
      movePaths,
      openInFinder,
      openWithDefault,
      openPathExternal,
      openPathWithDefault,
      checkLocalPaths,
      readLocalPreview,
      downloadLocalFile,
      downloadLocalFileBytes,
      checkPaths,
      readFileAsBlobUrl,
      readLocalFileAsBlobUrl,
      saveFile,
      readClaudeMd,
      writeClaudeMd,
      gitBranch,
      watchStart,
      watchStop,
      isAvailable,
      workspacePath,
    }),
    [
      initializeProject,
      importBase64Files,
      copyPaths,
      copyInternal,
      readPathsAsBase64,
      prepareUserImageAttachments,
      addGitignore,
      searchFiles,
      deleteFile,
      listSlashCommands,
      dirTree,
      dirExpand,
      readPreview,
      downloadFile,
      downloadFileBytes,
      newFile,
      newFolder,
      rename,
      movePaths,
      openInFinder,
      openWithDefault,
      openPathExternal,
      openPathWithDefault,
      checkLocalPaths,
      readLocalPreview,
      downloadLocalFile,
      downloadLocalFileBytes,
      checkPaths,
      readFileAsBlobUrl,
      readLocalFileAsBlobUrl,
      saveFile,
      readClaudeMd,
      writeClaudeMd,
      gitBranch,
      watchStart,
      watchStop,
      isAvailable,
      workspacePath,
    ],
  );
}
