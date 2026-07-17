import type { WorkbenchDefinition } from '@/workbench-sdk';
import novelWorkbenchDefinition from './novel';

// Official workbenches are added here. Keeping this as the only aggregation
// point prevents the MyAgents shell from importing a concrete workbench.
export const builtInWorkbenchDefinitions: readonly WorkbenchDefinition[] = Object.freeze([
  novelWorkbenchDefinition,
]);
