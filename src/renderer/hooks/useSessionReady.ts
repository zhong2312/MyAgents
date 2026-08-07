/**
 * Pattern 4 — useSessionReady
 *
 * Polls the sidecar's `/health/ready` endpoint while the caller indicates the
 * session is "loading" (i.e. waiting for deferred init). Stops polling as
 * soon as the sidecar reports `ready` (or `failed`), so steady-state Chat
 * surfaces have zero overhead.
 *
 * Today the Rust `wait_for_readiness` (sidecar.rs) already blocks
 * `ensureSessionSidecar` until /health/ready returns 200. So in the happy
 * path this hook resolves immediately on first poll. Its real value is the
 * narrow window between the renderer optimistically rendering the Chat tab
 * and the Rust call returning, plus surfacing structured 503 bodies (phase /
 * error) when the sidecar is in trouble.
 *
 * Callers:
 *  - Pass the ready sidecar port (from `ensureSessionSidecar` result, or
 *    `getSessionPort`). When `null`, the hook reports `loading` without
 *    polling — there's no endpoint to hit.
 *  - Set `enabled=false` to fully pause polling (e.g. once Chat is ready).
 *
 * Architecture note: this is intentionally polling. The renderer already has
 * an SSE channel (`TabProvider.handleSseEvent`) but it's chat-message-shaped;
 * adding a `health:ready` event class would couple the SSE machinery to the
 * sidecar lifecycle in a way Pattern 4 explicitly de-scopes. A 1Hz poll for
 * a few seconds during startup is cheaper to maintain.
 */

import { useEffect, useRef, useState } from 'react';
import { sessionSidecarFetch } from '@/api/tauriClient';

export type SessionReadyState =
  | { kind: 'loading' }
  | { kind: 'pending'; phase?: string }
  | { kind: 'ready' }
  | { kind: 'failed'; phase: string; error: string; retryable: boolean };

interface UseSessionReadyOptions {
  sessionId: string | null | undefined;
  tabId: string;
  /** Set to false to stop polling (e.g., Chat fully loaded). */
  enabled: boolean;
  /** Poll interval in ms. Default 1000. */
  intervalMs?: number;
}

/**
 * Pattern 4 readiness hook.
 *
 * Returns the most recent observed state. While `enabled` and `port` are
 * both set, polls /health/ready every `intervalMs`. Stops on `ready` or
 * `failed` (terminal states), or when `enabled` flips false.
 */
export function useSessionReady({
  sessionId,
  tabId,
  enabled,
  intervalMs = 1000,
}: UseSessionReadyOptions): SessionReadyState {
  const [state, setState] = useState<SessionReadyState>({ kind: 'loading' });
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    if (!enabled || !sessionId) {
      // No active polling; reset to loading so a remount starts fresh.
      setState({ kind: 'loading' });
      return () => { cancelledRef.current = true; };
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const resp = await sessionSidecarFetch(
          sessionId,
          { type: 'tab', id: tabId },
          '/health/ready',
          { method: 'GET' },
        );
        if (cancelledRef.current) return;
        const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
        if (resp.status === 200 && body.state === 'ready') {
          setState({ kind: 'ready' });
          return; // terminal
        }
        if (body.state === 'failed') {
          setState({
            kind: 'failed',
            phase: typeof body.phase === 'string' ? body.phase : 'unknown',
            error: typeof body.error === 'string' ? body.error : 'unknown error',
            retryable: body.retryable === true,
          });
          return; // terminal
        }
        // pending / phase / unknown 5xx
        setState({
          kind: 'pending',
          phase: typeof body.phase === 'string' ? body.phase : undefined,
        });
      } catch {
        // Sidecar unreachable — keep showing loading, retry.
        if (!cancelledRef.current) setState({ kind: 'loading' });
      } finally {
        if (!cancelledRef.current) {
          timeoutId = setTimeout(tick, intervalMs);
        }
      }
    };

    // Fire immediately, then on interval.
    tick();

    return () => {
      cancelledRef.current = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [sessionId, tabId, enabled, intervalMs]);

  return state;
}
