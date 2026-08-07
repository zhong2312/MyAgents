import { useTranslation } from 'react-i18next';

import type { TaskTriggerError } from '@/../shared/types/task';

export function TriggerErrorDetails({
  error,
  className = '',
}: {
  error: TaskTriggerError;
  className?: string;
}) {
  const { t, i18n } = useTranslation('task');
  const occurredAt = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(error.occurredAt);

  return (
    <div className={className}>
      <p className="font-medium">{error.message}</p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
        <dt className="text-[var(--ink-muted)]">{t('trigger.errorCode')}</dt>
        <dd className="break-all">{error.code}</dd>
        <dt className="text-[var(--ink-muted)]">{t('trigger.errorExitCode')}</dt>
        <dd>{error.exitCode ?? t('trigger.notAvailable')}</dd>
        <dt className="text-[var(--ink-muted)]">{t('trigger.errorSignal')}</dt>
        <dd>{error.signal ?? t('trigger.notAvailable')}</dd>
        <dt className="text-[var(--ink-muted)]">{t('trigger.errorTimedOut')}</dt>
        <dd>{error.timedOut ? t('trigger.yes') : t('trigger.no')}</dd>
        <dt className="text-[var(--ink-muted)]">{t('trigger.errorOccurredAt')}</dt>
        <dd>{occurredAt}</dd>
      </dl>
      {error.stderrTail && (
        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap">{error.stderrTail}</pre>
      )}
    </div>
  );
}

export default TriggerErrorDetails;
