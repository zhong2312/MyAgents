import { createHash } from 'crypto';
import { realpathSync, statSync } from 'fs';
import { managementApi } from './management-api-client';
import {
  diagnoseSdkSubprocessFailure,
  SdkChildLaunchCircuitOpenError,
} from './sdk-subprocess-diagnostics';

type ManagementCall = (
  path: string,
  method?: 'GET' | 'POST',
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number; parentSignal?: AbortSignal },
) => Promise<Record<string, unknown>>;

type GuardOptions = {
  managementCall?: ManagementCall;
  sidecarId?: string;
};

type QueryWithInitialization = {
  initializationResult?: () => Promise<unknown>;
};

const MANAGEMENT_GUARD_TIMEOUT_MS = 2_000;
const MIN_RETRY_AFTER_MS = 1_000;

class SdkChildLaunchGuardRejectedError extends Error {
  readonly code = 'SDK_CHILD_LAUNCH_GUARD_REJECTED';

  constructor(detail: unknown) {
    super(`MyAgents 运行保护状态已失效，已阻止启动 Claude 运行组件。请重启应用后重试。（${String(detail || 'unknown')}）`);
    this.name = 'SdkChildLaunchGuardRejectedError';
  }
}

function executableIdentity(executablePath: string): string {
  let canonicalPath = executablePath;
  let metadata = 'metadata-unavailable';
  try {
    canonicalPath = realpathSync(executablePath);
    const stat = statSync(canonicalPath);
    metadata = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode].join(':');
  } catch {
    // Tests, development shims, and an executable removed during update may
    // not be stat-able. The normalized path still gives Rust a stable scope;
    // the real spawn error remains the source of truth.
  }
  return createHash('sha256')
    .update(`${canonicalPath}\0${metadata}`)
    .digest('hex');
}

function deterministicErrorCode(value: unknown): 'EPERM' | 'EACCES' | 'ENOEXEC' {
  return value === 'EACCES' || value === 'ENOEXEC' ? value : 'EPERM';
}

function finiteRetryAfter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_RETRY_AFTER_MS, Math.round(value))
    : MIN_RETRY_AFTER_MS;
}

function isTransportUnavailable(admission: Record<string, unknown>): boolean {
  return admission.code === 'management_unavailable'
    || admission.code === 'transport_outcome_unknown';
}

/**
 * Application-level admission around the SDK's child-process control plane.
 *
 * Rust owns the circuit because Session:Sidecar is 1:1: a process-local flag
 * would still allow every tab, IM bot, and background owner to retry the same
 * broken bundled executable. Management unavailability deliberately fails
 * open so a Rust control-plane outage cannot disable otherwise healthy SDK
 * execution.
 */
export async function createGuardedSdkQuery<T>(
  executablePath: string,
  createQuery: () => T,
  options: GuardOptions = {},
): Promise<T> {
  const sidecarId = options.sidecarId ?? process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) {
    // Standalone unit/dev callers without an app control plane remain usable.
    // A production Sidecar with a management port but no identity is stale or
    // misconfigured and must not bypass the application circuit.
    if (!options.managementCall && !process.env.MYAGENTS_MANAGEMENT_PORT) return createQuery();
    throw new SdkChildLaunchGuardRejectedError('missing sidecar identity');
  }

  const call = options.managementCall ?? managementApi;
  const identity = executableIdentity(executablePath);
  const requestOptions = { timeoutMs: MANAGEMENT_GUARD_TIMEOUT_MS };
  const admission = await call(
    '/api/runtime/sdk-child/admit',
    'POST',
    { sidecarId, executableIdentity: identity },
    requestOptions,
  );
  if (admission.ok !== true) {
    if (isTransportUnavailable(admission)) return createQuery();
    throw new SdkChildLaunchGuardRejectedError(admission.code ?? admission.error);
  }

  if (admission.admitted !== true) {
    const errorCode = deterministicErrorCode(admission.errorCode);
    const retryAfterMs = finiteRetryAfter(admission.retryAfterMs);
    throw new SdkChildLaunchCircuitOpenError(errorCode, retryAfterMs);
  }

  const admissionEpoch = admission.admissionEpoch;
  if (typeof admissionEpoch !== 'number' || !Number.isSafeInteger(admissionEpoch) || admissionEpoch <= 0) {
    throw new SdkChildLaunchGuardRejectedError('missing admission epoch');
  }

  let settled = false;
  let settleInFlight: Promise<void> | null = null;
  const settle = async (
    outcome: 'ready' | 'spawn_denied' | 'released',
    errorCode?: 'EPERM' | 'EACCES' | 'ENOEXEC',
  ): Promise<void> => {
    if (settled) return;
    if (settleInFlight) return settleInFlight;
    settleInFlight = (async () => {
      const result = await call(
        '/api/runtime/sdk-child/settle',
        'POST',
        {
          sidecarId,
          executableIdentity: identity,
          admissionEpoch,
          outcome,
          ...(errorCode ? { errorCode } : {}),
        },
        requestOptions,
      );
      if (result.ok === true) settled = true;
    })().finally(() => {
      settleInFlight = null;
    });
    return settleInFlight;
  };

  const settleFromError = (error: unknown): void => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      error,
    });
    if (diagnostic?.kind === 'sdk-child-spawn-denied' && diagnostic.errorCode) {
      void settle('spawn_denied', diagnostic.errorCode);
    } else {
      void settle('released');
    }
  };

  let sdkQuery: T;
  try {
    sdkQuery = createQuery();
  } catch (error) {
    settleFromError(error);
    throw error;
  }

  const initializationResult = (sdkQuery as QueryWithInitialization).initializationResult;
  if (typeof initializationResult !== 'function') {
    void settle('released');
    return sdkQuery;
  }

  try {
    void initializationResult.call(sdkQuery).then(
      () => { void settle('ready'); },
      settleFromError,
    );
  } catch (error) {
    settleFromError(error);
  }
  return sdkQuery;
}
