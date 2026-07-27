import { useTranslation } from 'react-i18next';

import type { SpaceEnvironment } from '@/../shared/config-types';

interface SpaceEnvironmentSwitchProps {
  activeEnvironment: SpaceEnvironment;
  origin: string;
  onChange: (environment: SpaceEnvironment) => void;
}

export function SpaceEnvironmentSwitch({
  activeEnvironment,
  origin,
  onChange,
}: SpaceEnvironmentSwitchProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 pr-4">
          <h3 className="text-sm font-medium text-[var(--ink)]">
            {t('about.developer.spaceEnvironmentTitle')}
          </h3>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {t('about.developer.spaceEnvironmentDescription', { origin })}
          </p>
        </div>
        <div className="flex shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] p-0.5">
          {(['production', 'dev'] as const).map((environment) => {
            const selected = activeEnvironment === environment;
            return (
              <button
                key={environment}
                type="button"
                onClick={() => onChange(environment)}
                aria-pressed={selected}
                className={`min-w-[96px] rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${selected
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                  }`}
              >
                {t(`about.developer.spaceEnvironment.${environment}`)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
