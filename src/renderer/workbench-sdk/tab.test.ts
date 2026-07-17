import { describe, expect, it } from 'vitest';

import { defineWorkbench } from './defineWorkbench';
import { createWorkbenchRegistry } from './registry';
import { createWorkbenchTab, isSameWorkbenchTab } from './tab';

const registry = createWorkbenchRegistry([
  defineWorkbench({
    manifestVersion: 1,
    id: 'io.myagents.testbench',
    name: 'Testbench',
    description: 'Test workbench',
    version: '1.0.0',
    api: { major: 1, minMinor: 0 },
    entry: { renderer: 'testbench', defaultRoute: 'home' },
    navigation: [{ id: 'home', label: 'Home' }],
  }, async () => ({ default: () => null })),
]);

describe('workbench tab', () => {
  it('binds the manifest default route and workspace without a chat session', () => {
    const tab = createWorkbenchTab({
      workbenchId: 'io.myagents.testbench',
      workspacePath: 'C:\\Work\\Novel',
    }, registry, 'tab-1');
    expect(tab).toMatchObject({
      id: 'tab-1',
      view: 'workbench',
      agentDir: 'C:\\Work\\Novel',
      sessionId: null,
      title: 'Testbench',
      workbench: { workbenchId: 'io.myagents.testbench', route: 'home' },
    });
  });

  it('uses canonical Windows path identity when finding an existing tab', () => {
    const tab = createWorkbenchTab({
      workbenchId: 'io.myagents.testbench',
      workspacePath: 'C:\\Work\\Novel',
    }, registry, 'tab-1');
    expect(isSameWorkbenchTab(tab, {
      workbenchId: 'io.myagents.testbench',
      workspacePath: 'c:/work/novel/',
    })).toBe(true);
  });
});
