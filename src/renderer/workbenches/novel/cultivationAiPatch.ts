export function mergeCultivationAiPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const immutableReference =
      key === "id" || key.endsWith("Id") || key.endsWith("Ids");
    if (
      !(key in base) ||
      immutableReference ||
      key === "name" ||
      key === "audit" ||
      key === "schemaVersion" ||
      key === "updatedAt" ||
      Array.isArray(value)
    )
      continue;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      next[key] = mergeCultivationAiPatch(
        base[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (
      value !== null &&
      value !== undefined &&
      base[key] !== null &&
      typeof value === typeof base[key] &&
      (typeof value !== "string" || value.trim())
    ) {
      next[key] = value;
    }
  }
  return next;
}
