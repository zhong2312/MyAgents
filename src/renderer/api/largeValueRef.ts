interface JsonLargeValueRef {
  kind: 'ref';
  id: string;
  mimetype: string;
}

function isJsonLargeValueRef(value: unknown): value is JsonLargeValueRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<JsonLargeValueRef>;
  return candidate.kind === 'ref'
    && typeof candidate.id === 'string'
    && /^[a-f0-9]{8,32}$/.test(candidate.id)
    && typeof candidate.mimetype === 'string'
    && candidate.mimetype.includes('json');
}

export async function fetchJsonLargeValueRef(
  baseUrl: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!isJsonLargeValueRef(value)) throw new Error('Invalid JSON large-value ref');
  // `/refs/:id` is the explicit large-value escape hatch and carries CORS
  // headers. Native fetch keeps the body off the Tauri invoke JSON channel;
  // routing it through invoke would re-buffer 256KiB–1MiB refs in IPC.
  const response = await fetch(`${baseUrl}/refs/${value.id}`);
  if (!response.ok) throw new Error(`JSON large-value ref returned ${response.status}`);
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON large-value ref did not contain an object');
  }
  return parsed as Record<string, unknown>;
}
