export type SessionConfigPushMode = 'background' | 'explicit';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function sessionConfigPushFingerprint(body: unknown): string {
  return JSON.stringify(stableValue(body));
}

export function shouldPushSessionConfig(
  previousFingerprint: string | null,
  nextFingerprint: string,
  mode: SessionConfigPushMode,
): boolean {
  return mode === 'explicit' || previousFingerprint !== nextFingerprint;
}
