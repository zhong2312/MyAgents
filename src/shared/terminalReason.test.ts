import { describe, expect, it } from 'vitest';

import {
  describeTerminalReason,
  isAbortedTerminalReason,
  shouldOfferTerminalReasonDiagnostics,
  shouldRecordTurnForTitle,
  shouldTitleCompletedTurn,
  shouldSurfaceTerminalReason,
} from './terminalReason';

describe('describeTerminalReason — banner suppression', () => {
  it('returns null for non-disruptive reasons (completed + any aborted_*)', () => {
    expect(describeTerminalReason('completed')).toBeNull();
    expect(describeTerminalReason('aborted_streaming')).toBeNull();
    expect(describeTerminalReason('aborted_tools')).toBeNull();
    // Prefix match by design — a future aborted_* value is auto-suppressed.
    expect(describeTerminalReason('aborted_init')).toBeNull();
  });

  it('returns null for missing / non-string input (no crash, no banner)', () => {
    expect(describeTerminalReason(undefined)).toBeNull();
    expect(describeTerminalReason(null)).toBeNull();
    expect(describeTerminalReason('')).toBeNull();
    expect(describeTerminalReason(42)).toBeNull();
  });
});

describe('describeTerminalReason — known reasons map to severity', () => {
  it('maps known error reasons with severity "error"', () => {
    expect(describeTerminalReason('prompt_too_long')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('blocking_limit')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('rapid_refill_breaker')).toMatchObject({
      severity: 'error',
      label: '上下文反复填满，本轮已停止',
    });
    expect(describeTerminalReason('stop_hook_prevented')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('api_error')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('malformed_tool_use_exhausted')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('structured_output_retry_exhausted')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('tool_deferred_unavailable')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('turn_setup_failed')).toMatchObject({ severity: 'error' });
  });

  it('maps notice-level reasons with severity "notice"', () => {
    expect(describeTerminalReason('max_turns')).toMatchObject({ severity: 'notice' });
    expect(describeTerminalReason('budget_exhausted')).toMatchObject({ severity: 'notice' });
  });

  it('maps background handoff as an informational reason', () => {
    expect(describeTerminalReason('background_requested')).toMatchObject({ severity: 'info' });
  });

  it('gives every known reason a non-empty label + detail', () => {
    const info = describeTerminalReason('model_error');
    expect(info?.label).toBeTruthy();
    expect(info?.detail).toBeTruthy();
  });
});

describe('describeTerminalReason — unknown values degrade gracefully', () => {
  it('returns a notice placeholder embedding the raw value (no exhaustive-switch crash)', () => {
    const info = describeTerminalReason('some_future_reason');
    expect(info).not.toBeNull();
    expect(info?.severity).toBe('notice');
    expect(info?.label).toContain('some_future_reason');
  });
});

describe('shouldSurfaceTerminalReason', () => {
  it('is the inverse of "describe returned null"', () => {
    expect(shouldSurfaceTerminalReason('completed')).toBe(false);
    expect(shouldSurfaceTerminalReason('aborted_streaming')).toBe(false);
    expect(shouldSurfaceTerminalReason(undefined)).toBe(false);
    expect(shouldSurfaceTerminalReason('prompt_too_long')).toBe(true);
    expect(shouldSurfaceTerminalReason('some_future_reason')).toBe(true);
  });
});

describe('shouldOfferTerminalReasonDiagnostics', () => {
  it('offers helper diagnostics for terminal error reasons', () => {
    expect(shouldOfferTerminalReasonDiagnostics('prompt_too_long')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('blocking_limit')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('rapid_refill_breaker')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('stop_hook_prevented')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('hook_stopped')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('image_error')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('model_error')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('api_error')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('malformed_tool_use_exhausted')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('structured_output_retry_exhausted')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('tool_deferred_unavailable')).toBe(true);
    expect(shouldOfferTerminalReasonDiagnostics('turn_setup_failed')).toBe(true);
  });

  it('does not offer diagnostics for normal or self-recovering reasons', () => {
    expect(shouldOfferTerminalReasonDiagnostics('completed')).toBe(false);
    expect(shouldOfferTerminalReasonDiagnostics('aborted_streaming')).toBe(false);
    expect(shouldOfferTerminalReasonDiagnostics('max_turns')).toBe(false);
    expect(shouldOfferTerminalReasonDiagnostics('tool_deferred')).toBe(false);
    expect(shouldOfferTerminalReasonDiagnostics('background_requested')).toBe(false);
    expect(shouldOfferTerminalReasonDiagnostics('budget_exhausted')).toBe(false);
  });

  it('offers diagnostics for unknown future reasons', () => {
    expect(shouldOfferTerminalReasonDiagnostics('some_future_reason')).toBe(true);
  });
});

