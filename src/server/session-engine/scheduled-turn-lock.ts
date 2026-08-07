let scheduledTurnDispatchQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize scheduled turns that share one Sidecar's mutable Session/runtime
 * binding. The lock belongs to the neutral SessionEngine layer because both
 * builtin and external adapters consume it through Task/Goal orchestrators.
 */
export async function withScheduledTurnDispatchLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const next = scheduledTurnDispatchQueue
    .catch(() => undefined)
    .then(operation);
  scheduledTurnDispatchQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
