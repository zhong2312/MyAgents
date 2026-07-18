/**
 * Host-side policy helpers for workbench Agent Session dialogs.
 *
 * A bound conversation is considered empty/broken when it never accumulated a
 * real user turn and has no last-message preview. Those sessions should not be
 * resumed — the host recreates them and re-sends the workbench bootstrap prompt.
 */

export interface WorkbenchSessionHealthMeta {
  readonly stats?: {
    readonly turnCount?: number;
  } | null;
  readonly lastMessagePreview?: string | null;
}

export function isEmptyOrBrokenSession(
  meta: WorkbenchSessionHealthMeta | null | undefined,
): boolean {
  if (!meta) return true;
  const turnCount = meta.stats?.turnCount ?? 0;
  const preview = meta.lastMessagePreview?.trim() ?? "";
  return turnCount <= 0 && preview.length === 0;
}
