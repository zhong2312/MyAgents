import stylesheetText from './absolutely.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const absolutelyThemeManifest = {
  id: 'absolutely',
  displayName: 'Claude',
  description: 'Claude-inspired terracotta with soft neutral surfaces',
  stylesheetText,
} satisfies PresetThemeManifest;
