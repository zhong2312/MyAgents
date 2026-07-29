import { BookOpen, Loader2, LockKeyhole, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import NovelGenrePicker from "./NovelGenrePicker";
import NovelPlanningFields from "./NovelPlanningFields";
import {
  DEFAULT_CHAPTER_WORD_COUNT,
  DEFAULT_TARGET_WORD_COUNT_MAX_WAN,
  DEFAULT_TARGET_WORD_COUNT_MIN_WAN,
  parseNovelPlanningInput,
  wordCountToWanInput,
} from "./projectPlanning";
import type { NovelMetadata } from "./projectSchema";
import type { UpdateNovelProjectSettingsInput } from "./repository";

interface NovelProjectSettingsDialogProps {
  readonly metadata: NovelMetadata;
  onSave(input: UpdateNovelProjectSettingsInput): Promise<void>;
  onClose(): void;
}

export default function NovelProjectSettingsDialog({
  metadata,
  onSave,
  onClose,
}: NovelProjectSettingsDialogProps) {
  const onCloseRef = useRef(onClose);
  const [title, setTitle] = useState(metadata.title);
  const [genres, setGenres] = useState<string[]>([...metadata.genres]);
  const [targetWordCountMinWan, setTargetWordCountMinWan] = useState(
    metadata.targetWordCountMin === null
      ? DEFAULT_TARGET_WORD_COUNT_MIN_WAN
      : wordCountToWanInput(metadata.targetWordCountMin),
  );
  const [targetWordCountMaxWan, setTargetWordCountMaxWan] = useState(
    metadata.targetWordCountMax === null
      ? DEFAULT_TARGET_WORD_COUNT_MAX_WAN
      : wordCountToWanInput(metadata.targetWordCountMax),
  );
  const [chapterWordCount, setChapterWordCount] = useState(
    metadata.chapterWordCount === null
      ? DEFAULT_CHAPTER_WORD_COUNT
      : String(metadata.chapterWordCount),
  );
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planning = parseNovelPlanningInput(
    targetWordCountMinWan,
    targetWordCountMaxWan,
    chapterWordCount,
  );
  const canSave =
    title.trim().length > 0 &&
    genres.length > 0 &&
    planning !== null &&
    !isSaving;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSaving) return;
      if (genreMenuOpen) {
        setGenreMenuOpen(false);
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [genreMenuOpen, isSaving]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !planning) return;
    setError(null);
    setIsSaving(true);
    try {
      await onSave({ title: title.trim(), genres, ...planning });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="novel-project-settings-title"
        onSubmit={handleSubmit}
        className="max-h-[calc(100vh-32px)] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--paper-elevated)] shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-[var(--line-subtle)] px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="novel-project-settings-title"
                className="text-lg font-semibold text-[var(--ink)]"
              >
                项目资料
              </h2>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                调整书名与创作规模
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
            title="关闭"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div>
              <label
                htmlFor="novel-settings-project-name"
                className="mb-2 flex items-center gap-1.5 text-sm font-medium text-[var(--ink)]"
              >
                项目名
                <LockKeyhole className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
              </label>
              <input
                id="novel-settings-project-name"
                value={metadata.projectName}
                readOnly
                aria-readonly="true"
                className="h-10 w-full cursor-default rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)]/55 px-3 text-sm text-[var(--ink-muted)] outline-none"
              />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                固定代号，创建后不可修改
              </p>
            </div>
            <div>
              <label
                htmlFor="novel-settings-title-input"
                className="mb-2 block text-sm font-medium text-[var(--ink)]"
              >
                书名
              </label>
              <input
                id="novel-settings-title-input"
                autoFocus
                value={title}
                disabled={isSaving}
                onChange={(event) => setTitle(event.target.value)}
                className="h-10 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)] disabled:opacity-50"
              />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                可随创作进度自由修改
              </p>
            </div>
          </div>

          <NovelGenrePicker
            id="novel-settings-genre"
            genres={genres}
            open={genreMenuOpen}
            disabled={isSaving}
            onChange={setGenres}
            onOpenChange={setGenreMenuOpen}
          />

          <div className="border-t border-[var(--line-subtle)] pt-5">
            <NovelPlanningFields
              idPrefix="novel-settings"
              targetWordCountMinWan={targetWordCountMinWan}
              targetWordCountMaxWan={targetWordCountMaxWan}
              chapterWordCount={chapterWordCount}
              disabled={isSaving}
              onTargetWordCountMinWanChange={setTargetWordCountMinWan}
              onTargetWordCountMaxWanChange={setTargetWordCountMaxWan}
              onChapterWordCountChange={setChapterWordCount}
            />
          </div>

          {error && (
            <div
              className="rounded-md bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]"
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--line-subtle)] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="flex min-w-24 items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isSaving ? "保存中..." : "保存"}
          </button>
        </footer>
      </form>
    </div>
  );
}
