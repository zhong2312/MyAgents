import stylesheetText from './default-black.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const defaultBlackThemeManifest = {
  id: 'default-black',
  displayName: 'Default Black',
  description: 'MyAgents Default with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
