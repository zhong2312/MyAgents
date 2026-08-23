export type SubagentLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface SubagentLifecycle {
  status: SubagentLifecycleStatus;
  startedAt: number;
  finishedAt?: number;
}

export function isTerminalSubagentLifecycleStatus(
  status: SubagentLifecycleStatus,
): status is Exclude<SubagentLifecycleStatus, 'running'> {
  return status !== 'running';
}

type ResidualSubagentCall = {
  isLoading?: boolean;
  result?: string;
  isError?: boolean;
};

/**
 * Root-terminal parity policy for a nested call that never produced a terminal
 * result. Preserve real output, but make a resultless residual visibly
 * interrupted/failed instead of silently presenting it as successful.
 */
export function finalizeResidualSubagentCall<T extends ResidualSubagentCall>(
  call: T,
  status: 'failed' | 'interrupted',
): T {
  if (!call.isLoading) return call;
  return {
    ...call,
    isLoading: false,
    isError: true,
    result: call.result ?? (status === 'interrupted' ? 'Interrupted' : 'Failed'),
  };
}
