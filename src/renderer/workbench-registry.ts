import { createWorkbenchRegistry } from '@/workbench-sdk';
import { builtInWorkbenchDefinitions } from '@/workbenches';

export const workbenchRegistry = createWorkbenchRegistry(builtInWorkbenchDefinitions);
