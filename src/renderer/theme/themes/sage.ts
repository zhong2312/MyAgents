import stylesheetText from './sage.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const sageThemeManifest = {
  id: 'sage',
  displayName: 'Sage',
  description: 'Community sage green with natural paper surfaces',
  stylesheetText,
} satisfies PresetThemeManifest;
