import { describe, expect, it } from 'vitest';

import type { Tab } from '@/types/tab';
import { resolveGlobalSidebarWorkspace } from './globalSidebarProjection';

function tab(view: Tab['view'], over: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    agentDir: null,
    sessionId: null,
    view,
    title: 'Tab',
    sidecarConfigDisposition: 'push',
    ...over,
  };
}

describe('resolveGlobalSidebarWorkspace', () => {
  it('projects the workspace selected by the active Launcher', () => {
    expect(resolveGlobalSidebarWorkspace(tab('launcher', { launcherWorkspacePath: '/work/mino' })))
      .toBe('/work/mino');
  });

  it('projects the active Chat workspace directly from Tab authority', () => {
    expect(resolveGlobalSidebarWorkspace(tab('chat', { agentDir: '/work/project' })))
      .toBe('/work/project');
  });

  it.each(['settings', 'capabilities', 'taskcenter', 'space'] as const)(
    'does not leak stale workspace context into a %s tab',
    (view) => {
      expect(resolveGlobalSidebarWorkspace(tab(view, { launcherWorkspacePath: '/work/stale' }))).toBeNull();
    },
  );
});
