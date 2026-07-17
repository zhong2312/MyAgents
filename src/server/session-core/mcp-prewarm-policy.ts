export const MCP_PREWARM_GRACE_MS = 10_000;

export type McpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled';

export type McpServerStatusSnapshot = {
  name: string;
  status: McpConnectionStatus;
  error?: string;
};

export type McpPrewarmServerDetail = {
  id: string;
  status?: McpConnectionStatus;
  error?: string;
};

export type McpPrewarmClassification =
  | { state: 'ready' }
  | {
    state: 'pending';
    pendingServers: McpPrewarmServerDetail[];
    degradedServers: McpPrewarmServerDetail[];
  }
  | { state: 'degraded'; servers: McpPrewarmServerDetail[] };

export type McpPrewarmOutcome =
  | {
    state: 'ready';
    elapsedMs: number;
  }
  | {
    state: 'degraded';
    reason: 'terminal_status' | 'timeout' | 'status_read_failed';
    servers: McpPrewarmServerDetail[];
    elapsedMs: number;
  }
  | {
    state: 'owner_replaced';
    servers: McpPrewarmServerDetail[];
    elapsedMs: number;
  };

export type McpPrewarmOwner = {
  /** Object identity of the concrete persistent runtime control handle. */
  identity: object;
  /** Monotonic lifecycle generation assigned when the runtime identity changes. */
  generation: number;
  /** Monotonic installed-map revision, including same-id and ABA replacements. */
  revision: number;
  /** Stable runtime identity of the MCP map installed on this owner. */
  fingerprint: string;
  requiredServerIds: readonly string[];
  /** Absolute budget origin. A turn never creates a fresh deadline. */
  startedAt: number;
  deadlineAt: number;
  readStatuses(): Promise<readonly McpServerStatusSnapshot[]>;
};

function sameOwner(left: McpPrewarmOwner | null, right: McpPrewarmOwner): boolean {
  return left !== null
    && left.identity === right.identity
    && left.generation === right.generation
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint;
}

/**
 * Classify only the MCP ids installed by the current MyAgents-owned map.
 * Terminal failures are degraded, never a turn rejection. If any server is
 * still pending, it alone may consume the remaining absolute grace budget.
 */
export function classifyMcpPrewarmStatuses(
  requiredServerIds: readonly string[],
  statuses: readonly McpServerStatusSnapshot[],
): McpPrewarmClassification {
  if (requiredServerIds.length === 0) return { state: 'ready' };

  const byName = new Map(statuses.map(status => [status.name, status]));
  const pendingServers: McpPrewarmServerDetail[] = [];
  const degradedServers: McpPrewarmServerDetail[] = [];

  for (const id of requiredServerIds) {
    const status = byName.get(id);
    if (status?.status === 'connected') continue;
    const detail: McpPrewarmServerDetail = {
      id,
      ...(status ? { status: status.status } : {}),
      ...(status?.error ? { error: status.error } : {}),
    };
    if (status?.status === 'pending') pendingServers.push(detail);
    else degradedServers.push(detail);
  }

  if (pendingServers.length > 0) {
    return { state: 'pending', pendingServers, degradedServers };
  }
  if (degradedServers.length > 0) {
    return { state: 'degraded', servers: degradedServers };
  }
  return { state: 'ready' };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StatusReadResult =
  | { kind: 'statuses'; statuses: readonly McpServerStatusSnapshot[] }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled' }
  | { kind: 'timeout' };

function readStatusesUntil(
  owner: McpPrewarmOwner,
  now: () => number,
  signal?: AbortSignal,
): Promise<StatusReadResult> {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const remainingMs = owner.deadlineAt - now();
  if (remainingMs <= 0) return Promise.resolve({ kind: 'timeout' });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: StatusReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => settle({ kind: 'cancelled' });
    const timer = setTimeout(() => settle({ kind: 'timeout' }), remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => owner.readStatuses())
      .then(
        statuses => settle({ kind: 'statuses', statuses }),
        error => settle({ kind: 'error', error }),
      );
  });
}

async function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (completed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve(completed);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => finish(true),
      error => finish(false, error),
    );
  });
}

function elapsedMs(owner: McpPrewarmOwner, now: () => number): number {
  return Math.max(0, now() - owner.startedAt);
}

/**
 * Observe one runtime/MCP-map generation until it is ready, terminally
 * degraded, replaced, cancelled, or its owner-created absolute grace expires.
 * This function never turns MCP failure into an AI-turn failure.
 */
export async function awaitMcpPrewarm(params: {
  owner: McpPrewarmOwner;
  getOwner(): McpPrewarmOwner | null;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<McpPrewarmOutcome> {
  const { owner } = params;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pollMs = Math.max(200, Math.min(500, params.pollMs ?? 250));
  let lastObserved: McpPrewarmServerDetail[] = owner.requiredServerIds.map(id => ({ id }));

  if (owner.requiredServerIds.length === 0) {
    return { state: 'ready', elapsedMs: elapsedMs(owner, now) };
  }

  while (true) {
    if (params.signal?.aborted) {
      throw new Error('MCP pre-warm wait cancelled');
    }
    if (!sameOwner(params.getOwner(), owner)) {
      return {
        state: 'owner_replaced',
        servers: lastObserved,
        elapsedMs: elapsedMs(owner, now),
      };
    }
    if (now() >= owner.deadlineAt) {
      return {
        state: 'degraded',
        reason: 'timeout',
        servers: lastObserved,
        elapsedMs: elapsedMs(owner, now),
      };
    }

    const read = await readStatusesUntil(owner, now, params.signal);
    if (read.kind === 'cancelled') throw new Error('MCP pre-warm wait cancelled');
    if (!sameOwner(params.getOwner(), owner)) {
      return {
        state: 'owner_replaced',
        servers: lastObserved,
        elapsedMs: elapsedMs(owner, now),
      };
    }
    if (read.kind === 'timeout') {
      return {
        state: 'degraded',
        reason: 'timeout',
        servers: lastObserved,
        elapsedMs: elapsedMs(owner, now),
      };
    }
    if (read.kind === 'error') {
      return {
        state: 'degraded',
        reason: 'status_read_failed',
        servers: owner.requiredServerIds.map(id => ({ id, error: errorText(read.error) })),
        elapsedMs: elapsedMs(owner, now),
      };
    }

    const classification = classifyMcpPrewarmStatuses(owner.requiredServerIds, read.statuses);
    if (classification.state === 'ready') {
      return { state: 'ready', elapsedMs: elapsedMs(owner, now) };
    }
    if (classification.state === 'degraded') {
      return {
        state: 'degraded',
        reason: 'terminal_status',
        servers: classification.servers,
        elapsedMs: elapsedMs(owner, now),
      };
    }

    lastObserved = [...classification.degradedServers, ...classification.pendingServers];
    const slept = await sleepWithSignal(
      sleep,
      Math.min(pollMs, Math.max(0, owner.deadlineAt - now())),
      params.signal,
    );
    if (!slept) throw new Error('MCP pre-warm wait cancelled');
  }
}

export function formatMcpPrewarmServers(servers: readonly McpPrewarmServerDetail[]): string {
  return servers.map(server => {
    const status = server.status ? `(${server.status})` : '(missing)';
    const error = server.error ? `:${server.error}` : '';
    return `${server.id}${status}${error}`;
  }).join(',') || '(none)';
}
