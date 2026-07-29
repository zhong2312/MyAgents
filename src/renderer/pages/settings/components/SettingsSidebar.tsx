import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsSection } from '../settingsSections';

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  setActiveSection: Dispatch<SetStateAction<SettingsSection>>;
  showDevTools?: boolean;
  floatingBallDevGate?: boolean;
  onShowLogs: () => void;
}

const NAV_ITEMS: Array<{ section: SettingsSection; labelKey: string }> = [
  { section: 'providers', labelKey: 'sidebar.nav.providers' },
  { section: 'general', labelKey: 'sidebar.nav.general' },
  { section: 'agent', labelKey: 'sidebar.nav.bots' },
  { section: 'desktop-pet', labelKey: 'sidebar.nav.floatingBall' },
  { section: 'usage-stats', labelKey: 'sidebar.nav.usageStats' },
  { section: 'proxy', labelKey: 'sidebar.nav.proxy' },
  { section: 'shortcuts', labelKey: 'sidebar.nav.shortcuts' },
  { section: 'about', labelKey: 'sidebar.nav.about' },
];

export function SettingsSidebar({
  activeSection,
  setActiveSection,
  showDevTools,
  floatingBallDevGate,
  onShowLogs,
}: SettingsSidebarProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="settings-sidebar w-52 shrink-0 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--ink)]">{t('sidebar.title')}</h1>
        {showDevTools && (
          <button
            onClick={onShowLogs}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title={t('sidebar.logsTitle')}
          >
            Logs
          </button>
        )}
      </div>

      <nav className="settings-nav space-y-1">
        {NAV_ITEMS.map((item) => {
          if (item.section === 'desktop-pet' && floatingBallDevGate === false) return null;
          const isActive = item.section === activeSection;
          return (
            <button
              key={item.section}
              onClick={() => setActiveSection(item.section)}
              className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${
                isActive
                  ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
              }`}
            >
              {t(item.labelKey)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
