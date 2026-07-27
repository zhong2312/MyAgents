/**
 * AudioPlayerBar — compact, seekable audio player bar.
 *
 * Used by the legacy edge-tts card (no-attachment history fallback). New
 * attachments render the larger ToolAudioAttachment player instead. Backed by
 * the global `audioPlayer.ts` singleton via `useAudioPlayer` (only one audio
 * plays at a time) and the shared `<SeekBar>` for scrubbing.
 *
 * `filePath` is an absolute local path; the singleton resolves it to a playable
 * source (Tauri: cmd_read_file_base64 → blob URL; browser: /api/audio).
 */
import { useCallback, useRef } from 'react';
import { Play, Pause } from 'lucide-react';
import { track } from '@/analytics';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { formatPlaybackTime as formatTime } from '@/utils/audioPlayer';
import SeekBar from './SeekBar';

export default function AudioPlayerBar({ filePath }: { filePath: string }) {
  const { isPlaying, isCurrent, toggle, progress, duration, seek } = useAudioPlayer(filePath);
  const trackedRef = useRef(false);

  const handleToggle = useCallback(() => {
    if (!isPlaying && !trackedRef.current) {
      track('tts_play', {});
      trackedRef.current = true;
    }
    toggle();
  }, [isPlaying, toggle]);

  const seekable = isCurrent && duration > 0;
  const ratio = seekable ? progress / duration : 0;

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-[var(--paper-inset)] px-3 py-2 max-w-[400px]">
      <button
        type="button"
        onClick={handleToggle}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)]"
      >
        {isPlaying
          ? <Pause className="size-3 fill-current" />
          : <Play className="size-3 fill-current ml-0.5" />
        }
      </button>

      <div className="flex flex-1 items-center gap-2">
        <SeekBar ratio={ratio} seekable={seekable} onSeek={(r) => seek(r * duration)} className="flex-1" />
        <span className="text-xs tabular-nums text-[var(--ink-muted)] shrink-0">
          {isCurrent ? formatTime(progress) : '0:00'} / {seekable ? formatTime(duration) : '--:--'}
        </span>
      </div>
    </div>
  );
}