describe('isAbortedTerminalReason — #307 abort detection', () => {
  it('returns true ONLY for aborted_* reasons (incl. future ones)', () => {
    expect(isAbortedTerminalReason('aborted_streaming')).toBe(true);
    expect(isAbortedTerminalReason('aborted_tools')).toBe(true);
    expect(isAbortedTerminalReason('aborted_init')).toBe(true); // future-proof prefix match
  });

  it('returns FALSE for missing / non-string input — the #307 trap', () => {
    // This is why shouldSurfaceTerminalReason() CANNOT be reused as an abort
    // predicate: it returns false for missing reasons too, which would wrongly
    // suppress legitimate non-abort errors (third-party 4xx/5xx) that carry no
    // terminal_reason. isAbortedTerminalReason must NOT classify "missing" as abort.
    expect(isAbortedTerminalReason(undefined)).toBe(false);
    expect(isAbortedTerminalReason(null)).toBe(false);
    expect(isAbortedTerminalReason('')).toBe(false);
    expect(isAbortedTerminalReason(42)).toBe(false);
    expect(isAbortedTerminalReason({})).toBe(false);
  });

  it('returns false for completed and every non-abort reason', () => {
    expect(isAbortedTerminalReason('completed')).toBe(false);
    expect(isAbortedTerminalReason('prompt_too_long')).toBe(false);
    expect(isAbortedTerminalReason('blocking_limit')).toBe(false);
    expect(isAbortedTerminalReason('model_error')).toBe(false);
    expect(isAbortedTerminalReason('max_turns')).toBe(false);
    expect(isAbortedTerminalReason('some_future_reason')).toBe(false);
    expect(isAbortedTerminalReason('api_error')).toBe(false);
    expect(isAbortedTerminalReason('budget_exhausted')).toBe(false);
  });
});

describe('shouldRecordTurnForTitle — #245 round-acceptance gate', () => {
  it('accepts completed (the only "good" SDK terminal_reason)', () => {
    expect(shouldRecordTurnForTitle('completed')).toBe(true);
  });

  it('accepts undefined / null / empty (external runtimes do not emit terminal_reason)', () => {
    expect(shouldRecordTurnForTitle(undefined)).toBe(true);
    expect(shouldRecordTurnForTitle(null)).toBe(true);
    expect(shouldRecordTurnForTitle('')).toBe(true);
  });

  it('rejects the #245 culprit: aborted_streaming (SDK abort after upstream 4xx, partial assistant content is the error string)', () => {
    expect(shouldRecordTurnForTitle('aborted_streaming')).toBe(false);
    expect(shouldRecordTurnForTitle('aborted_tools')).toBe(false);
    // Future aborted_* values also rejected — partial content is partial content.
    expect(shouldRecordTurnForTitle('aborted_init')).toBe(false);
  });

  it('rejects upstream-error and limit reasons (content is degenerate or absent)', () => {
    expect(shouldRecordTurnForTitle('prompt_too_long')).toBe(false);
    expect(shouldRecordTurnForTitle('blocking_limit')).toBe(false);
    expect(shouldRecordTurnForTitle('rapid_refill_breaker')).toBe(false);
    expect(shouldRecordTurnForTitle('stop_hook_prevented')).toBe(false);
    expect(shouldRecordTurnForTitle('hook_stopped')).toBe(false);
    expect(shouldRecordTurnForTitle('image_error')).toBe(false);
    expect(shouldRecordTurnForTitle('model_error')).toBe(false);
    expect(shouldRecordTurnForTitle('api_error')).toBe(false);
    expect(shouldRecordTurnForTitle('malformed_tool_use_exhausted')).toBe(false);
    expect(shouldRecordTurnForTitle('budget_exhausted')).toBe(false);
    expect(shouldRecordTurnForTitle('structured_output_retry_exhausted')).toBe(false);
    expect(shouldRecordTurnForTitle('tool_deferred_unavailable')).toBe(false);
    expect(shouldRecordTurnForTitle('turn_setup_failed')).toBe(false);
  });

  it('rejects max_turns and tool_deferred (text may be truncated mid-thought; conservative)', () => {
    expect(shouldRecordTurnForTitle('max_turns')).toBe(false);
    expect(shouldRecordTurnForTitle('tool_deferred')).toBe(false);
  });

  it('rejects unknown / future reasons (default-deny — never widen on unrecognized values)', () => {
    expect(shouldRecordTurnForTitle('some_future_reason')).toBe(false);
  });

  it('treats non-string types like "field missing" → accept (degrade gracefully, do not silently kill title-gen)', () => {
    // Same shape as undefined/null/'': callers should not be silently locked out
    // of title-gen by an encoding bug somewhere upstream that turns terminal_reason
    // into a non-string value. The renderer's title-gen is non-critical (frontend
    // falls back to truncated first message) — over-rejection is worse than the
    // occasional bad title.
    expect(shouldRecordTurnForTitle(42)).toBe(true);
    expect(shouldRecordTurnForTitle({})).toBe(true);
    expect(shouldRecordTurnForTitle(false)).toBe(true);
  });
});

describe('shouldTitleCompletedTurn — builtin #296 auto-title success gate', () => {
  it('titles a clean successful turn', () => {
    expect(shouldTitleCompletedTurn(false, 'completed')).toBe(true);
    // external runtimes / SDK paths that omit terminal_reason are still titleable
    expect(shouldTitleCompletedTurn(false, undefined)).toBe(true);
    expect(shouldTitleCompletedTurn(false, '')).toBe(true);
  });

  it('does NOT title an is_error turn even if the terminal_reason looks completed (#245 family)', () => {
    // The builtin result branch is reached by is_error results carrying visible
    // assistant text; those must never seed a title.
    expect(shouldTitleCompletedTurn(true, 'completed')).toBe(false);
    expect(shouldTitleCompletedTurn(true, undefined)).toBe(false);
  });

  it('does NOT title aborted / truncated / errored terminal reasons', () => {
    for (const reason of ['aborted_streaming', 'aborted_tools', 'max_turns', 'model_error', 'prompt_too_long']) {
      expect(shouldTitleCompletedTurn(false, reason)).toBe(false);
    }
  });
});
