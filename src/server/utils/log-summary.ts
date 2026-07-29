import { createHash } from 'node:crypto';

export const DEFAULT_LOG_TEXT_PREVIEW_CHARS = 100;
const LOG_FINGERPRINT_HEX_CHARS = 12;

export interface SensitiveValueLogSummary {
  present: boolean;
  chars: number;
  hash?: string;
}

function normalizeTextForLog(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * Format a user-visible text value as one bounded log field.
 *
 * The preview is JSON-quoted so quotes/control characters cannot create a
 * second physical log line. `chars` intentionally reports the original value
 * rather than the whitespace-normalized preview.
 */
export function formatTextPreviewForLog(
  value: string,
  limit = DEFAULT_LOG_TEXT_PREVIEW_CHARS,
): string {
  const preview = Array.from(normalizeTextForLog(value))
    .slice(0, Math.max(0, limit))
    .join('');
  return `text=${JSON.stringify(preview)} chars=${countCodePoints(value)}`;
}

/**
 * Describe a sensitive value without retaining any reversible content.
 * The short SHA-256 fingerprint is diagnostic identity only: it lets logs say
 * whether two launches used the same value without exposing its prefix.
 */
export function summarizeSensitiveValueForLog(
  value: string | null | undefined,
): SensitiveValueLogSummary {
  if (!value) return { present: false, chars: 0 };
  return {
    present: true,
    chars: countCodePoints(value),
    hash: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, LOG_FINGERPRINT_HEX_CHARS),
  };
}
