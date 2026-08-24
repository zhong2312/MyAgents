/**
 * FileActionContext — provides inline-code path checking and context menu actions.
 *
 * Used by markdown InlineCode to detect real file/folder paths in AI output
 * and offer quick actions (preview, reference, open-in-finder).
 *
 * Only provided inside Chat; Settings / other pages get null from useFileAction().
 */
import { AtSign, Copy, ExternalLink, Eye, FolderOpen, LocateFixed, PanelRightOpen } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import ContextMenu from '@/components/ContextMenu';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { useToastOptional } from '@/components/Toast';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { getRichDocKind, isImageFile, isPreviewable, type RichDocKind } from '../../shared/fileTypes';
import type { FilePreviewFocusTarget } from '@/types/filePreview';
import {
  resolveFileLinkTarget,
  type FileActionTarget,
} from '@/utils/workspaceFileLinks';
import { copyPlainText } from '@/utils/clipboard';
import { normalizeWorkspacePathIdentity } from '../../shared/workspacePath';

// Lazy load FilePreviewModal (heavy: includes SyntaxHighlighter + Monaco)
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));

// ---------- Types ----------

export interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

type FileActionScope = FileActionTarget['scope'];

interface PathCacheEntry {
  info: PathInfo;
  scope: FileActionScope;
  verifiedAt: number;
}

interface FileMenuState {
  x: number;
  y: number;
  path: string;
  scope: FileActionScope;
  pathType: 'file' | 'dir';
  displayPath: string;
  contextIdentity: string;
  initialLineNumber?: number;
  zIndex?: number;
}

export interface FileActionMenuOptions {
  displayPath?: string;
  /** Render above the caller's host overlay when the menu is nested. */
  zIndex?: number;
  /** Lifecycle callbacks describe the standard menu surface, not its actions. */
  onOpen?: () => void;
  onClose?: () => void;
}

export interface FileActionContextValue {
  /** Synchronous cache lookup. Returns cached result or null (pending / not yet requested). */
  checkPath: (path: string) => PathInfo | null;
  /** Synchronous cache lookup for a resolved workspace/local target. */
  checkFileTarget: (target: FileActionTarget) => PathInfo | null;
  /** Register a mounted inferred target. The first consumer schedules the
   *  batched check; the last cleanup removes work that has not started. */
  subscribeFileTarget: (target: FileActionTarget) => () => void;
  /** Incremented each time the cache is updated, so consumers can re-render. */
  cacheVersion: number;
  /** Re-check a resolved target, then open its context menu only while it is
   *  still an existing, safety-approved file/directory. */
  openFileTargetMenu: (
    x: number,
    y: number,
    target: FileActionTarget,
    options?: FileActionMenuOptions,
  ) => () => void;
  /** Execute the target's primary action. Previewable files open internally,
   *  workspace directories reveal in the tree, and unsupported targets report
   *  a non-destructive hint instead of launching an OS application. */
  openFileTarget: (
    target: FileActionTarget,
    options?: { displayPath?: string; forceExternal?: boolean },
  ) => void;
  /** Workspace root, for resolving workspace-relative paths to absolute (e.g. the
   *  inline audio play button, whose player needs an absolute path). May be null
   *  outside a workspace. */
  workspacePath: string | null;
}

export interface FileLinkActionContextValue {
  /** Claims and previews/opens a Markdown link when it targets a local file. */
  openFileLink: (href: string, options?: { forceExternal?: boolean }) => boolean;
  /** Claims and opens the shared file context menu for a Markdown local-file link. */
  openFileLinkMenu: (x: number, y: number, href: string) => boolean;
}

interface FileActionProviderProps {
  children: ReactNode;
  /** Workspace path for resolving relative paths (Phase D.5: was previously
   *  inferred from sidecar's `currentAgentDir`; now passed explicitly so the
   *  Provider doesn't depend on a sidecar). */
  workspacePath: string | null;
  /** Callback to insert @-reference into the chat input. */
  onInsertReference?: (paths: string[]) => void;
  /** Controlled invalidation signal (workspace watcher / explicit refresh).
   *  Do not wire per-tool completion: that previously caused requery storms. */
  refreshTrigger?: number;
  /** When provided, "预览" routes to this callback (split-view) instead of fullscreen modal. */
  onFilePreviewExternal?: (file: {
    name: string;
    content: string;
    size: number;
    path: string;
    sourceScope?: FileActionScope;
    localPath?: string;
    richDocKind?: RichDocKind;
    initialLineNumber?: number;
    focusTarget?: FilePreviewFocusTarget;
  }) => void;
  /** Append `@<path> ` to chat input — wired to FilePreviewModal's「引用文件」button.
   *  Distinct from `onInsertReference` (cursor-insert, no trailing space) — the toolbar
   *  button always appends to end with trailing space, matching the「丢进对话框继续聊」 UX. */
  onQuoteFile?: (path: string) => void;
  /** Append `@<path>#L<start>[-L<end>] ` to chat input — wired to FilePreviewModal's
   *  Monaco selection-quote affordance. */
  onQuoteSelection?: (path: string, startLine: number, endLine: number) => void;
  /** Reveal a workspace-relative path in the right-side directory tree (expand
   *  ancestors + select + scroll into view). Reuses the same mechanism as the
   *  search panel's「在文件目录中展示」. When omitted, the menu item is hidden. */
  onRevealInTree?: (path: string) => void;
  /** Menu surface. Default keeps the full Chat menu; floatingBall uses the
   *  companion-specific four-action menu requested for the mini window. */
  menuProfile?: 'default' | 'floatingBall';
  /** Floating-ball only: raise MyAgents, focus the session tab, and open the
   *  given workspace-relative file in the main preview surface. */
  onOpenMyAgentsPreview?: (
    path: string,
    options?: { displayPath?: string; initialLineNumber?: number },
  ) => void;
}

