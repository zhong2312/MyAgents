import { describe, expect, it } from 'vitest';

import {
  formatTextPreviewForLog,
  summarizeSensitiveValueForLog,
} from './log-summary';

describe('log summary', () => {
  it('writes one JSON-quoted 100-character preview and keeps the original length', () => {
    const value = `first\nline "quoted" ${'x'.repeat(120)}`;
    const formatted = formatTextPreviewForLog(value);

    expect(formatted).not.toContain('\n');
    expect(formatted).toContain('text="first line \\"quoted\\" ');
    expect(formatted).toContain(`chars=${value.length}`);
    const preview = JSON.parse(formatted.match(/^text=(".*") chars=/)?.[1] ?? 'null') as string;
    expect(preview).toHaveLength(100);
  });

  it('fingerprints sensitive values without retaining a prefix', () => {
    const sensitive = 'private developer instructions with user identity';
    const summary = summarizeSensitiveValueForLog(sensitive);

    expect(summary).toEqual({
      present: true,
      chars: sensitive.length,
      hash: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(summarizeSensitiveValueForLog(sensitive)).toEqual(summary);
    expect(summarizeSensitiveValueForLog(`${sensitive}!`).hash).not.toBe(summary.hash);
  });

  it('counts and truncates Unicode code points without splitting an emoji', () => {
    expect(formatTextPreviewForLog('😀中文', 1)).toBe('text="😀" chars=3');
    expect(summarizeSensitiveValueForLog('😀中文')).toMatchObject({ chars: 3 });
  });

  it('represents an absent sensitive value without a hash', () => {
    expect(summarizeSensitiveValueForLog(null)).toEqual({ present: false, chars: 0 });
    expect(summarizeSensitiveValueForLog('')).toEqual({ present: false, chars: 0 });
  });
});
