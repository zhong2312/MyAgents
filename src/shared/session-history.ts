export const MAX_SESSION_HISTORY_GROUP_DEPTH = 2;
export const MAX_SESSION_HISTORY_GROUP_SEGMENT_LENGTH = 80;

export function parseSessionHistoryGroupPath(
  value: unknown,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("historyGroupPath must be an array");
  }
  if (value.length === 0) return undefined;
  if (value.length > MAX_SESSION_HISTORY_GROUP_DEPTH) {
    throw new Error(
      `historyGroupPath supports at most ${MAX_SESSION_HISTORY_GROUP_DEPTH} levels`,
    );
  }

  return value.map((segment, index) => {
    if (typeof segment !== "string") {
      throw new Error(`historyGroupPath[${index}] must be a string`);
    }
    const normalized = segment.trim();
    if (!normalized) {
      throw new Error(`historyGroupPath[${index}] must not be empty`);
    }
    if (normalized.length > MAX_SESSION_HISTORY_GROUP_SEGMENT_LENGTH) {
      throw new Error(
        `historyGroupPath[${index}] exceeds ${MAX_SESSION_HISTORY_GROUP_SEGMENT_LENGTH} characters`,
      );
    }
    if (/\p{Cc}/u.test(normalized)) {
      throw new Error(`historyGroupPath[${index}] contains control characters`);
    }
    return normalized;
  });
}
