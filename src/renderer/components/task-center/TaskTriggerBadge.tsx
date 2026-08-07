import { RadioTower } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function TaskTriggerBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('task');
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] font-medium text-[var(--ink-muted)] ${
        compact ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-xs'
      }`}
      title={t('trigger.badgeTitle')}
    >
      <RadioTower className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {t('trigger.badge')}
    </span>
  );
}

export default TaskTriggerBadge;
