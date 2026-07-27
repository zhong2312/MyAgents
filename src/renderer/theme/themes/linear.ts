import stylesheetText from './linear.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const linearThemeManifest = {
  id: 'linear',
  displayName: 'Linear',
  description: 'Codex-inspired indigo with cool white compact layers',
  stylesheetText,
} satisfies PresetThemeManifest;
