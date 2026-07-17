import {
  WORKBENCH_MANIFEST_SCHEMA_VERSION,
  type WorkbenchApiRequirement,
} from './protocol';

export interface WorkbenchNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly order?: number;
}

export interface WorkbenchManifest {
  readonly manifestVersion: typeof WORKBENCH_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly api: WorkbenchApiRequirement;
  readonly entry: {
    readonly renderer: string;
    readonly defaultRoute: string;
  };
  readonly navigation: readonly WorkbenchNavigationItem[];
  readonly capabilities?: readonly string[];
}

export interface WorkbenchManifestIssue {
  readonly path: string;
  readonly message: string;
}

export type WorkbenchManifestValidation =
  | { readonly success: true; readonly manifest: WorkbenchManifest }
  | { readonly success: false; readonly issues: readonly WorkbenchManifestIssue[] };

const WORKBENCH_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/;
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: WorkbenchManifestIssue[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ path, message: 'must be a non-empty string' });
    return undefined;
  }
  return value.trim();
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  issues: WorkbenchManifestIssue[],
): number | undefined {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push({ path, message: 'must be a non-negative integer' });
    return undefined;
  }
  return value as number;
}

export function validateWorkbenchManifest(value: unknown): WorkbenchManifestValidation {
  const issues: WorkbenchManifestIssue[] = [];
  if (!isRecord(value)) {
    return { success: false, issues: [{ path: '$', message: 'must be an object' }] };
  }

  if (value.manifestVersion !== WORKBENCH_MANIFEST_SCHEMA_VERSION) {
    issues.push({
      path: 'manifestVersion',
      message: `must equal ${WORKBENCH_MANIFEST_SCHEMA_VERSION}`,
    });
  }

  const id = readNonEmptyString(value.id, 'id', issues);
  if (id && !WORKBENCH_ID_PATTERN.test(id)) {
    issues.push({ path: 'id', message: 'must be a namespaced lowercase id such as io.myagents.storyforge' });
  }
  const name = readNonEmptyString(value.name, 'name', issues);
  const description = readNonEmptyString(value.description, 'description', issues);
  const version = readNonEmptyString(value.version, 'version', issues);
  if (version && !SEMVER_PATTERN.test(version)) {
    issues.push({ path: 'version', message: 'must be a semantic version such as 1.0.0' });
  }

  let api: WorkbenchApiRequirement | undefined;
  if (!isRecord(value.api)) {
    issues.push({ path: 'api', message: 'must be an object' });
  } else {
    const major = readNonNegativeInteger(value.api.major, 'api.major', issues);
    const minMinor = readNonNegativeInteger(value.api.minMinor, 'api.minMinor', issues);
    const maxMinor = value.api.maxMinor === undefined
      ? undefined
      : readNonNegativeInteger(value.api.maxMinor, 'api.maxMinor', issues);
    if (minMinor !== undefined && maxMinor !== undefined && maxMinor < minMinor) {
      issues.push({ path: 'api.maxMinor', message: 'must be greater than or equal to api.minMinor' });
    }
    if (major !== undefined && minMinor !== undefined) api = { major, minMinor, ...(maxMinor === undefined ? {} : { maxMinor }) };
  }

  let renderer: string | undefined;
  let defaultRoute: string | undefined;
  if (!isRecord(value.entry)) {
    issues.push({ path: 'entry', message: 'must be an object' });
  } else {
    renderer = readNonEmptyString(value.entry.renderer, 'entry.renderer', issues);
    defaultRoute = readNonEmptyString(value.entry.defaultRoute, 'entry.defaultRoute', issues);
    if (renderer && !SEGMENT_PATTERN.test(renderer)) {
      issues.push({ path: 'entry.renderer', message: 'must be a lowercase logical module id' });
    }
  }

  const navigation: WorkbenchNavigationItem[] = [];
  if (!Array.isArray(value.navigation) || value.navigation.length === 0) {
    issues.push({ path: 'navigation', message: 'must contain at least one navigation item' });
  } else {
    const ids = new Set<string>();
    value.navigation.forEach((item, index) => {
      const path = `navigation[${index}]`;
      if (!isRecord(item)) {
        issues.push({ path, message: 'must be an object' });
        return;
      }
      const navId = readNonEmptyString(item.id, `${path}.id`, issues);
      const label = readNonEmptyString(item.label, `${path}.label`, issues);
      const icon = item.icon === undefined ? undefined : readNonEmptyString(item.icon, `${path}.icon`, issues);
      const order = item.order === undefined ? undefined : readNonNegativeInteger(item.order, `${path}.order`, issues);
      if (navId && !SEGMENT_PATTERN.test(navId)) {
        issues.push({ path: `${path}.id`, message: 'must be a lowercase route segment' });
      }
      if (navId && ids.has(navId)) issues.push({ path: `${path}.id`, message: 'must be unique' });
      if (navId) ids.add(navId);
      if (navId && label) navigation.push({ id: navId, label, ...(icon ? { icon } : {}), ...(order === undefined ? {} : { order }) });
    });
    if (defaultRoute && !ids.has(defaultRoute)) {
      issues.push({ path: 'entry.defaultRoute', message: 'must reference a navigation item id' });
    }
  }

  let capabilities: string[] | undefined;
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities)) {
      issues.push({ path: 'capabilities', message: 'must be an array of strings' });
    } else {
      capabilities = [];
      const seen = new Set<string>();
      value.capabilities.forEach((capability, index) => {
        const parsed = readNonEmptyString(capability, `capabilities[${index}]`, issues);
        if (!parsed) return;
        if (seen.has(parsed)) {
          issues.push({ path: `capabilities[${index}]`, message: 'must be unique' });
          return;
        }
        seen.add(parsed);
        capabilities!.push(parsed);
      });
    }
  }

  if (issues.length || !id || !name || !description || !version || !api || !renderer || !defaultRoute) {
    return { success: false, issues };
  }
  return {
    success: true,
    manifest: Object.freeze({
      manifestVersion: WORKBENCH_MANIFEST_SCHEMA_VERSION,
      id,
      name,
      description,
      version,
      api: Object.freeze(api),
      entry: Object.freeze({ renderer, defaultRoute }),
      navigation: Object.freeze(navigation.map((item) => Object.freeze(item))),
      ...(capabilities ? { capabilities: Object.freeze(capabilities) } : {}),
    }),
  };
}

export class WorkbenchManifestError extends Error {
  constructor(readonly issues: readonly WorkbenchManifestIssue[]) {
    super(`Invalid workbench manifest: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    this.name = 'WorkbenchManifestError';
  }
}

export function parseWorkbenchManifest(value: unknown): WorkbenchManifest {
  const result = validateWorkbenchManifest(value);
  if (!result.success) throw new WorkbenchManifestError(result.issues);
  return result.manifest;
}
