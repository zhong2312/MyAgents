import type { Tab } from '@/types/tab';

type Translate = (key: string) => string;

export function getFixedTabChromeTitle(
  view: Tab['view'],
  t: Translate,
): string | undefined {
  switch (view) {
    case 'settings':
      return t('tabs.settings');
    case 'capabilities':
      return t('tabs.capabilities');
    case 'taskcenter':
      return t('tabs.taskCenter');
    case 'space':
      return t('tabs.team');
    case 'launcher':
      return t('tabs.launcher');
    default:
      return undefined;
  }
}
