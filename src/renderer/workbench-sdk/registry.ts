import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

import {
  WORKBENCH_HOST_API_VERSION,
  checkWorkbenchApiCompatibility,
  type WorkbenchApiVersion,
  type WorkbenchCompatibility,
} from '../../shared/workbench-sdk';
import type {
  WorkbenchDefinition,
  WorkbenchProjectCreatorProps,
  WorkbenchRendererProps,
} from './types';

export interface RegisteredWorkbench {
  readonly definition: WorkbenchDefinition;
  readonly compatibility: WorkbenchCompatibility;
  readonly Renderer: LazyExoticComponent<ComponentType<WorkbenchRendererProps>>;
  readonly ProjectCreator?: LazyExoticComponent<ComponentType<WorkbenchProjectCreatorProps>>;
}

export interface WorkbenchRegistry {
  get(id: string): RegisteredWorkbench | undefined;
  list(): readonly RegisteredWorkbench[];
}

export class DuplicateWorkbenchError extends Error {
  constructor(id: string) {
    super(`Workbench id is already registered: ${id}`);
    this.name = 'DuplicateWorkbenchError';
  }
}

export function createWorkbenchRegistry(
  definitions: readonly WorkbenchDefinition[],
  hostVersion: WorkbenchApiVersion = WORKBENCH_HOST_API_VERSION,
): WorkbenchRegistry {
  const byId = new Map<string, RegisteredWorkbench>();
  for (const definition of definitions) {
    const id = definition.manifest.id;
    if (byId.has(id)) throw new DuplicateWorkbenchError(id);
    const registration: RegisteredWorkbench = Object.freeze({
      definition,
      compatibility: checkWorkbenchApiCompatibility(definition.manifest.api, hostVersion),
      Renderer: lazy(definition.load),
      ...(definition.launcher
        ? { ProjectCreator: lazy(definition.launcher.loadProjectCreator) }
        : {}),
    });
    byId.set(id, registration);
  }
  const entries = Object.freeze([...byId.values()]);
  return Object.freeze({
    get: (id: string) => byId.get(id),
    list: () => entries,
  });
}
