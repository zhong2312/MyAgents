/**
 * ToolAudioAttachment — compact, single-row audio card for an `audio`
 * ToolAttachment (builtin edge-tts, Codex mcpToolCall audio). Mounted by
 * ToolAttachmentGallery in the message flow (PRD 0.2.30). 0.2.31 redesign "V1":
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ (▶)  ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭   0:03 / 0:23   ⋯ │
 *   └────────────────────────────────────────────────┘
 *
 * Card presence comes from the border / radius / subtle shadow, NOT height —
 * a single row keeps it a quiet inline artifact, not a hero element. Secondary
 * actions (skip ±5s, reveal/open the file) live in the ⋯ menu.
 *
 * Playback reuses the global `audioPlayer.ts` singleton via `useAudioPlayer`
 * (one audio at a time), keyed on `savedPath` (the restart-safe trusted-root
 * copy). The menu's open-path actions target `sourcePath` (the original
 * generated file the tool card advertises) so what's shown == what's opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, FolderOpen, ExternalLink, Play, Pause, RotateCcw, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useFileAction } from '@/context/FileActionContext';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { formatPlaybackTime } from '@/utils/audioPlayer';
import SeekBar from './SeekBar';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachment: ToolAttachment;
}

const SKIP_SECONDS = 5;

const CARD_SHELL =
  'flex w-full max-w-[440px] items-center gap-3 rounded-[14px] border border-[var(--line)] bg-[var(--paper-elevated)] px-3.5 py-3 shadow-[var(--shadow-xs)]';

export default function ToolAudioAttachment({ attachment }: Props) {
  const { t } = useTranslation('chat');
  const fileService = useWorkspaceFileService(null);
  // The chat's workspace root. `openPath` (sourcePath) may live under the
  // workspace (e.g. `<workspace>/myagents_files/...`) on a non-home drive
  // (`/Volumes/work`, `D:\`). Rust `validate_external_open_path` only allows
  // home/tmp/workspace prefixes, so without threading the workspace the menu
  // silently fails for workspaces outside `~`/`tmp`. FileActionContext already
  // carries it for the inline play button; reuse it (null outside Chat → home/tmp).
  const workspacePath = useFileAction()?.workspacePath ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const savedPath = attachment.savedPath;
  // Playback uses the trusted-root copy; "open path" targets the ORIGINAL file.
  const openPath = attachment.sourcePath ?? attachment.savedPath;

  // Hook is called unconditionally (React rules); '' is never "current".
  const { isPlaying, isCurrent, toggle, progress, duration, seek } = useAudioPlayer(savedPath ?? '');

  const seekable = isCurrent && duration > 0;
  const skip = useCallback((delta: number) => {
    if (!seekable) return;
    seek(Math.max(0, Math.min(duration, progress + delta)));
  }, [seekable, seek, duration, progress]);

  // Close the overflow menu on any outside mousedown.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const reveal = useCallback(async () => {
    setMenuOpen(false);
    if (!openPath) return;
    try {
      await fileService.openPathExternal({ fullPath: openPath, workspace: workspacePath });
    } catch (err) {
      console.error('[ToolAudioAttachment] reveal failed:', err);
    }
  }, [fileService, openPath, workspacePath]);

  const openDefault = useCallback(async () => {
    setMenuOpen(false);
    if (!openPath) return;
    try {
      await fileService.openPathWithDefault({ fullPath: openPath, workspace: workspacePath });
    } catch (err) {
      console.error('[ToolAudioAttachment] open-with-default failed:', err);
    }
  }, [fileService, openPath, workspacePath]);

  // Placeholder (async save in flight — e.g. Codex audio).
  if (attachment.pendingId && !attachment.refPath) {
    return (
      <div className={`${CARD_SHELL} text-sm text-[var(--ink-muted)]`}>
        <span className="animate-pulse">{t('shell.toolChrome.audio.generating')}</span>
      </div>
    );
  }

  // Error sentinel. (Optional-chain defensively against a partial object.)
  if (attachment.refPath?.startsWith('error://')) {
    return (
      <div className="flex w-full max-w-[440px] items-center rounded-[14px] border border-rose-300/50 bg-rose-50/30 px-3.5 py-3 text-xs text-rose-600 dark:bg-rose-900/10 dark:text-rose-300">
        <span>{t('shell.toolChrome.audio.renderFailed', { reason: attachment.refPath.slice('error://'.length) })}</span>
      </div>
    );
  }

  const moreMenu = openPath ? (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        aria-label={t('shell.toolChrome.audio.more')}
        onClick={() => setMenuOpen(o => !o)}
        className="flex size-7 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink-secondary)]"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-9 z-50 min-w-[168px] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-[var(--shadow-md)]">
          {/* Skip ±5s — stay open so the user can tap repeatedly; disabled until loaded. */}
          <button
            type="button"
            onClick={() => skip(-SKIP_SECONDS)}
            disabled={!seekable}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-3.5" /> {t('shell.toolChrome.audio.rewindSeconds', { seconds: SKIP_SECONDS })}
          </button>
          <button
            type="button"
            onClick={() => skip(SKIP_SECONDS)}
            disabled={!seekable}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RotateCw className="size-3.5" /> {t('shell.toolChrome.audio.forwardSeconds', { seconds: SKIP_SECONDS })}
          </button>
          <div className="my-1 h-px bg-[var(--line-subtle)]" />
          <button
            type="button"
            onClick={reveal}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            <FolderOpen className="size-3.5" /> {t('shell.toolChrome.audio.reveal')}
          </button>
          <button
            type="button"
            onClick={openDefault}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            <ExternalLink className="size-3.5" /> {t('shell.toolChrome.audio.openDefault')}
          </button>
        </div>
      )}
    </div>
  ) : null;

  // No local path on this sidecar — degrade to a compact meta + menu row.
  if (!savedPath) {
    return (
      <div className={`${CARD_SHELL} justify-between text-xs text-[var(--ink-muted)]`}>
        <span>{t('shell.toolChrome.audio.audio')}</span>
        {moreMenu}
      </div>
    );
  }

  return (
    <div className={CARD_SHELL}>
      {/* play / pause */}
      <button
        type="button"
        aria-label={isPlaying ? t('shell.toolChrome.audio.pause') : t('shell.toolChrome.audio.play')}
        onClick={toggle}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)] active:scale-95"
      >
        {isPlaying
          ? <Pause className="size-4 fill-current" />
          : <Play className="size-[18px] fill-current ml-0.5" />
        }
      </button>

      {/* progress fills the middle */}
      <SeekBar
        ratio={seekable ? progress / duration : 0}
        seekable={seekable}
        onSeek={(r) => seek(r * duration)}
        trackClass="bg-[var(--paper-inset)]"
        className="flex-1"
      />

      {/* time */}
      <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--ink-muted)]">
        {isCurrent ? formatPlaybackTime(progress) : '0:00'} / {seekable ? formatPlaybackTime(duration) : '--:--'}
      </span>

      {moreMenu}
    </div>
  );
}
