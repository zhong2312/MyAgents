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

// Lazy load FilePreviewModal (heavy: includes SyntaxHighlighter + Monaco)
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));

// ---------- Types ----------

interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

type FileActionScope = FileActionTarget['scope'];

export interface FileActionContextValue {
  /** Synchronous cache lookup. Returns cached result or null (pending / not yet requested). */
  checkPath: (path: string) => PathInfo | null;
  /** Synchronous cache lookup for a resolved workspace/local target. */
  checkFileTarget: (target: FileActionTarget) => PathInfo | null;
  /** Incremented each time the cache is updated, so consumers can re-render. */
  cacheVersion: number;
  /** Open the context menu for a resolved path. `path` is the normalized form
   *  used for backend actions; `displayPath` is the verbatim text shown to the
   *  user (what 「复制」 copies) — defaults to `path` when omitted. */
  openFileMenu: (
    x: number,
    y: number,
    path: string,
    pathType: 'file' | 'dir',
    displayPath?: string,
    options?: { scope?: FileActionScope; initialLineNumber?: number },
  ) => void;
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
  /** When this value changes, the path cache is cleared (e.g. toolCompleteCount). */
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

export function useFileLinkAction(): FileLinkActionContextValue | null {
  return useContext(FileLinkActionContext);
}

// ---------- Provider ----------

const BATCH_DELAY_MS = 50;

function targetCacheKey(target: FileActionTarget): string {
  return `${target.scope}:${target.path}`;
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
  const pathCacheRef = useRef<Map<string, PathInfo>>(new Map());
  const pendingTargetsRef = useRef<Map<string, FileActionTarget>>(new Map());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Clear cache when refreshTrigger changes
  useEffect(() => {
    pathCacheRef.current.clear();
    pendingTargetsRef.current.clear();
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setCacheVersion(v => v + 1);
  }, [refreshTrigger, workspacePath]);

  // Clean up batch timer on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  // Flush pending paths to the backend (Rust workspace_files::check_paths
  // since Phase D.5 — used to be sidecar `/agent/check-paths`).
  const flushPendingPaths = useCallback(() => {
    const targets = Array.from(pendingTargetsRef.current.values());
    pendingTargetsRef.current.clear();
    batchTimerRef.current = null;

    if (targets.length === 0) return;

    void (async () => {
      try {
        const workspacePaths = targets
          .filter((target) => target.scope === 'workspace')
          .map((target) => target.path);
        const localPaths = targets
          .filter((target) => target.scope === 'local')
          .map((target) => target.path);

        const responses: Array<{ scope: FileActionScope; results: Record<string, PathInfo> }> = [];
        if (workspacePaths.length > 0 && fileServiceRef.current.isAvailable) {
          const resp = await fileServiceRef.current.checkPaths({ paths: workspacePaths });
          responses.push({ scope: 'workspace', results: resp.results ?? {} });
        }
        if (localPaths.length > 0) {
          const resp = await fileServiceRef.current.checkLocalPaths({
            paths: localPaths,
            workspace: workspacePath,
          });
          responses.push({ scope: 'local', results: resp.results ?? {} });
        }

        if (!isMountedRef.current) return;
        if (responses.length > 0) {
          for (const response of responses) {
            for (const [p, info] of Object.entries(response.results)) {
              pathCacheRef.current.set(targetCacheKey({ scope: response.scope, path: p }), info);
            }
          }
          setCacheVersion(v => v + 1);
        }
      } catch {
        // Silently ignore — paths will stay un-cached and remain as plain <code>
      }
    })();
  }, [workspacePath]);

  const checkFileTarget = useCallback((target: FileActionTarget): PathInfo | null => {
    const key = targetCacheKey(target);
    const cached = pathCacheRef.current.get(key);
    if (cached) return cached;

    // Already queued
    if (pendingTargetsRef.current.has(key)) return null;

    // Enqueue
    pendingTargetsRef.current.set(key, target);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushPendingPaths, BATCH_DELAY_MS);
    }
    return null;
  }, [flushPendingPaths]);

  const checkPath = useCallback((path: string): PathInfo | null => {
    return checkFileTarget({ scope: 'workspace', path });
  }, [checkFileTarget]);

  // ---------- Context menu ----------
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    path: string;
    scope: FileActionScope;
    pathType: 'file' | 'dir';
    displayPath: string;
    initialLineNumber?: number;
  } | null>(null);

  const openFileMenu = useCallback((
    x: number,
    y: number,
    path: string,
    pathType: 'file' | 'dir',
    displayPath?: string,
    options?: { scope?: FileActionScope; initialLineNumber?: number },
  ) => {
    setMenuState({
      x,
      y,
      path,
      scope: options?.scope ?? 'workspace',
      pathType,
      displayPath: displayPath ?? path,
      initialLineNumber: options?.initialLineNumber,
    });
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

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
    isLoading: boolean;
    error: string | null;
  } | null>(null);

  const previewFocusRequestIdRef = useRef(0);

  const createFocusTarget = useCallback((lineNumber?: number) => {
    if (!lineNumber) return undefined;
    return {
      requestId: ++previewFocusRequestIdRef.current,
      lineNumber,
    } satisfies FilePreviewFocusTarget;
  }, []);

  const handlePreview = useCallback((path: string, options?: { initialLineNumber?: number; scope?: FileActionScope }): boolean => {
    const scope = options?.scope ?? 'workspace';
    const fileName = targetFileName(path);
    const svc = fileServiceRef.current;
    if (scope === 'workspace' && !svc.isAvailable) return false;
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
        setPreviewFile({ ...fileData, isLoading: false, error: null });
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
          if (!isMountedRef.current) return;
          openImagePreview(`data:${resp.mimeType};base64,${resp.data}`, resp.name || fileName);
        } catch (err) {
          if (!isMountedRef.current) return;
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
          if (!isMountedRef.current) return;
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
          if (!isMountedRef.current) return;
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
      isLoading: true,
      error: null,
    });

    void (async () => {
      try {
        const resp = scope === 'local'
          ? await svc.readLocalPreview({ fullPath: path, workspace: workspaceForLocal })
          : await svc.readPreview({ path });
        if (!isMountedRef.current) return;
        setPreviewFile(prev => (
          prev?.path === path && prev.sourceScope === scope
            ? { ...prev, content: resp.content, size: resp.size, name: resp.name, isLoading: false }
            : prev
        ));
      } catch (err) {
        if (!isMountedRef.current) return;
        setPreviewFile(prev => (
          prev?.path === path && prev.sourceScope === scope
            ? { ...prev, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load file' }
            : prev
        ));
      }
    })();
    return true;
  }, [createFocusTarget, openImagePreview, t, workspacePath]);

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

  const openTargetWithDefault = useCallback((target: FileActionTarget) => {
    if (target.scope === 'local') {
      void fileServiceRef.current.openPathWithDefault({
        fullPath: target.path,
        workspace: workspacePath,
      }).catch((err) => {
        if (!isMountedRef.current) return;
        console.error('[FileAction] Failed to open local target with default app:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openWithDefault({ path: target.path }).catch((err) => {
      if (!isMountedRef.current) return;
      console.error('[FileAction] Failed to open workspace target with default app:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [t, workspacePath]);

  const openFileTarget = useCallback((
    target: FileActionTarget,
    options?: { displayPath?: string; forceExternal?: boolean },
  ): void => {
    void (async () => {
      const pathInfo = await getTargetPathInfo(target);
      if (!isMountedRef.current) return;
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

      if (handlePreview(target.path, {
        initialLineNumber: target.initialLineNumber,
        scope: target.scope,
      })) {
        return;
      }

      toastRef.current?.info(t('fileActions.previewUnsupported'));
    })();
  }, [getTargetPathInfo, handlePreview, menuProfile, openTargetWithDefault, t]);

  const openFileLink = useCallback((href: string, options?: { forceExternal?: boolean }): boolean => {
    const target = resolveFileLinkTarget(href, workspacePath);
    if (!target) return false;
    openFileTarget(target, { displayPath: href, forceExternal: options?.forceExternal });
    return true;
  }, [openFileTarget, workspacePath]);

  const openFileLinkMenu = useCallback((x: number, y: number, href: string): boolean => {
    const target = resolveFileLinkTarget(href, workspacePath);
    if (!target) return false;

    void (async () => {
      const pathInfo = await getTargetPathInfo(target);
      if (!isMountedRef.current) return;
      if (!pathInfo?.exists) {
        toastRef.current?.error(t('fileActions.targetUnavailable'));
        return;
      }
      openFileMenu(x, y, target.path, pathInfo.type, href, {
        scope: target.scope,
        initialLineNumber: target.initialLineNumber,
      });
    })();

    return true;
  }, [getTargetPathInfo, openFileMenu, t, workspacePath]);

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
    if (scope === 'local') {
      void fileServiceRef.current.openPathWithDefault({ fullPath: path, workspace: workspacePath }).catch((err) => {
        if (!isMountedRef.current) return;
        console.error('[FileAction] Failed to open local target with default app:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openWithDefault({ path }).catch((err) => {
      if (!isMountedRef.current) return;
      console.error('[FileAction] Failed to open workspace target with default app:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [t, workspacePath]);

  const handleOpenInFinder = useCallback((path: string, scope: FileActionScope) => {
    if (scope === 'local') {
      void fileServiceRef.current.openPathExternal({ fullPath: path, workspace: workspacePath }).catch((err) => {
        if (!isMountedRef.current) return;
        console.error('[FileAction] Failed to reveal local target:', err);
        toastRef.current?.error(t('fileActions.openFailed'));
      });
      return;
    }
    void fileServiceRef.current.openInFinder({ path }).catch((err) => {
      if (!isMountedRef.current) return;
      console.error('[FileAction] Failed to reveal workspace target:', err);
      toastRef.current?.error(t('fileActions.openFailed'));
    });
  }, [t, workspacePath]);

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
    if (!menuState) return [];
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
        onClick: () => handlePreview(path, { scope, initialLineNumber }),
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
  }, [menuState, menuProfile, t, handlePreview, handleCopyPath, handleReference, handleOpenWithDefault, handleOpenInFinder, handleRevealInTree, handleOpenMyAgentsPreview]);

  // ---------- Context value ----------
  const contextValue = useMemo<FileActionContextValue>(() => ({
    checkPath,
    checkFileTarget,
    cacheVersion,
    openFileMenu,
    openFileTarget,
    workspacePath,
  }), [checkPath, checkFileTarget, cacheVersion, openFileMenu, openFileTarget, workspacePath]);

  const linkActionValue = useMemo<FileLinkActionContextValue>(() => ({
    openFileLink,
    openFileLinkMenu,
  }), [openFileLink, openFileLinkMenu]);

  return (
    <FileActionContext.Provider value={contextValue}>
      <FileLinkActionContext.Provider value={linkActionValue}>
        {children}

        {/* Context menu */}
        {menuState && (
          <ContextMenu
            x={menuState.x}
            y={menuState.y}
            items={menuItems}
            onClose={closeMenu}
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
              onClose={() => setPreviewFile(null)}
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
