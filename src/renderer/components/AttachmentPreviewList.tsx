import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FileIcon } from '@/components/file-icon';
import { formatFileSize } from '@/utils/formatFileSize';

export interface AttachmentPreviewItem {
  id: string;
  name: string;
  size: number;
  isImage?: boolean;
  previewUrl?: string;
  footnoteLines?: string[];
}

interface AttachmentPreviewListProps {
  attachments: AttachmentPreviewItem[];
  onRemove?: (id: string) => void;
  onPreview?: (url: string, name: string) => void;
  className?: string;
  cardClassName?: string;
  imageDimensions?: string;
  compact?: boolean; // Compact mode for sent-message attachment strips
}

export default function AttachmentPreviewList({
  attachments,
  onRemove,
  onPreview,
  className = '',
  cardClassName = '',
  imageDimensions,
  compact = false
}: AttachmentPreviewListProps) {
  const [previewErrorIds, setPreviewErrorIds] = useState<string[]>([]);
  const previewErrorIdSet = useMemo(() => {
    const validIds = new Set(attachments.map((attachment) => attachment.id));
    return new Set(previewErrorIds.filter((id) => validIds.has(id)));
  }, [attachments, previewErrorIds]);

  const markPreviewError = (attachmentId: string) => {
    setPreviewErrorIds((prev) => (prev.includes(attachmentId) ? prev : [...prev, attachmentId]));
  };

  const handleRemove = (attachmentId: string) => {
    setPreviewErrorIds((prev) => prev.filter((id) => id !== attachmentId));
    onRemove?.(attachmentId);
  };

  if (attachments.length === 0) {
    return null;
  }

  const resolvedImageDimensions = imageDimensions ?? (compact ? 'h-24' : 'h-16 w-16');

  // Sent-message attachments use a horizontal strip: images keep a fixed
  // height and intrinsic width, so screenshots and portrait images are not
  // cropped into square thumbnails.
  const containerClass = compact
    ? `flex max-w-full flex-nowrap gap-2 overflow-x-auto pb-1 ${className}`
    : `flex flex-wrap gap-3 ${className}`;
  const cardRadiusClass = compact ? 'rounded-lg' : 'rounded-2xl';
  const imageFrameClass = compact
    ? `relative flex items-center justify-center overflow-hidden ${cardRadiusClass} ${resolvedImageDimensions} cursor-pointer`
    : `relative overflow-hidden ${cardRadiusClass} ${resolvedImageDimensions} cursor-pointer`;
  const imageClass = compact
    ? 'block h-full w-auto max-w-none object-contain'
    : 'h-full w-full object-cover';

  return (
    <div className={containerClass}>
      {attachments.map((attachment) => {
        const showImagePreview =
          attachment.isImage &&
          attachment.previewUrl &&
          !previewErrorIdSet.has(attachment.id);

        return (
          <div
            key={attachment.id}
            className={`relative ${compact ? 'w-fit shrink-0' : ''} ${cardRadiusClass} border border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg ${cardClassName}`}
          >
            {showImagePreview ? (
              <div
                className={imageFrameClass}
                onClick={() => onPreview?.(attachment.previewUrl!, attachment.name)}
              >
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className={imageClass}
                  onError={() => markPreviewError(attachment.id)}
                  loading="lazy"
                />
                {!compact && (
                  <div className="absolute inset-x-1 bottom-1 rounded-md bg-[var(--ink)]/70 px-1 py-0.5 text-xs font-medium text-[var(--paper-elevated)]">
                    <span className="block truncate">{attachment.name}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-w-[14rem] items-center gap-3 px-3 py-2">
                <div className="flex size-8 shrink-0 items-center justify-center">
                  <FileIcon name={attachment.name} size="regular" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-[var(--ink)]">
                    {attachment.name}
                  </p>
                  <p className="text-xs text-[var(--ink-muted)]">
                    {formatFileSize(attachment.size)}
                  </p>
                  {attachment.footnoteLines?.map((line, index) => (
                    <p
                      key={`${attachment.id}-footnote-${index}`}
                      className="text-xs text-[var(--ink-muted)]"
                    >
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => handleRemove(attachment.id)}
                className="absolute top-1.5 right-1.5 rounded-full bg-[var(--paper-elevated)]/95 p-1 text-[var(--ink)] shadow-sm transition hover:bg-[var(--paper-elevated)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
