/**
 * ToolImageAttachment — single image attachment renderer.
 *
 * PRD 0.2.15 §4.8 — owns the rendering of an `image` ToolAttachment, including:
 *   - placeholder loading skeleton (sidecar async save in flight)
 *   - error display (saveToolAttachment failed)
 *   - tap-to-zoom modal preview
 *   - caption (revisedPrompt etc., capped 4KB at the source)
 *
 * The URL is resolved via useAttachmentUrl, which validates the refPath belongs
 * to the current session before mapping it to the desktop attachment protocol.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Download, FileText } from 'lucide-react';

import ContextMenu, { type ContextMenuItem } from '@/components/ContextMenu';
import { useToastOptional } from '@/components/Toast';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { useTabStateOptional } from '@/context/TabContext';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useAttachmentUrl } from '@/utils/toolAttachment';
import { copyPlainText } from '@/utils/clipboard';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachment: ToolAttachment;
}

export default function ToolImageAttachment({ attachment }: Props) {
  const { t } = useTranslation('chat');
  const tab = useTabStateOptional();
  const toast = useToastOptional();
  const sessionId = tab?.sessionId ?? null;
  const urlState = useAttachmentUrl(attachment, sessionId);
  const [zoomed, setZoomed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const mediaRef = useRef<HTMLButtonElement>(null);
  const [captionWidth, setCaptionWidth] = useState<number | null>(null);
  const localPath = attachment.sourcePath ?? attachment.savedPath ?? null;
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const notifiedSettledRef = useRef(false);

  const updateCaptionWidth = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    const nextWidth = Math.ceil(media.getBoundingClientRect().width);
    if (nextWidth <= 0) return;
    setCaptionWidth((prev) => (prev === nextWidth ? prev : nextWidth));
  }, []);

  const handleImageLoad = useCallback(() => {
    updateCaptionWidth();
    if (!notifiedSettledRef.current) {
      notifiedSettledRef.current = true;
      notifyRowLayoutChanged('attachment-settle');
    }
  }, [notifyRowLayoutChanged, updateCaptionWidth]);

  useLayoutEffect(() => {
    if (urlState.state !== 'ready') {
      return;
    }

    updateCaptionWidth();
    const media = mediaRef.current;
    if (!media) return;

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateCaptionWidth);
      return () => window.removeEventListener('resize', updateCaptionWidth);
    }

    const observer = new ResizeObserver(updateCaptionWidth);
    observer.observe(media);
    return () => observer.disconnect();
  }, [urlState.state, updateCaptionWidth]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const copyLocalPath = useCallback(() => {
    if (!localPath) {
      toast?.error(t('shell.toolChrome.image.noLocalPath'));
      return;
    }
    void copyPlainText(localPath).then(
      () => toast?.success(t('shell.toolChrome.image.copyPathSuccess')),
      () => toast?.error(t('shell.toolChrome.image.copyPathFailed')),
    );
  }, [localPath, t, toast]);

  const readImageBlob = useCallback(async (): Promise<Blob> => {
    const mimeType = attachment.mimeType || 'image/png';
    if (isTauriEnvironment()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = await invoke<ArrayBuffer>('cmd_read_tool_attachment_bytes', {
        refPath: attachment.refPath,
      });
      return new Blob([bytes], { type: mimeType });
    }
    if (urlState.state !== 'ready') {
      throw new Error('Image URL is not ready');
    }
    const res = await fetch(urlState.url);
    if (!res.ok) {
      throw new Error(`Image fetch failed: ${res.status}`);
    }
    return res.blob();
  }, [attachment.mimeType, attachment.refPath, urlState]);

  const copyImage = useCallback(() => {
    void (async () => {
      try {
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
          throw new Error('Clipboard image write is unavailable');
        }
        const blob = await readImageBlob();
        const mimeType = blob.type || attachment.mimeType || 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        toast?.success(t('shell.toolChrome.image.copySuccess'));
      } catch (err) {
        console.warn('[ToolImageAttachment] copy image failed:', err);
        if (localPath) {
          await copyPlainText(localPath).then(
            () => toast?.warning(t('shell.toolChrome.image.copyFallbackPath')),
            () => toast?.error(t('shell.toolChrome.image.copyFailed')),
          );
        } else {
          toast?.error(t('shell.toolChrome.image.copyFailed'));
        }
      }
    })();
  }, [attachment.mimeType, localPath, readImageBlob, t, toast]);

  const saveImageAs = useCallback(() => {
    void (async () => {
      if (urlState.state !== 'ready') {
        toast?.error(t('shell.toolChrome.image.notReady'));
        return;
      }
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const destinationPath = await save({
          defaultPath: getAttachmentFilename(attachment),
          filters: [getImageSaveFilter(attachment)],
        });
        if (!destinationPath) return;

        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cmd_export_tool_attachment', {
          refPath: attachment.refPath,
          destinationPath,
        });
        toast?.success(t('shell.toolChrome.image.saveSuccess'));
      } catch (err) {
        console.error('[ToolImageAttachment] save image failed:', err);
        toast?.error(t('shell.toolChrome.image.saveFailed'));
      }
    })();
  }, [attachment, t, toast, urlState.state]);

  const contextMenuItems = useMemo((): ContextMenuItem[] => [
    {
      label: t('shell.toolChrome.image.copyImage'),
      icon: <Copy className="h-4 w-4" />,
      disabled: urlState.state !== 'ready',
      onClick: copyImage,
    },
    {
      label: t('shell.toolChrome.image.saveAs'),
      icon: <Download className="h-4 w-4" />,
      disabled: urlState.state !== 'ready',
      onClick: saveImageAs,
    },
    { separator: true },
    {
      label: t('shell.toolChrome.image.copyLocalPath'),
      icon: <FileText className="h-4 w-4" />,
      disabled: !localPath,
      onClick: copyLocalPath,
    },
  ], [copyImage, copyLocalPath, localPath, saveImageAs, t, urlState.state]);

  if (urlState.state === 'pending') {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/40 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">{t('shell.toolChrome.image.generating')}</span>
      </div>
    );
  }
  if (urlState.state === 'loading') {
    return (
      <div className="flex h-32 w-full items-center justify-center rounded border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/40 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">{t('shell.toolChrome.image.loading')}</span>
      </div>
    );
  }
  if (urlState.state === 'error') {
    return (
      <div className="flex h-20 w-full items-center justify-center rounded border border-rose-300/50 bg-rose-50/30 px-3 text-xs text-rose-600 dark:bg-rose-900/10 dark:text-rose-300">
        <span>{t('shell.toolChrome.image.renderFailed', { reason: urlState.reason })}</span>
      </div>
    );
  }

  // Ready
  return (
    <>
      <div className="flex max-w-full flex-col items-start gap-1">
        <button
          ref={mediaRef}
          type="button"
          onClick={() => setZoomed(true)}
          onContextMenu={handleContextMenu}
          className="group inline-flex max-w-full overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-inset)]/30 transition-transform hover:scale-[1.01]"
        >
          <img
            src={urlState.url}
            alt={attachment.caption || t('shell.toolChrome.common.generatedImageAlt')}
            loading="lazy"
            onLoad={handleImageLoad}
            className="block h-auto max-h-80 max-w-full object-contain"
          />
        </button>
        {attachment.caption ? (
          <div
            className="line-clamp-2 max-w-full text-xs text-[var(--ink-muted)]"
            style={captionWidth ? { width: captionWidth } : undefined}
          >
            {attachment.caption}
          </div>
        ) : null}
      </div>
      {zoomed
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6"
              onClick={() => setZoomed(false)}
            >
              <img
                src={urlState.url}
                alt={attachment.caption || t('shell.toolChrome.common.generatedImageAlt')}
                onContextMenu={handleContextMenu}
                className="max-h-full max-w-full"
              />
            </div>,
            document.body,
          )
        : null}
      {contextMenu
        ? createPortal(
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={contextMenuItems}
              onClose={closeContextMenu}
              zIndex={220}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function getAttachmentFilename(attachment: ToolAttachment): string {
  const source = attachment.sourcePath ?? attachment.savedPath ?? attachment.refPath;
  const filename = source.split(/[\\/]/).filter(Boolean).pop();
  if (filename && filename.includes('.')) return filename;
  return `tool-image.${mimeToExtension(attachment.mimeType)}`;
}

function getImageSaveFilter(attachment: ToolAttachment): { name: string; extensions: string[] } {
  const extension = mimeToExtension(attachment.mimeType);
  return {
    name: extension.toUpperCase(),
    extensions: [extension],
  };
}

function mimeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
    default:
      return 'png';
  }
}
