import { currentSupportedLocale } from '@/i18n/format';
import type { SupportedLocale } from '../../../../shared/i18n';

export interface MemoryEvolutionLastRun {
  executedAt: number;
  success: boolean;
}

export function formatMemoryEvolutionRunTime(
  timestampMs: number,
  nowMs: number = Date.now(),
  locale: SupportedLocale = currentSupportedLocale(),
): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';

  const elapsedMs = Math.max(0, nowMs - timestampMs);
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);
  if (elapsedHours < 1) {
    return locale === 'zh-CN' ? '不到 1 小时前' : 'less than 1 hour ago';
  }
  if (elapsedHours < 24) {
    if (locale === 'zh-CN') return `${elapsedHours} 小时前`;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(
      -elapsedHours,
      'hour',
    );
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
