import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Play, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { taskTriggerTestSpec } from '@/api/taskCenter';
import type {
  TaskTrigger,
  TaskTriggerRuntimeState,
  TaskTriggerTestResponse,
} from '@/../shared/types/task';
import { INPUT_CLS, PillButton } from './controls';
import { TriggerErrorDetails } from '../TriggerErrorDetails';

const ALWAYS_TRIGGER: TaskTrigger = {
  source: { type: 'time' },
  detector: { type: 'always' },
};

interface Props {
  value?: TaskTrigger;
  workspacePath: string;
  ownerTaskId?: string;
  checkpointState?: Pick<
    TaskTriggerRuntimeState,
    'checkpoint' | 'checkpointRevision' | 'checkpointUpdatedAt'
  >;
  disabled?: boolean;
  onChange: (trigger: TaskTrigger) => void;
  onValidityChange?: (valid: boolean) => void;
}

function commandValue(value: TaskTrigger | undefined) {
  return value?.detector.type === 'command' ? value.detector : null;
}

export function TriggerEditor({
  value,
  workspacePath,
  ownerTaskId,
  checkpointState,
  disabled,
  onChange,
  onValidityChange,
}: Props) {
  const { t } = useTranslation('task');
  const command = commandValue(value);
  const [argsText, setArgsText] = useState(() => JSON.stringify(command?.command.args ?? [], null, 2));
  const [argsError, setArgsError] = useState<string | null>(null);
  const [testingRequest, setTestingRequest] = useState<{ key: string; seq: number } | null>(null);
  const [testRecord, setTestRecord] = useState<{
    key: string;
    result: TaskTriggerTestResponse;
  } | null>(null);
  const requestSeq = useRef(0);
  const draftKey = JSON.stringify({ value, workspacePath, checkpointState, argsText, argsError });
  const observedDraftKey = useRef(draftKey);
  if (observedDraftKey.current !== draftKey) {
    observedDraftKey.current = draftKey;
    requestSeq.current += 1;
  }
  const testing = testingRequest?.key === draftKey;
  const testResult = testRecord?.key === draftKey ? testRecord.result : null;

  useEffect(() => () => {
    requestSeq.current += 1;
  }, []);

  useEffect(() => {
    setArgsText(JSON.stringify(command?.command.args ?? [], null, 2));
    setArgsError(null);
  }, [command?.command.args]);

  const validationError = useMemo(() => {
    if (!command) return null;
    if (!command.command.executable.trim()) return t('trigger.validation.executableRequired');
    if (argsError) return argsError;
    const timeout = command.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
      return t('trigger.validation.timeoutRange');
    }
    return null;
  }, [argsError, command, t]);

  useEffect(() => {
    onValidityChange?.(!validationError);
  }, [onValidityChange, validationError]);

  const switchType = (type: 'always' | 'command') => {
    setTestRecord(null);
    if (type === 'always') {
      onChange(ALWAYS_TRIGGER);
      return;
    }
    onChange({
      source: { type: 'time' },
      detector: {
        type: 'command',
        command: { executable: '', args: [] },
        timeoutMs: 30_000,
      },
    });
  };

  const updateCommand = (patch: Partial<NonNullable<typeof command>['command']>) => {
    if (!command) return;
    onChange({
      source: { type: 'time' },
      detector: {
        ...command,
        command: { ...command.command, ...patch },
      },
    });
    setTestRecord(null);
  };

  const handleArgs = (next: string) => {
    setArgsText(next);
    setTestRecord(null);
    try {
      const parsed: unknown = JSON.parse(next);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        setArgsError(t('trigger.validation.argsArray'));
        return;
      }
      setArgsError(null);
      updateCommand({ args: parsed });
    } catch {
      setArgsError(t('trigger.validation.argsJson'));
    }
  };

  const handleTest = async () => {
    if (!value || value.detector.type !== 'command' || validationError || testing) return;
    const seq = ++requestSeq.current;
    const key = draftKey;
    setTestingRequest({ key, seq });
    setTestRecord(null);
    try {
      const result = await taskTriggerTestSpec(value, workspacePath, checkpointState, ownerTaskId);
      if (requestSeq.current === seq) setTestRecord({ key, result });
    } catch (error) {
      if (requestSeq.current === seq) {
        setTestRecord({
          key,
          result: {
            ok: false,
            failure: {
              error: {
                code: 'test_request_failed',
                message: error instanceof Error ? error.message : String(error),
                occurredAt: Date.now(),
              },
              durationMs: 0,
            },
          },
        });
      }
    } finally {
      if (requestSeq.current === seq) setTestingRequest(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="trigger-editor">
      <div className="flex gap-2">
        <PillButton
          selected={!command}
          onClick={() => switchType('always')}
          disabled={disabled}
        >
          {t('trigger.always')}
        </PillButton>
        <PillButton
          selected={!!command}
          onClick={() => switchType('command')}
          disabled={disabled}
        >
          {t('trigger.command')}
        </PillButton>
      </div>
      <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
        {command ? t('trigger.commandDescription') : t('trigger.alwaysDescription')}
      </p>

      {command && (
        <div className="space-y-4 border-t border-[var(--line-subtle)] pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('trigger.executable')}
              </span>
              <input
                value={command.command.executable}
                onChange={(event) => updateCommand({ executable: event.target.value })}
                disabled={disabled}
                placeholder={t('trigger.executablePlaceholder')}
                className={`${INPUT_CLS} font-mono`}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('trigger.timeout')}
              </span>
              <input
                type="number"
                min={1_000}
                max={300_000}
                step={1_000}
                value={command.timeoutMs ?? 30_000}
                onChange={(event) => onChange({
                  source: { type: 'time' },
                  detector: { ...command, timeoutMs: Number(event.target.value) },
                })}
                disabled={disabled}
                className={`${INPUT_CLS} font-mono`}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
              {t('trigger.args')}
            </span>
            <textarea
              value={argsText}
              onChange={(event) => handleArgs(event.target.value)}
              disabled={disabled}
              rows={4}
              spellCheck={false}
              className={`${INPUT_CLS} resize-y font-mono`}
            />
            <span className="mt-1.5 block text-xs text-[var(--ink-muted)]">
              {t('trigger.argsHint')}
            </span>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
              {t('trigger.cwd')}
            </span>
            <input
              value={command.command.cwd ?? ''}
              onChange={(event) => updateCommand({ cwd: event.target.value || undefined })}
              disabled={disabled}
              placeholder={workspacePath || t('trigger.cwdPlaceholder')}
              className={`${INPUT_CLS} font-mono`}
            />
          </label>

          {validationError && (
            <p className="text-sm text-[var(--danger)]" role="alert">{validationError}</p>
          )}

          <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 gap-2.5">
                <Activity className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                <div>
                  <p className="text-sm font-medium text-[var(--ink-secondary)]">
                    {t('trigger.testTitle')}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                    {t('trigger.testWarning')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={disabled || testing || !!validationError || !workspacePath}
                className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--paper-elevated)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testing ? <Activity className="h-3.5 w-3.5 animate-pulse" /> : <Play className="h-3.5 w-3.5" />}
                {testing ? t('trigger.testing') : t('trigger.test')}
              </button>
            </div>
            {testResult && (
              <div
                className={`mt-3 border-t border-[var(--line-subtle)] pt-3 text-sm ${
                  testResult.ok ? 'text-[var(--ink-secondary)]' : 'text-[var(--danger)]'
                }`}
                data-testid="trigger-test-result"
              >
                <div className="flex items-start gap-2">
                  <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {testResult.ok ? (
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">
                        {t(`trigger.decision.${testResult.result.decision}`)} · {testResult.result.reason.message}
                      </p>
                      {testResult.result.handoff?.summary && <p>{testResult.result.handoff.summary}</p>}
                      <p className="font-mono text-xs text-[var(--ink-muted)]">
                        {t('trigger.testMeta', {
                          duration: testResult.result.durationMs,
                          exitCode: testResult.result.exitCode,
                        })}
                      </p>
                      {testResult.result.stderrTail && (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[var(--ink-muted)]">
                          {testResult.result.stderrTail}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <div className="min-w-0 space-y-1">
                      <TriggerErrorDetails error={testResult.failure.error} />
                      {testResult.failure.stdout && (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs">
                          {testResult.failure.stdout}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TriggerEditor;
