import { useTranslation } from 'react-i18next';

import type { AppearanceMode } from '@/theme';

interface AppearanceModeControlProps {
  value: AppearanceMode;
  onChange: (mode: AppearanceMode) => void;
}

export function AppearanceModeControl({ value, onChange }: AppearanceModeControlProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      <div className="flex-1 pr-4">
        <p className="text-sm font-medium text-[var(--ink)]">{t('general.appearanceModeTitle')}</p>
        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('general.appearanceModeDescription')}</p>
      </div>
      <div className="flex shrink-0 gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
        {(['system', 'light', 'dark'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
              value === mode
                ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
            }`}
          >
            {t(`general.appearanceMode.${mode}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
