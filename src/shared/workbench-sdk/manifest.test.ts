import { describe, expect, it } from 'vitest';

import { parseWorkbenchManifest, validateWorkbenchManifest } from './manifest';

const validManifest = {
  manifestVersion: 1,
  id: 'io.myagents.storyforge',
  name: 'StoryForge',
  description: 'Novel writing workbench',
  version: '1.0.0',
  api: { major: 1, minMinor: 0 },
  entry: { renderer: 'storyforge', defaultRoute: 'overview' },
  navigation: [
    { id: 'overview', label: 'Overview', icon: 'layout-dashboard', order: 0 },
    { id: 'chapters', label: 'Chapters', icon: 'file-text', order: 10 },
  ],
  capabilities: ['workspace:read'],
};

describe('workbench manifest', () => {
  it('parses and freezes a valid manifest', () => {
    const manifest = parseWorkbenchManifest(validManifest);
    expect(manifest.id).toBe('io.myagents.storyforge');
    expect(manifest.entry.defaultRoute).toBe('overview');
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.navigation)).toBe(true);
  });

  it('reports structural, identity and routing failures together', () => {
    const result = validateWorkbenchManifest({
      ...validManifest,
      id: 'StoryForge',
      version: 'latest',
      entry: { renderer: 'StoryForge UI', defaultRoute: 'missing' },
      navigation: [
        { id: 'overview', label: 'Overview' },
        { id: 'overview', label: '' },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      'id',
      'version',
      'entry.renderer',
      'entry.defaultRoute',
      'navigation[1].id',
      'navigation[1].label',
    ]));
  });
});
