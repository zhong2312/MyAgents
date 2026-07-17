import type { OpenWorkbenchRequest } from '../../shared/workbench-sdk';
import type { Tab } from '@/types/tab';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { WorkbenchRegistry } from './registry';

export function createWorkbenchTab(
  request: OpenWorkbenchRequest,
  registry: WorkbenchRegistry,
  id: string,
): Tab {
  const registration = registry.get(request.workbenchId);
  const manifest = registration?.definition.manifest;
  return {
    id,
    agentDir: request.workspacePath,
    sessionId: null,
    view: 'workbench',
    title: request.title?.trim() || manifest?.name || request.workbenchId,
    workbench: {
      workbenchId: request.workbenchId,
      route: request.route || manifest?.entry.defaultRoute || 'overview',
    },
    sidecarConfigDisposition: 'push',
  };
}

export function isSameWorkbenchTab(tab: Tab, request: OpenWorkbenchRequest): boolean {
  return tab.view === 'workbench'
    && tab.workbench?.workbenchId === request.workbenchId
    && workspacePathsEqual(tab.agentDir, request.workspacePath);
}