// ---------- Context ----------

const FileActionContext = createContext<FileActionContextValue | null>(null);
const FileLinkActionContext = createContext<FileLinkActionContextValue | null>(null);

export function useFileAction(): FileActionContextValue | null {
  return useContext(FileActionContext);
}

/**
 * Mounted-consumer boundary for inferred file affordances.
 *
 * Rendering reads the cache only. Subscription and filesystem work start in
 * an effect, so abandoned/speculative renders and virtualized rows that unmount
 * before the 50 ms batch do not leak into provider-owned IO/cache state.
 */
export function useFileTargetInfo(target: FileActionTarget | null): PathInfo | null {
  const fileAction = useFileAction();
  const subscribeFileTarget = fileAction?.subscribeFileTarget;
  const scope = target?.scope;
  const path = target?.path;

  useEffect(() => {
    if (!subscribeFileTarget || !scope || !path) return;
    return subscribeFileTarget({ scope, path });
  }, [path, scope, subscribeFileTarget]);

  return fileAction && target ? fileAction.checkFileTarget(target) : null;
}

export function useFileLinkAction(): FileLinkActionContextValue | null {
  return useContext(FileLinkActionContext);
}

// ---------- Provider ----------

const BATCH_DELAY_MS = 50;
const MAX_PATHS_PER_BATCH = 200;
const LOCAL_PATH_LEASE_MS = 30_000;

function targetCacheKey(target: FileActionTarget, contextIdentity: string): string {
  return `${contextIdentity}\0${target.scope}:${target.path}`;
}

function targetFileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function FileActionProvider({ children, workspacePath, onInsertReference, refreshTrigger, onFilePreviewExternal, onQuoteFile, onQuoteSelection, onRevealInTree, menuProfile = 'default', onOpenMyAgentsPreview }: FileActionProviderProps) {
  const { t } = useTranslation('app');
  const fileService = useWorkspaceFileService(workspacePath);
  const { openPreview: openImagePreview } = useImagePreview();

  // Optional so the Provider has no hard dependency on a ToastProvider above
  // (isolated component tests mount it without one). Held in a ref per the
  // project's React-stability rules so handlers don't re-bind on toast changes.
  const toast = useToastOptional();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [menuState, setMenuState] = useState<FileMenuState | null>(null);
  const menuCloseCallbackRef = useRef<(() => void) | null>(null);
  const menuIntentIdRef = useRef(0);
  const closeMenu = useCallback(() => {
    menuIntentIdRef.current += 1;
    setMenuState(null);
    const onClose = menuCloseCallbackRef.current;
    menuCloseCallbackRef.current = null;
    onClose?.();
  }, []);

  // Stabilise callbacks via refs
  const onInsertReferenceRef = useRef(onInsertReference);
  onInsertReferenceRef.current = onInsertReference;

  const onFilePreviewExternalRef = useRef(onFilePreviewExternal);
  onFilePreviewExternalRef.current = onFilePreviewExternal;

  const onRevealInTreeRef = useRef(onRevealInTree);
  onRevealInTreeRef.current = onRevealInTree;

  const onOpenMyAgentsPreviewRef = useRef(onOpenMyAgentsPreview);
  onOpenMyAgentsPreviewRef.current = onOpenMyAgentsPreview;

  // Stabilise fileService so async closures see the latest service without
  // re-binding callbacks. Mirrors the React-stability rules pattern used
  // elsewhere (toastRef, apiPostRef in legacy code).
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;

  // Guard against setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ---------- Path cache ----------
  const workspaceIdentity = normalizeWorkspacePathIdentity(workspacePath ?? '');
  const cacheContextIdentity = `${workspaceIdentity}\0${refreshTrigger ?? 0}`;
  const cacheContextIdentityRef = useRef(cacheContextIdentity);
  cacheContextIdentityRef.current = cacheContextIdentity;
  const cacheContextInitializedRef = useRef(false);

  const cacheGenerationRef = useRef(0);
  const pathCacheRef = useRef<Map<string, PathCacheEntry>>(new Map());
  const mountedTargetsRef = useRef<Map<string, { target: FileActionTarget; count: number }>>(new Map());
  const pendingTargetsRef = useRef<Map<string, FileActionTarget>>(new Map());
  const inFlightTargetKeysRef = useRef<Set<string>>(new Set());
  const targetRequestVersionRef = useRef<Map<string, number>>(new Map());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localLeaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  const enqueueTargetRef = useRef<(key: string, target: FileActionTarget) => void>(() => {});

  const scheduleLocalLeaseExpiryRef = useRef<() => void>(() => {});
  const scheduleLocalLeaseExpiry = useCallback(() => {
    if (localLeaseTimerRef.current) {
      clearTimeout(localLeaseTimerRef.current);
      localLeaseTimerRef.current = null;
    }

    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const entry of pathCacheRef.current.values()) {
      if (entry.scope === 'local') {
        earliestExpiry = Math.min(earliestExpiry, entry.verifiedAt + LOCAL_PATH_LEASE_MS);
      }
    }
    if (!Number.isFinite(earliestExpiry)) return;

    localLeaseTimerRef.current = setTimeout(() => {
      localLeaseTimerRef.current = null;
      if (!isMountedRef.current) return;

      const now = Date.now();
      let invalidated = false;
      const expiredKeys: string[] = [];
      for (const [key, entry] of pathCacheRef.current) {
        if (entry.scope === 'local' && entry.verifiedAt + LOCAL_PATH_LEASE_MS <= now) {
          pathCacheRef.current.delete(key);
          expiredKeys.push(key);
          invalidated = true;
        }
      }
      if (invalidated) setCacheVersion((version) => version + 1);
      for (const key of expiredKeys) {
        const mounted = mountedTargetsRef.current.get(key);
        if (mounted?.count) enqueueTargetRef.current(key, mounted.target);
      }
      scheduleLocalLeaseExpiryRef.current();
    }, Math.max(0, earliestExpiry - Date.now()));
  }, []);
  scheduleLocalLeaseExpiryRef.current = scheduleLocalLeaseExpiry;

  // Clear cache when refreshTrigger changes
  useEffect(() => {
    // There is no prior context to invalidate on the initial mount. Child
    // consumers may already have subscribed and scheduled the first batch by
    // the time this provider effect runs, so clearing the timer here would
    // strand those targets until another render happened to resubscribe them.
    if (!cacheContextInitializedRef.current) {
      cacheContextInitializedRef.current = true;
      return;
    }

    cacheGenerationRef.current += 1;
    pathCacheRef.current.clear();
    closeMenu();
    const currentPrefix = `${cacheContextIdentity}\0`;
    for (const key of pendingTargetsRef.current.keys()) {
      if (!key.startsWith(currentPrefix)) pendingTargetsRef.current.delete(key);
    }
    for (const key of inFlightTargetKeysRef.current) {
      if (!key.startsWith(currentPrefix)) inFlightTargetKeysRef.current.delete(key);
    }
    for (const key of targetRequestVersionRef.current.keys()) {
      if (!key.startsWith(currentPrefix)) targetRequestVersionRef.current.delete(key);
    }
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (localLeaseTimerRef.current) {
      clearTimeout(localLeaseTimerRef.current);
      localLeaseTimerRef.current = null;
    }
    // Effect ordering differs between an already-mounted consumer and a newly
    // mounted one. If the consumer has already resubscribed under the new
    // context, explicitly queue it after cancelling the old context's timer;
    // otherwise its own subsequent effect will do the same work.
    for (const [key, mounted] of mountedTargetsRef.current) {
      if (key.startsWith(currentPrefix) && mounted.count > 0) {
        enqueueTargetRef.current(key, mounted.target);
      }
    }
    setCacheVersion(v => v + 1);
  }, [cacheContextIdentity, closeMenu]);

  // Clean up batch timer on unmount
  useEffect(() => {
    const mountedTargets = mountedTargetsRef.current;
    const pendingTargets = pendingTargetsRef.current;
    const inFlightTargetKeys = inFlightTargetKeysRef.current;
    const targetRequestVersions = targetRequestVersionRef.current;
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      if (localLeaseTimerRef.current) {
        clearTimeout(localLeaseTimerRef.current);
        localLeaseTimerRef.current = null;
      }
      mountedTargets.clear();
      pendingTargets.clear();
      inFlightTargetKeys.clear();
      targetRequestVersions.clear();
    };
  }, []);

  // Flush pending paths to the backend (Rust workspace_files::check_paths
  // since Phase D.5 — used to be sidecar `/agent/check-paths`).
  const flushPendingPaths = useCallback(() => {
    const targetEntries = Array.from(pendingTargetsRef.current.entries());
    const targets = targetEntries.map(([, target]) => target);
    pendingTargetsRef.current.clear();
    batchTimerRef.current = null;

    if (targets.length === 0) return;
    const requestVersions = new Map<string, number>();
    for (const [key] of targetEntries) {
      inFlightTargetKeysRef.current.add(key);
      const version = (targetRequestVersionRef.current.get(key) ?? 0) + 1;
      targetRequestVersionRef.current.set(key, version);
      requestVersions.set(key, version);
    }

    const requestGeneration = cacheGenerationRef.current;
    const requestContextIdentity = cacheContextIdentityRef.current;

    void (async () => {
      try {
        const workspacePaths = targets
          .filter((target) => target.scope === 'workspace')
          .map((target) => target.path);
        const localPaths = targets
          .filter((target) => target.scope === 'local')
          .map((target) => target.path);

        const commitResponse = (
          scope: FileActionScope,
          results: Record<string, PathInfo>,
          requestedPaths: ReadonlySet<string>,
          verifiedAt: number,
        ): boolean => {
          if (!isMountedRef.current) return false;
          if (
            requestGeneration !== cacheGenerationRef.current ||
            requestContextIdentity !== cacheContextIdentityRef.current
          ) return false;

          let committed = false;
          for (const [path, info] of Object.entries(results)) {
            if (!requestedPaths.has(path)) continue;
            const target: FileActionTarget = { scope, path };
            const key = targetCacheKey(target, requestContextIdentity);
            if (requestVersions.get(key) !== targetRequestVersionRef.current.get(key)) continue;
            if (!mountedTargetsRef.current.get(key)?.count) continue;
            pathCacheRef.current.set(key, { info, scope, verifiedAt });
            committed = true;
          }
          if (committed) {
            setCacheVersion((version) => version + 1);
            scheduleLocalLeaseExpiryRef.current();
          }
          return true;
        };

        const releaseChunk = (scope: FileActionScope, paths: string[]) => {
          for (const path of paths) {
            inFlightTargetKeysRef.current.delete(targetCacheKey({ scope, path }, requestContextIdentity));
          }
        };

        if (fileServiceRef.current.isAvailable) {
          for (let offset = 0; offset < workspacePaths.length; offset += MAX_PATHS_PER_BATCH) {
            const paths = workspacePaths.slice(offset, offset + MAX_PATHS_PER_BATCH);
            const resp = await fileServiceRef.current.checkPaths({ paths });
            const isCurrent = commitResponse(
              'workspace',
              resp.results ?? {},
              new Set(paths),
              Date.now(),
            );
            releaseChunk('workspace', paths);
            if (!isCurrent) return;
          }
        }
        for (let offset = 0; offset < localPaths.length; offset += MAX_PATHS_PER_BATCH) {
          const paths = localPaths.slice(offset, offset + MAX_PATHS_PER_BATCH);
          const resp = await fileServiceRef.current.checkLocalPaths({
            paths,
            workspace: workspacePath,
          });
          const isCurrent = commitResponse('local', resp.results ?? {}, new Set(paths), Date.now());
          releaseChunk('local', paths);
          if (!isCurrent) return;
        }
      } catch {
        // Silently ignore — paths will stay un-cached and remain as plain <code>
      } finally {
        for (const [key] of targetEntries) inFlightTargetKeysRef.current.delete(key);
      }
    })();
  }, [workspacePath]);

  const checkFileTarget = useCallback((target: FileActionTarget): PathInfo | null => {
    const key = targetCacheKey(target, cacheContextIdentityRef.current);
    const cached = pathCacheRef.current.get(key);
    if (!cached) return null;
    if (cached.scope === 'local' && cached.verifiedAt + LOCAL_PATH_LEASE_MS <= Date.now()) {
      return null;
    }
    return cached.info;
  }, []);

  const enqueueTarget = useCallback((key: string, target: FileActionTarget) => {
    if (pathCacheRef.current.has(key)) return;
    if (inFlightTargetKeysRef.current.has(key)) return;
    if (!pendingTargetsRef.current.has(key)) {
      pendingTargetsRef.current.set(key, target);
    }
    // A context transition can deliberately cancel the old timer while
    // preserving targets already subscribed under the new context. Ensure a
    // preserved pending entry always has a live flush scheduled.
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushPendingPaths, BATCH_DELAY_MS);
    }
  }, [flushPendingPaths]);
  enqueueTargetRef.current = enqueueTarget;

  const subscribeFileTarget = useCallback((target: FileActionTarget) => {
    const key = targetCacheKey(target, cacheContextIdentity);
    const mounted = mountedTargetsRef.current.get(key);
    if (mounted) {
      mounted.count += 1;
    } else {
      mountedTargetsRef.current.set(key, { target, count: 1 });
    }
    enqueueTarget(key, target);

    return () => {
      const current = mountedTargetsRef.current.get(key);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) return;
      mountedTargetsRef.current.delete(key);
      pendingTargetsRef.current.delete(key);
      pathCacheRef.current.delete(key);
      if (pendingTargetsRef.current.size === 0 && batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      scheduleLocalLeaseExpiryRef.current();
    };
  }, [cacheContextIdentity, enqueueTarget]);

  const checkPath = useCallback((path: string): PathInfo | null => {
    return checkFileTarget({ scope: 'workspace', path });
  }, [checkFileTarget]);

  // ---------- Context menu ----------
  const showFileMenu = useCallback((
    x: number,
    y: number,
    path: string,
    pathType: 'file' | 'dir',
    displayPath?: string,
    options?: {
      scope?: FileActionScope;
      initialLineNumber?: number;
      zIndex?: number;
      onOpen?: () => void;
      onClose?: () => void;
    },
  ) => {
    menuCloseCallbackRef.current = options?.onClose ?? null;
    setMenuState({
      x,
      y,
      path,
      scope: options?.scope ?? 'workspace',
      pathType,
      displayPath: displayPath ?? path,
      contextIdentity: cacheContextIdentityRef.current,
      initialLineNumber: options?.initialLineNumber,
      zIndex: options?.zIndex,
    });
    options?.onOpen?.();
  }, []);

  // ---------- Preview state ----------
  const [previewFile, setPreviewFile] = useState<{
    name: string;
    content: string;
    size: number;
    path: string;
    sourceScope: FileActionScope;
    localPath?: string;
    richDocKind?: RichDocKind;
    initialLineNumber?: number;
    focusTarget?: FilePreviewFocusTarget;
    requestId: number;
    isLoading: boolean;
    error: string | null;
  } | null>(null);

  const previewFocusRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const openTargetIntentIdRef = useRef(0);

  const createFocusTarget = useCallback((lineNumber?: number) => {
    if (!lineNumber) return undefined;
    return {
      requestId: ++previewFocusRequestIdRef.current,
      lineNumber,
    } satisfies FilePreviewFocusTarget;
  }, []);

  const cachePathInfo = useCallback((
    target: FileActionTarget,
    info: PathInfo | null,
    contextIdentity = cacheContextIdentityRef.current,
  ) => {
    if (contextIdentity !== cacheContextIdentityRef.current) return false;
    const key = targetCacheKey(target, contextIdentity);
    const isMountedTarget = !!mountedTargetsRef.current.get(key)?.count;
    const previous = pathCacheRef.current.get(key);
    if (info && isMountedTarget) {
      pathCacheRef.current.set(key, {
        info,
        scope: target.scope,
        verifiedAt: Date.now(),
      });
    } else {
      pathCacheRef.current.delete(key);
    }
    if (previous || (info && isMountedTarget)) {
      setCacheVersion((version) => version + 1);
    }
    scheduleLocalLeaseExpiryRef.current();
    return true;
  }, []);

  const invalidateTarget = useCallback((target: FileActionTarget) => {
    cachePathInfo(target, null);
  }, [cachePathInfo]);

  const handlePreview = useCallback((path: string, options?: { initialLineNumber?: number; scope?: FileActionScope }): boolean => {
    const scope = options?.scope ?? 'workspace';
    const fileName = targetFileName(path);
    const svc = fileServiceRef.current;
    if (scope === 'workspace' && !svc.isAvailable) return false;
    const requestId = ++previewRequestIdRef.current;
    const focusTarget = createFocusTarget(options?.initialLineNumber);
    const localPath = scope === 'local' ? path : undefined;
    const workspaceForLocal = workspacePath;

    const richDocKind = getRichDocKind(fileName);
    if (richDocKind) {
      const fileData = {
        name: fileName,
        content: '',
        size: 0,
        path,
        sourceScope: scope,
        localPath,
        richDocKind,
        initialLineNumber: options?.initialLineNumber,
        focusTarget,
      };
      if (onFilePreviewExternalRef.current) {
        onFilePreviewExternalRef.current(fileData);
      } else {
        setPreviewFile({ ...fileData, requestId, isLoading: false, error: null });
      }
      return true;
    }

    if (isImageFile(fileName)) {
      void (async () => {
        try {
          // Rust already returns the file as base64. Building the data URL
          // directly matches DirectoryPanel and avoids treating an img-src-only
          // blob URL as a fetch/connect-src target in WKWebView.
          const resp = scope === 'local'
            ? await svc.downloadLocalFile({ fullPath: path, workspace: workspaceForLocal })
            : await svc.downloadFile({ path });
          if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
          openImagePreview(`data:${resp.mimeType};base64,${resp.data}`, resp.name || fileName);
        } catch (err) {
          if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
          invalidateTarget({ scope, path });
          console.error('[FileAction] Failed to load image:', err);
          toastRef.current?.error(t('fileActions.imageLoadFailed'));
        }
      })();
      return true;
    }

    if (!isPreviewable(fileName)) return false;

    // Route to split-view if external handler provided
    if (onFilePreviewExternalRef.current) {
      void (async () => {
        try {
          const resp = scope === 'local'
            ? await svc.readLocalPreview({ fullPath: path, workspace: workspaceForLocal })
            : await svc.readPreview({ path });
          if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
          onFilePreviewExternalRef.current?.({
            name: resp.name,
            content: resp.content,
            size: resp.size,
            path,
            sourceScope: scope,
            localPath,
            initialLineNumber: options?.initialLineNumber,
            focusTarget,
          });
        } catch (err) {
          if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
          invalidateTarget({ scope, path });
          console.error('[FileAction] Failed to load preview:', err);
          toastRef.current?.error(t('fileActions.previewLoadFailed'));
          setPreviewFile({
            name: fileName,
            content: '',
            size: 0,
            path,
            sourceScope: scope,
            localPath,
            initialLineNumber: options?.initialLineNumber,
            focusTarget,
            requestId,
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to load file',
          });
        }
      })();
      return true;
    }

    // Fallback: show fullscreen modal immediately in loading state
    setPreviewFile({
      name: fileName,
      content: '',
      size: 0,
      path,
      sourceScope: scope,
      localPath,
      initialLineNumber: options?.initialLineNumber,
      focusTarget,
      requestId,
      isLoading: true,
      error: null,
    });

    void (async () => {
      try {
        const resp = scope === 'local'
          ? await svc.readLocalPreview({ fullPath: path, workspace: workspaceForLocal })
          : await svc.readPreview({ path });
        if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
        setPreviewFile(prev => (
          prev?.requestId === requestId
            ? { ...prev, content: resp.content, size: resp.size, name: resp.name, isLoading: false }
            : prev
        ));
      } catch (err) {
        if (!isMountedRef.current || requestId !== previewRequestIdRef.current) return;
        invalidateTarget({ scope, path });
        setPreviewFile(prev => (
          prev?.requestId === requestId
            ? { ...prev, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load file' }
            : prev
        ));
      }
    })();
    return true;
  }, [createFocusTarget, invalidateTarget, openImagePreview, t, workspacePath]);

  const handleChatPreviewIntent = useCallback((
    path: string,
    options?: { initialLineNumber?: number; scope?: FileActionScope },
  ): boolean => {
    const scope = options?.scope ?? 'workspace';
    if (
      menuProfile === 'default' &&
      scope === 'workspace' &&
      onRevealInTreeRef.current
    ) {
      onRevealInTreeRef.current(path);
    }
    return handlePreview(path, options);
  }, [handlePreview, menuProfile]);

  const getTargetPathInfo = useCallback(async (target: FileActionTarget): Promise<PathInfo | null> => {
    try {
      if (target.scope === 'workspace') {
        if (!fileServiceRef.current.isAvailable) return null;
        const resp = await fileServiceRef.current.checkPaths({ paths: [target.path] });
        return resp.results[target.path] ?? null;
      }
      const resp = await fileServiceRef.current.checkLocalPaths({
        paths: [target.path],
        workspace: workspacePath,
      });
      return resp.results[target.path] ?? null;
    } catch {
      return null;
    }
  }, [workspacePath]);

  const revalidateTarget = useCallback(async (target: FileActionTarget): Promise<{
    current: boolean;
    info: PathInfo | null;
  }> => {
    const requestGeneration = cacheGenerationRef.current;
    const requestContextIdentity = cacheContextIdentityRef.current;
    const requestKey = targetCacheKey(target, requestContextIdentity);
    const requestVersion = (targetRequestVersionRef.current.get(requestKey) ?? 0) + 1;
    targetRequestVersionRef.current.set(requestKey, requestVersion);
    const info = await getTargetPathInfo(target);
    if (
      !isMountedRef.current ||
      requestGeneration !== cacheGenerationRef.current ||
      requestContextIdentity !== cacheContextIdentityRef.current ||
      targetRequestVersionRef.current.get(requestKey) !== requestVersion
    ) {
      return { current: false, info: null };
    }
    cachePathInfo(target, info, requestContextIdentity);
    return { current: true, info };
  }, [cachePathInfo, getTargetPathInfo]);

  const openTargetWithDefault = useCallback((target: FileActionTarget) => {
    if (target.scope === 'local') {
      void fileServiceRef.current.openPathWithDefault({
        fullPath: target.path,
        workspace: workspacePath,
      }).catch((err) => {
        if (!isMountedRef.current) return;
        invalidateTarget(target);
        console.error('[FileAction] Failed to open local target with default app:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openWithDefault({ path: target.path }).catch((err) => {
      if (!isMountedRef.current) return;
      invalidateTarget(target);
      console.error('[FileAction] Failed to open workspace target with default app:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [invalidateTarget, t, workspacePath]);

  const openFileTarget = useCallback((
    target: FileActionTarget,
    options?: { displayPath?: string; forceExternal?: boolean },
  ): void => {
    const intentId = ++openTargetIntentIdRef.current;
    void (async () => {
      const result = await revalidateTarget(target);
      if (!result.current || intentId !== openTargetIntentIdRef.current) return;
      const pathInfo = result.info;
      if (!pathInfo?.exists) {
        toastRef.current?.error(t('fileActions.targetUnavailable'));
        return;
      }

      if (options?.forceExternal) {
        openTargetWithDefault(target);
        return;
      }

      if (pathInfo.type === 'dir') {
        if (target.scope === 'workspace' && onRevealInTreeRef.current) {
          onRevealInTreeRef.current(target.path);
        } else {
          toastRef.current?.info(t('fileActions.directoryNotInWorkspace'));
        }
        return;
      }

      if (menuProfile === 'floatingBall' && target.scope === 'workspace' && onOpenMyAgentsPreviewRef.current) {
        const fileName = targetFileName(target.path);
        if (isPreviewable(fileName) || !!getRichDocKind(fileName)) {
          const displayPath = options?.displayPath ?? target.path;
          onOpenMyAgentsPreviewRef.current(target.path, target.initialLineNumber
            ? { displayPath, initialLineNumber: target.initialLineNumber }
            : { displayPath });
          return;
        }
      }

      if (handleChatPreviewIntent(target.path, {
        initialLineNumber: target.initialLineNumber,
        scope: target.scope,
      })) {
        return;
      }

      toastRef.current?.info(t('fileActions.previewUnsupported'));
    })();
  }, [handleChatPreviewIntent, menuProfile, openTargetWithDefault, revalidateTarget, t]);

  const openFileTargetMenu = useCallback((
    x: number,
    y: number,
    target: FileActionTarget,
    options?: FileActionMenuOptions,
  ): (() => void) => {
    // Replace an already-open menu before the next target's async revalidation.
    // Otherwise keyboard activation can leave stale actions usable while the
    // newer menu intent is pending.
    closeMenu();
    const intentId = ++menuIntentIdRef.current;
    void (async () => {
      const result = await revalidateTarget(target);
      if (!result.current || intentId !== menuIntentIdRef.current) return;
      const pathInfo = result.info;
      if (!pathInfo?.exists) {
        toastRef.current?.error(t('fileActions.targetUnavailable'));
        return;
      }
      showFileMenu(x, y, target.path, pathInfo.type, options?.displayPath, {
        scope: target.scope,
        initialLineNumber: target.initialLineNumber,
        zIndex: options?.zIndex,
        onOpen: options?.onOpen,
        onClose: options?.onClose,
      });
    })();
    return () => {
      if (intentId !== menuIntentIdRef.current) return;
      closeMenu();
    };
  }, [closeMenu, revalidateTarget, showFileMenu, t]);

  const openFileLink = useCallback((href: string, options?: { forceExternal?: boolean }): boolean => {
    const target = resolveFileLinkTarget(href, workspacePath);
    if (!target) return false;
    openFileTarget(target, { displayPath: href, forceExternal: options?.forceExternal });
    return true;
  }, [openFileTarget, workspacePath]);

  const openFileLinkMenu = useCallback((x: number, y: number, href: string): boolean => {
    const target = resolveFileLinkTarget(href, workspacePath);
    if (!target) return false;
    openFileTargetMenu(x, y, target, { displayPath: href });
    return true;
  }, [openFileTargetMenu, workspacePath]);

  const handleReference = useCallback((path: string) => {
    onInsertReferenceRef.current?.([path]);
  }, []);

  // Copy the path VERBATIM — exactly the text shown in the chip (所见所得),
  // whatever the model wrote (relative or absolute). The menu's `path` is the
  // normalized action form; copy uses the separate `displayPath` instead.
  const handleCopyPath = useCallback((displayPath: string) => {
    void copyPlainText(displayPath).then(
      () => { if (isMountedRef.current) toastRef.current?.success(t('fileActions.copied')); },
      () => { if (isMountedRef.current) toastRef.current?.error(t('fileActions.copyFailed')); },
    );
  }, [t]);

  const handleOpenWithDefault = useCallback((path: string, scope: FileActionScope) => {
    const target: FileActionTarget = { scope, path };
    if (scope === 'local') {
      void fileServiceRef.current.openPathWithDefault({ fullPath: path, workspace: workspacePath }).catch((err) => {
        if (!isMountedRef.current) return;
        invalidateTarget(target);
        console.error('[FileAction] Failed to open local target with default app:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openWithDefault({ path }).catch((err) => {
      if (!isMountedRef.current) return;
      invalidateTarget(target);
      console.error('[FileAction] Failed to open workspace target with default app:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [invalidateTarget, t, workspacePath]);

  const handleOpenInFinder = useCallback((path: string, scope: FileActionScope) => {
    const target: FileActionTarget = { scope, path };
    if (scope === 'local') {
      void fileServiceRef.current.openPathExternal({ fullPath: path, workspace: workspacePath }).catch((err) => {
        if (!isMountedRef.current) return;
        invalidateTarget(target);
        console.error('[FileAction] Failed to reveal local target:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openInFinder({ path }).catch((err) => {
      if (!isMountedRef.current) return;
      invalidateTarget(target);
      console.error('[FileAction] Failed to reveal workspace target:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [invalidateTarget, t, workspacePath]);

  const handleRevealInTree = useCallback((path: string) => {
    onRevealInTreeRef.current?.(path);
  }, []);

  const handleOpenMyAgentsPreview = useCallback((path: string, displayPath?: string, initialLineNumber?: number): void => {
    onOpenMyAgentsPreviewRef.current?.(path, initialLineNumber
      ? { displayPath, initialLineNumber }
      : { displayPath });
  }, []);

  // Build menu items
  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menuState || menuState.contextIdentity !== cacheContextIdentity) return [];
    const { path, scope, pathType, displayPath, initialLineNumber } = menuState;
    const fileName = targetFileName(path);
    const items: ContextMenuItem[] = [];

    if (menuProfile === 'floatingBall') {
      const canOpenMyAgentsPreview =
        scope === 'workspace' &&
        pathType === 'file' &&
        !!onOpenMyAgentsPreviewRef.current &&
        (isPreviewable(fileName) || !!getRichDocKind(fileName));

      return [
        {
          label: t('fileActions.copy'),
          icon: <Copy className="h-4 w-4" />,
          onClick: () => handleCopyPath(displayPath),
        },
        {
          label: t('fileActions.reference'),
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => handleReference(path),
        },
        {
          label: t('fileActions.openContainingFolder'),
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => handleOpenInFinder(path, scope),
        },
        {
          label: t('fileActions.openMyAgentsPreview'),
          icon: <PanelRightOpen className="h-4 w-4" />,
          disabled: !canOpenMyAgentsPreview,
          onClick: () => handleOpenMyAgentsPreview(path, displayPath, initialLineNumber),
        },
      ];
    }

    if (pathType === 'file') {
      const canPreview = isPreviewable(fileName) || isImageFile(fileName) || !!getRichDocKind(fileName);
      items.push({
        label: t('fileActions.preview'),
        icon: <Eye className="h-4 w-4" />,
        disabled: !canPreview,
        onClick: () => openFileTarget(
          initialLineNumber ? { scope, path, initialLineNumber } : { scope, path },
          { displayPath },
        ),
      });
    }

    items.push({
      label: t('fileActions.copy'),
      icon: <Copy className="h-4 w-4" />,
      onClick: () => handleCopyPath(displayPath),
    });

    items.push({
      label: t('fileActions.reference'),
      icon: <AtSign className="h-4 w-4" />,
      onClick: () => handleReference(path),
    });

    items.push({
      label: t('fileActions.open'),
      icon: <ExternalLink className="h-4 w-4" />,
      onClick: () => handleOpenWithDefault(path, scope),
    });

    items.push({
      label: t('fileActions.openContainingFolder'),
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => handleOpenInFinder(path, scope),
    });

    // Reveal in the right-side directory tree — only when the host wired it up
    // (i.e. a workspace tree exists to reveal into). Works for files and dirs.
    if (scope === 'workspace' && onRevealInTreeRef.current) {
      items.push({
        label: t('fileActions.revealInTree'),
        icon: <LocateFixed className="h-4 w-4" />,
        onClick: () => handleRevealInTree(path),
      });
    }

    return items;
  }, [cacheContextIdentity, menuState, menuProfile, t, openFileTarget, handleCopyPath, handleReference, handleOpenWithDefault, handleOpenInFinder, handleRevealInTree, handleOpenMyAgentsPreview]);

  // ---------- Context value ----------
  const contextValue = useMemo<FileActionContextValue>(() => ({
    checkPath,
    checkFileTarget,
    subscribeFileTarget,
    cacheVersion,
    openFileTargetMenu,
    openFileTarget,
    workspacePath,
  }), [checkPath, checkFileTarget, subscribeFileTarget, cacheVersion, openFileTargetMenu, openFileTarget, workspacePath]);

  const linkActionValue = useMemo<FileLinkActionContextValue>(() => ({
    openFileLink,
    openFileLinkMenu,
  }), [openFileLink, openFileLinkMenu]);

  return (
    <FileActionContext.Provider value={contextValue}>
      <FileLinkActionContext.Provider value={linkActionValue}>
        {children}

        {/* Context menu */}
        {menuState?.contextIdentity === cacheContextIdentity && (
          <ContextMenu
            x={menuState.x}
            y={menuState.y}
            items={menuItems}
            onClose={closeMenu}
            zIndex={menuState.zIndex}
          />
        )}

        {/* File preview modal (lazy loaded) */}
        {previewFile && (
          <Suspense fallback={null}>
            <FilePreviewModal
              name={previewFile.name}
              content={previewFile.content}
              size={previewFile.size}
              path={previewFile.path}
              localPath={previewFile.localPath}
              richDocKind={previewFile.richDocKind}
              isLoading={previewFile.isLoading}
              error={previewFile.error}
              // Phase D.5: thread the absolute workspace root so rendered
              // markdown can load relative-path images via fileService.
              // Without this, MarkdownImage's hook gets `null` and silently
              // skips the fetch (preview text/code still works).
              workspacePath={previewFile.sourceScope === 'local' ? null : workspacePath}
              initialLineNumber={previewFile.initialLineNumber}
              focusTarget={previewFile.focusTarget}
              onClose={() => {
                previewRequestIdRef.current += 1;
                setPreviewFile(null);
              }}
              onRenamed={(newPath, newName) => {
                // Update local preview state so subsequent saves target the new
                // location. The fs watcher refreshes the directory tree.
                setPreviewFile((prev) =>
                  prev ? { ...prev, path: newPath, name: newName } : prev,
                );
              }}
              // Phase D.5: route reveal-in-finder through fileService rather
              // than letting the modal fall back to sidecar `/agent/open-in-finder`.
              onRevealFile={async () => {
                const p = previewFile.path;
                if (previewFile.sourceScope === 'local') {
                  await fileServiceRef.current.openPathExternal({ fullPath: p, workspace: workspacePath });
                } else {
                  await fileServiceRef.current.openInFinder({ path: p });
                }
              }}
              onQuoteFile={onQuoteFile}
              onQuoteSelection={onQuoteSelection}
            />
          </Suspense>
        )}
      </FileLinkActionContext.Provider>
    </FileActionContext.Provider>
  );
}
