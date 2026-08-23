import type {
  ContentBlock,
  SubagentToolCall,
  ToolUseSimple,
} from '@/types/chat';
import {
  resolveFileActionTarget,
  resolveAgainstWorkspace,
  type FileActionTarget,
} from '@/utils/workspaceFileLinks';
import {
  coerceFileChanges,
  fileChangeKindLabel,
  fileChangeMovePath,
  resolveFilePatchRenderModel,
  resolveToolInputRecords,
  type FilePatchRenderChange,
  type FilePatchRenderModel,
  type FilePatchToolLike,
} from '../../shared/toolDisplay/filePatch';
import { normalizeWorkspacePathIdentity } from '../../shared/workspacePath';

export type TurnFileEditStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'edited';

export interface TurnFileEditItem {
  identityPath: string;
  displayPath: string;
  originalPath?: string;
  actionTarget: FileActionTarget;
  status: TurnFileEditStatus;
  added: number;
  removed: number;
  statsReliable: boolean;
}

export interface TurnFileEditSummary {
  files: TurnFileEditItem[];
  totalAdded: number;
  totalRemoved: number;
  allStatsReliable: boolean;
}

type CompletedTool = FilePatchToolLike & {
  isLoading?: boolean;
  isStopped?: boolean;
  isFailed?: boolean;
};

interface MutableEdit extends TurnFileEditItem {
  sawRename: boolean;
}

const FAILURE_STATUS = /^(?:failed|failure|error|declined|cancelled|canceled|aborted|stopped)$/i;

/**
 * Derive the Turn-level file edit record from existing structured tool data.
 * This is deliberately pure: it does not inspect the filesystem and therefore
 * never claims to be a workspace net diff.
 */
export function deriveTurnFileEdits(
  content: string | readonly ContentBlock[],
  workspacePath: string | null | undefined,
): TurnFileEditSummary | null {
  if (typeof content === 'string') return null;

  const edits = new Map<string, MutableEdit>();
  for (const block of content) {
    if ((block.type !== 'tool_use' && block.type !== 'server_tool_use') || !block.tool) {
      continue;
    }
    collectCompletedTool(block.tool, workspacePath, edits);
    for (const nested of block.tool.subagentCalls ?? []) {
      collectCompletedTool(nested, workspacePath, edits);
    }
  }

  if (edits.size === 0) return null;
  const files = [...edits.values()]
    .map(({ sawRename: _sawRename, ...edit }) => edit)
    .sort((left, right) => left.identityPath.localeCompare(right.identityPath));
  return {
    files,
    totalAdded: files.reduce((total, file) => total + file.added, 0),
    totalRemoved: files.reduce((total, file) => total + file.removed, 0),
    allStatsReliable: files.every((file) => file.statsReliable),
  };
}

function collectCompletedTool(
  tool: ToolUseSimple | SubagentToolCall,
  workspacePath: string | null | undefined,
  edits: Map<string, MutableEdit>,
): void {
  if (!isCompletedTool(tool)) return;

  let model: FilePatchRenderModel | null = null;
  try {
    model = resolveFilePatchRenderModel(tool);
  } catch {
    return;
  }
  if (!model) return;
  if (model.status && FAILURE_STATUS.test(model.status.trim())) return;

  const changes = resolveCompleteTurnChanges(tool, model);
  if (!changes) return;

  // One malformed path invalidates only this Tool. Build against a copy so a
  // partially valid record never leaks a partial Turn summary.
  const nextEdits = new Map(edits);
  for (const change of changes) {
    if (!collectChange(change, model, workspacePath, nextEdits)) return;
  }
  edits.clear();
  for (const [identity, edit] of nextEdits) {
    edits.set(identity, edit);
  }
}

function resolveCompleteTurnChanges(
  tool: FilePatchToolLike,
  model: FilePatchRenderModel,
): FilePatchRenderChange[] | null {
  if (model.summary.files <= model.changes.length) return model.changes;

  // The normal diff renderer intentionally materializes at most 100 files.
  // Completed Codex/FileChange input retains the full structured boundary, so
  // recover only the cheap identity/stat projection without materializing rows.
  for (const input of resolveToolInputRecords(tool)) {
    const rawChanges = input.changes;
    if (!Array.isArray(rawChanges) || rawChanges.length !== model.summary.files) continue;
    const changes = coerceFileChanges(rawChanges);
    if (changes.length !== rawChanges.length) return null;

    const complete: FilePatchRenderChange[] = [];
    for (const [index, change] of changes.entries()) {
      if (typeof change.path !== 'string' || !change.path.trim()) return null;
      if (typeof change.diff !== 'string') return null;
      const kind = fileChangeKindLabel(change.kind);
      const movePath = fileChangeMovePath(change.kind) ?? undefined;
      const projected = model.changes[index];
      complete.push({
        kind,
        path: change.path,
        ...(movePath ? { movePath } : {}),
        added: projected?.added ?? 0,
        removed: projected?.removed ?? 0,
        viewKind: 'unified-diff',
        rows: [],
        rawPatch: '',
        lineNumbers: projected?.lineNumbers ?? 'unavailable',
        detailUnavailable: true,
        hasHiddenContent: true,
      });
    }
    return complete;
  }
  return null;
}

