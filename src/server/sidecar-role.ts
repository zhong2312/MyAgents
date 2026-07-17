export type SidecarRole = 'global' | 'session';

/** Parse the explicit Rust-provided process role; omitted remains fail-safe Session. */
export function parseSidecarRole(value: string | null): SidecarRole {
  if (value === null) return 'session';
  if (value === 'global' || value === 'session') return value;
  throw new Error(`Invalid --sidecar-role: ${value}`);
}
