import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MYAGENTS_SOURCE_CODE_URL } from './settingsSections';

const settingsPageSource = readFileSync(
  resolve(import.meta.dirname, 'SettingsPage.tsx'),
  'utf8',
);

describe('About source links contract', () => {
  it('keeps the source-code action on the repository default page', () => {
    expect(MYAGENTS_SOURCE_CODE_URL).toBe('https://github.com/hAcKlyc/MyAgents');

    const labelIndex = settingsPageSource.indexOf("tSettings('about.sourceCode')");
    expect(labelIndex).toBeGreaterThan(-1);

    const actionStart = settingsPageSource.lastIndexOf('<ExternalLink', labelIndex);
    expect(actionStart).toBeGreaterThan(-1);

    const sourceCodeAction = settingsPageSource.slice(actionStart, labelIndex);
    expect(sourceCodeAction).toContain('href={MYAGENTS_SOURCE_CODE_URL}');
    expect(sourceCodeAction).not.toContain('sourceRevision');
  });
});
