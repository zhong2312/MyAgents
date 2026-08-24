import { X } from 'lucide-react';

import type { SpaceAttachmentDraft } from '@/api/spaceCloud';
import { FileIcon } from '@/components/file-icon';
import { formatBytes } from '@/pages/space/spaceUi';

export function IssueAttachmentDraftList({
  drafts,
  onRemove,
  removeLabel,
  className = '',
}: {
  drafts: SpaceAttachmentDraft[];
  onRemove: (path: string) => void;
  removeLabel: (name: string) => string;
  className?: string;
}) {
  if (drafts.length === 0) return null;
  return (
    <div className={`divide-y divide-[var(--line-subtle)] ${className}`}>
      {drafts.map((draft) => (
        <div key={draft.path} className="group grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon name={draft.name} />
            <span className="truncate font-medium text-[var(--ink-secondary)]">{draft.name}</span>
            <small className="shrink-0 text-xs text-[var(--ink-subtle)]">{formatBytes(draft.sizeBytes)}</small>
          </span>
          <button
            type="button"
            onClick={() => onRemove(draft.path)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--ink-muted)] outline-none transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]"
            aria-label={removeLabel(draft.name)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