function isCompletedTool(tool: CompletedTool): boolean {
  if (
    tool.isLoading
    || tool.isError
    || tool.isStopped
    || tool.isFailed
    || tool.result === undefined
  ) {
    return false;
  }
  const status = tool.resultMeta?.status;
  return typeof status !== 'string' || !FAILURE_STATUS.test(status.trim());
}

function collectChange(
  change: FilePatchRenderChange,
  model: FilePatchRenderModel,
  workspacePath: string | null | undefined,
  edits: Map<string, MutableEdit>,
): boolean {
  if (!change.path) return false;
  const source = resolveStructuredToolTarget(change.path, workspacePath);
  if (!source) return false;

  const kind = statusForChange(change, model);
  const statsReliable = statsAreReliable(change, model);
  if (kind === 'renamed' && change.movePath) {
    const destination = resolveStructuredToolTarget(change.movePath, workspacePath);
    if (!destination) return false;
    collectRename(
      source,
      destination,
      change.path,
      change.movePath,
      change,
      statsReliable,
      workspacePath,
      edits,
    );
    return true;
  }

  const identityPath = actionIdentity(source, workspacePath);
  const previous = edits.get(identityPath);
  const status = nextStatus(previous?.status, kind, previous?.sawRename ?? false);
  edits.set(identityPath, {
    identityPath,
    displayPath: displayPathForTarget(source),
    actionTarget: source,
    status,
    added: (previous?.added ?? 0) + change.added,
    removed: (previous?.removed ?? 0) + change.removed,
    statsReliable: (previous?.statsReliable ?? true) && statsReliable,
    sawRename: previous?.sawRename ?? false,
    ...(previous?.originalPath ? { originalPath: previous.originalPath } : {}),
  });
  return true;
}

function resolveStructuredToolTarget(
  path: string,
  workspacePath: string | null | undefined,
): FileActionTarget | null {
  const absolute = resolveAgainstWorkspace(path, workspacePath);
  return resolveFileActionTarget(absolute ?? path, workspacePath);
}

function collectRename(
  source: FileActionTarget,
  destination: FileActionTarget,
  sourceDisplayPath: string,
  destinationDisplayPath: string,
  change: FilePatchRenderChange,
  statsReliable: boolean,
  workspacePath: string | null | undefined,
  edits: Map<string, MutableEdit>,
): void {
  const sourceIdentity = actionIdentity(source, workspacePath);
  const destinationIdentity = actionIdentity(destination, workspacePath);
  const previous = edits.get(sourceIdentity) ?? edits.get(destinationIdentity);
  edits.delete(sourceIdentity);
  edits.delete(destinationIdentity);
  edits.set(destinationIdentity, {
    identityPath: destinationIdentity,
    displayPath: displayPathForTarget(destination) || destinationDisplayPath,
    originalPath: previous?.originalPath ?? displayPathForTarget(source) ?? sourceDisplayPath,
    actionTarget: destination,
    status: 'renamed',
    added: (previous?.added ?? 0) + change.added,
    removed: (previous?.removed ?? 0) + change.removed,
    statsReliable: (previous?.statsReliable ?? true) && statsReliable,
    sawRename: true,
  });
}

function statusForChange(
  change: FilePatchRenderChange,
  model: FilePatchRenderModel,
): TurnFileEditStatus {
  const kind = change.kind.trim().toLowerCase();
  if (change.movePath || kind === 'move' || kind === 'rename') return 'renamed';
  if (kind === 'add' || kind === 'create') return 'added';
  if (kind === 'delete' || kind === 'remove') return 'deleted';
  if (kind === 'update' || kind === 'edit' || kind === 'replace') return 'modified';
  if (kind === 'write') {
    if (model.writeMode === 'create') return 'added';
    if (model.writeMode === 'update') return 'modified';
  }
  return 'edited';
}

function nextStatus(
  previous: TurnFileEditStatus | undefined,
  current: TurnFileEditStatus,
  sawRename: boolean,
): TurnFileEditStatus {
  if (!previous) return current;
  if (current === 'deleted') return 'deleted';
  if (sawRename && (current === 'modified' || current === 'edited')) return 'renamed';
  if (previous === 'added' && (current === 'modified' || current === 'edited')) return 'added';
  if (previous === 'deleted' && current === 'added') return 'modified';
  return current;
}

function statsAreReliable(
  change: FilePatchRenderChange,
  model: FilePatchRenderModel,
): boolean {
  const kind = change.kind.trim().toLowerCase();
  if (kind === 'write' && model.writeMode === 'unknown') return false;
  if (model.hasHiddenContent || change.hasHiddenContent) return false;
  return !(
    change.detailUnavailable
    && change.added === 0
    && change.removed === 0
    && model.source === 'unknown'
  );
}

function actionIdentity(
  target: FileActionTarget,
  workspacePath: string | null | undefined,
): string {
  const normalized = target.scope === 'local'
    ? normalizeWorkspacePathIdentity(target.path)
    : target.path.replace(/\\/g, '/');
  const workspaceIsWindows = !!workspacePath && (
    /^[A-Za-z]:[\\/]/.test(workspacePath) || /^[\\/]{2}/.test(workspacePath)
  );
  const comparable = target.scope === 'workspace' && workspaceIsWindows
    ? normalized.toLowerCase()
    : normalized;
  return `${target.scope}:${comparable}`;
}

function displayPathForTarget(target: FileActionTarget): string {
  return target.scope === 'workspace' ? target.path.replace(/\\/g, '/') : target.path;
}
