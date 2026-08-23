/**
 * RichDocViewer — dispatcher for read-only office/PDF previews (PRD 0.2.20).
 *
 * Responsibilities (the sub-viewers stay dumb):
 *  - Fetch bytes via the existing Rust `cmd_workspace_download_file` channel
 *    (base64, ≤25MB). RichDocViewer is keyed by `path` at the mount site, so a
 *    split-view file switch remounts it with fresh state instead of showing the
 *    previous document; a `cancelled` flag drops a fetch that resolves post-unmount.
 *  - Unified state machine: loading / too-large / error / ready. Both the Rust
 *    "max 25 MB" rejection and any sub-viewer parse failure degrade to the same
 *    "open with default app" affordance.
 *  - Install the external-resource guard on the host so every sub-viewer's DOM
 *    is protected from confidential-doc network egress (§6.2).
 *  - Lazy-load the per-kind sub-viewer (heavy libs stay out of the main bundle),
 *    keyed by `path` so a file switch fully remounts + cleans up the old viewer.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileWarning, Loader2 } from 'lucide-react';

import { FileIcon } from '@/components/file-icon';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import type { RichDocKind } from '../../../shared/fileTypes';
import { installExternalResourceGuard } from './externalResourceGuard';
import type { RichDocSubViewerProps } from './types';

const VIEWERS: Record<RichDocKind, LazyExoticComponent<ComponentType<RichDocSubViewerProps>>> = {
  pdf: lazy(() => import('./PdfViewer')),
  docx: lazy(() => import('./DocxViewer')),
  sheet: lazy(() => import('./SheetViewer')),
  pptx: lazy(() => import('./PptxViewer')),
};

type FetchState =
  | { phase: 'loading' }
  | { phase: 'error'; tooLarge: boolean; message: string }
  | { phase: 'ready'; bytes: ArrayBuffer };

interface RichDocViewerProps {
  kind: RichDocKind;
  /** Workspace-relative path of the file, or display path for local previews. */
  path: string;
  /** Absolute workspace root; required for workspace-relative files. */
  workspacePath: string | null;
  /** Absolute local path for read-only previews outside the active workspace. */
  localPath?: string | null;
}

const Spinner = (
  <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
    <Loader2 className="h-5 w-5 animate-spin" />
  </div>
);

export default function RichDocViewer({ kind, path, workspacePath, localPath = null }: RichDocViewerProps) {
  const { t } = useTranslation('app');
  // `useWorkspaceFileService` returns a useMemo-stable object (per its own docs),
  // so it's safe to depend on directly in effects/callbacks without a ref mirror.
  const fileService = useWorkspaceFileService(workspacePath);

  const [state, setState] = useState<FetchState>({ phase: 'loading' });
  // Render/parse failure surfaced by a sub-viewer (separate from fetch failure).
  const [renderError, setRenderError] = useState<string | null>(null);
  // Sub-viewer parsed successfully but the document has no content.
  const [isEmpty, setIsEmpty] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  // Fetch bytes once on mount. RichDocViewer is keyed by `path` at the mount
  // site (FilePreviewModal), so a file switch remounts this component and resets
  // state to `loading` automatically — no synchronous setState-in-effect needed.
  // The `cancelled` flag drops a fetch that resolves after unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Raw bytes (tauri::ipc::Response → ArrayBuffer): no base64 inflation, no
        // main-thread atob — matters at the 50MB cap.
        const buf = localPath
          ? await fileService.downloadLocalFileBytes({ fullPath: localPath, workspace: workspacePath })
          : await fileService.downloadFileBytes({ path });
        if (cancelled) return;
        setState({ phase: 'ready', bytes: buf });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({ phase: 'error', tooLarge: /too large|max \d+\s*MB/i.test(message), message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, kind, fileService, localPath, workspacePath]);

  // External-resource guard: install once the host is mounted in the ready phase,
  // before sub-viewers inject their (async) DOM.
  useEffect(() => {
    if (state.phase !== 'ready' || renderError || isEmpty || !hostRef.current) return;
    return installExternalResourceGuard(hostRef.current);
  }, [state.phase, renderError, isEmpty]);

  const openExternal = useCallback(() => {
    if (localPath) {
      fileService.openPathWithDefault({ fullPath: localPath, workspace: workspacePath }).catch(() => {});
      return;
    }
    fileService.openWithDefault({ path }).catch(() => {});
  }, [path, fileService, localPath, workspacePath]);

  // Stable so it can sit in sub-viewers' effect deps without re-triggering renders
  // (setRenderError from useState is already stable; this mirrors that).
  const markEmpty = useCallback(() => setIsEmpty(true), []);

  if (state.phase === 'loading') return Spinner;

  if (state.phase === 'error' || renderError) {
    const tooLarge = state.phase === 'error' && state.tooLarge;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper-elevated)] px-6 text-center">
        <FileWarning className="h-9 w-9 text-[var(--ink-subtle)]" />
        <p className="max-w-md text-sm text-[var(--ink-muted)]">
          {tooLarge
            ? t('richDoc.tooLarge')
            : renderError
              ? t('richDoc.renderFailed')
              : t('richDoc.readFailed')}
        </p>
        <button
          type="button"
          onClick={openExternal}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-md active:scale-[0.98]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('richDoc.openDefault')}
        </button>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper-elevated)] px-6 text-center">
        <FileIcon name={path} size="display" />
        <p className="text-sm text-[var(--ink-muted)]">{t('richDoc.empty')}</p>
      </div>
    );
  }

  const SubViewer = VIEWERS[kind];
  return (
    <div ref={hostRef} className="h-full overflow-hidden">
      <Suspense fallback={Spinner}>
        {/* key={path} forces a clean remount (+ sub-viewer cleanup) on file switch. */}
        <SubViewer key={path} bytes={state.bytes} onError={setRenderError} onEmpty={markEmpty} />
      </Suspense>
    </div>
  );
}
