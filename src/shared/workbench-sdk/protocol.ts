export const WORKBENCH_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface WorkbenchApiVersion {
  readonly major: number;
  readonly minor: number;
}

export interface WorkbenchApiRequirement {
  readonly major: number;
  readonly minMinor: number;
  readonly maxMinor?: number;
}

export const WORKBENCH_HOST_API_VERSION: WorkbenchApiVersion = Object.freeze({
  major: 1,
  minor: 10,
});

export type WorkbenchCompatibilityReason =
  | "major-mismatch"
  | "host-too-old"
  | "host-too-new";

export type WorkbenchCompatibility =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly reason: WorkbenchCompatibilityReason;
      readonly message: string;
    };

export function formatWorkbenchApiVersion(
  version: WorkbenchApiVersion,
): string {
  return `${version.major}.${version.minor}`;
}

export function checkWorkbenchApiCompatibility(
  requirement: WorkbenchApiRequirement,
  host: WorkbenchApiVersion = WORKBENCH_HOST_API_VERSION,
): WorkbenchCompatibility {
  if (requirement.major !== host.major) {
    return {
      compatible: false,
      reason: "major-mismatch",
      message: `Workbench API major ${requirement.major} is incompatible with host ${formatWorkbenchApiVersion(host)}.`,
    };
  }
  if (host.minor < requirement.minMinor) {
    return {
      compatible: false,
      reason: "host-too-old",
      message: `Workbench requires API ${requirement.major}.${requirement.minMinor} or newer; host is ${formatWorkbenchApiVersion(host)}.`,
    };
  }
  if (requirement.maxMinor !== undefined && host.minor > requirement.maxMinor) {
    return {
      compatible: false,
      reason: "host-too-new",
      message: `Workbench supports API up to ${requirement.major}.${requirement.maxMinor}; host is ${formatWorkbenchApiVersion(host)}.`,
    };
  }
  return { compatible: true };
}
