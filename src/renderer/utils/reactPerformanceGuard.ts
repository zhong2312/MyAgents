/**
 * React 19's development component tracks attach a large `detail` object to
 * every component measure. Chat messages and tool results can make that object
 * very large, and Chromium keeps the entries in the renderer Performance
 * Timeline. Remove the React-only detail payload and periodically evict the
 * corresponding measures in development builds.
 */

const REACT_MEASURE_PREFIX = '\u200b';
const PATCH_MARKER = '__myagentsReactPerformanceGuardInstalled';

type GuardedPerformance = Performance & {
  [PATCH_MARKER]?: boolean;
};

export function installReactPerformanceGuard(
  target: Performance = globalThis.performance,
): () => void {
  if (!import.meta.env.DEV || !target) return () => {};

  const guarded = target as GuardedPerformance;
  if (guarded[PATCH_MARKER]) return () => {};

  const originalMeasure = target.measure.bind(target);
  const originalClearMeasures = target.clearMeasures.bind(target);
  const timers = globalThis.window;
  let intervalId: number | undefined;

  const clearReactMeasures = (): void => {
    try {
      const entries = target.getEntriesByType('measure');
      const names = new Set(
        entries
          .map((entry) => entry.name)
          .filter((name) => name.startsWith(REACT_MEASURE_PREFIX)),
      );
      for (const name of names) originalClearMeasures(name);
    } catch {
      // Performance diagnostics must never affect the renderer.
    }
  };

  const guardedMeasure: Performance['measure'] = ((name: string, startOrOptions?: unknown, endMark?: string) => {
    if (!name.startsWith(REACT_MEASURE_PREFIX)) {
      if (endMark !== undefined) return originalMeasure(name, startOrOptions as never, endMark);
      if (startOrOptions !== undefined) return originalMeasure(name, startOrOptions as never);
      return originalMeasure(name);
    }

    // React passes PerformanceMeasureOptions with a devtools `detail` object.
    // Passing only timing marks avoids structured-cloning the component props.
    if (startOrOptions && typeof startOrOptions === 'object') {
      const options = startOrOptions as { start?: string | number; end?: string | number };
      return originalMeasure(name, {
        ...(options.start !== undefined ? { start: options.start } : {}),
        ...(options.end !== undefined ? { end: options.end } : {}),
      });
    }
    if (endMark !== undefined) return originalMeasure(name, startOrOptions as never, endMark);
    if (startOrOptions !== undefined) return originalMeasure(name, startOrOptions as never);
    return originalMeasure(name);
  }) as Performance['measure'];

  try {
    target.measure = guardedMeasure;
    guarded[PATCH_MARKER] = true;
    if (typeof timers?.setInterval === 'function') {
      intervalId = timers.setInterval(clearReactMeasures, 15_000);
    }
    clearReactMeasures();
  } catch {
    // Some embedded WebViews expose a non-writable Performance object.
    return () => {};
  }

  return () => {
    if (intervalId !== undefined) timers?.clearInterval(intervalId);
    try {
      target.measure = originalMeasure;
      delete guarded[PATCH_MARKER];
    } catch {
      // Best effort cleanup for tests and hot reload.
    }
  };
}
