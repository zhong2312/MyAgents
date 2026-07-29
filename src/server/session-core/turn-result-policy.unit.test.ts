import { describe, expect, it } from 'vitest';

import {
  classifyBuiltinSdkTerminalResult,
  classifyTransientProviderTextError,
  decideBuiltinInjectedTurnResult,
  decideExternalInjectedTurnResult,
  decideTransientProviderTextRetry,
} from './turn-result-policy';

describe('turn-result-policy', () => {
  it('accepts only completed or legacy missing terminal reasons as success', () => {
    expect(classifyBuiltinSdkTerminalResult({ isError: false, terminalReason: 'completed' })).toBe('complete');
    expect(classifyBuiltinSdkTerminalResult({ isError: false })).toBe('complete');
    expect(classifyBuiltinSdkTerminalResult({ isError: false, terminalReason: '' })).toBe('complete');
  });

  it('classifies abort reasons as stopped even when the SDK uses an error-shaped result', () => {
    expect(classifyBuiltinSdkTerminalResult({
      isError: true,
      terminalReason: 'aborted_streaming',
    })).toBe('stopped');
    expect(classifyBuiltinSdkTerminalResult({
      isError: false,
      terminalReason: 'aborted_tools',
    })).toBe('stopped');
  });

  it.each([
    'budget_exhausted',
    'structured_output_retry_exhausted',
    'tool_deferred_unavailable',
    'turn_setup_failed',
    'malformed_tool_use_exhausted',
    'api_error',
    'some_future_reason',
  ])('fails closed for non-completed terminal reason %s', (terminalReason) => {
    expect(classifyBuiltinSdkTerminalResult({ isError: false, terminalReason })).toBe('error');
  });

  it('does not treat idle without a builtin turn-local outcome as success', () => {
    expect(decideBuiltinInjectedTurnResult({ idleCompleted: true })).toEqual({
      success: false,
      error: 'Injected turn finished without a recorded outcome',
      status: 503,
    });
  });

  it('blocks completed for builtin turn-local errors', () => {
    expect(decideBuiltinInjectedTurnResult({
      idleCompleted: true,
      outcome: {
        status: 'error',
        assistantMessagePresent: false,
        text: '',
        error: 'SDK result error',
      },
    })).toEqual({
      success: false,
      error: 'SDK result error',
      status: 503,
    });
  });

  it('accepts a successful builtin turn-local terminal outcome', () => {
    expect(decideBuiltinInjectedTurnResult({
      idleCompleted: true,
      outcome: {
        status: 'complete',
        assistantMessagePresent: true,
        text: 'done',
      },
    })).toEqual({
      success: true,
      assistantMessagePresent: true,
      text: 'done',
    });
  });

  it('does not treat external idle as success without the runtime success signal', () => {
    expect(decideExternalInjectedTurnResult({
      idleCompleted: true,
      turnSucceeded: false,
      text: 'stale answer',
    })).toEqual({
      success: false,
      error: 'External runtime turn failed',
      status: 503,
    });
  });

  it('times out both builtin and external injected turns before success gates', () => {
    expect(decideBuiltinInjectedTurnResult({ idleCompleted: false })).toEqual({
      success: false,
      error: 'Execution timed out',
      status: 408,
    });
    expect(decideExternalInjectedTurnResult({ idleCompleted: false })).toEqual({
      success: false,
      error: 'Execution timed out',
      status: 408,
    });
  });

  it('classifies short provider text concurrency errors returned as assistant content', () => {
    expect(classifyTransientProviderTextError(
      '[Error]: Concurrency limit exceeded for account, please retry later',
    )).toMatchObject({
      kind: 'concurrency_limit',
      userMessage: '上游模型服务达到账号并发限制，请稍后重试。',
    });
  });

  it('does not classify ordinary assistant prose that happens to mention rate limits', () => {
    expect(classifyTransientProviderTextError(
      'You can reduce rate limit pressure by batching requests and adding a queue.',
    )).toBeNull();
    expect(classifyTransientProviderTextError(
      'The phrase "rate limit exceeded" means the provider is throttling requests.',
    )).toBeNull();
    expect(classifyTransientProviderTextError(
      'If capacity is busy, tell the caller to retry later after the current deployment.',
    )).toBeNull();
  });

  it('schedules bounded retries only for success-shaped transient provider text errors', () => {
    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: Concurrency limit exceeded for account, please retry later',
      isError: false,
      apiErrorStatus: null,
      currentAttempt: 0,
      retryDelaysMs: [15, 30, 60],
    })).toEqual({
      retry: true,
      error: {
        kind: 'concurrency_limit',
        rawText: '[Error]: Concurrency limit exceeded for account, please retry later',
        userMessage: '上游模型服务达到账号并发限制，请稍后重试。',
      },
      attempt: 1,
      maxRetries: 3,
      delayMs: 15,
    });

    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: Concurrency limit exceeded for account, please retry later',
      isError: false,
      apiErrorStatus: null,
      currentAttempt: 3,
      retryDelaysMs: [15, 30, 60],
    })).toMatchObject({
      retry: false,
      exhausted: true,
      maxRetries: 3,
    });
  });

  it('leaves standard SDK error and HTTP status paths to existing handling', () => {
    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: Concurrency limit exceeded for account, please retry later',
      isError: true,
      apiErrorStatus: null,
      currentAttempt: 0,
    })).toEqual({
      retry: false,
      error: null,
      exhausted: false,
      maxRetries: 3,
    });

    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: rate_limit_exceeded',
      isError: false,
      apiErrorStatus: 429,
      currentAttempt: 0,
    })).toEqual({
      retry: false,
      error: null,
      exhausted: false,
      maxRetries: 3,
    });

    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: Concurrency limit exceeded for account, please retry later',
      isError: false,
      isAbortResult: true,
      apiErrorStatus: null,
      currentAttempt: 0,
    })).toEqual({
      retry: false,
      error: null,
      exhausted: false,
      maxRetries: 3,
    });
  });

  it('does not replay turns that already used tools', () => {
    expect(decideTransientProviderTextRetry({
      resultText: '[Error]: Concurrency limit exceeded for account, please retry later',
      isError: false,
      apiErrorStatus: null,
      toolUseCount: 1,
      currentAttempt: 0,
      retryDelaysMs: [15, 30, 60],
    })).toEqual({
      retry: false,
      error: {
        kind: 'concurrency_limit',
        rawText: '[Error]: Concurrency limit exceeded for account, please retry later',
        userMessage: '上游模型服务达到账号并发限制，请稍后重试。',
      },
      exhausted: false,
      maxRetries: 3,
    });
  });
});
