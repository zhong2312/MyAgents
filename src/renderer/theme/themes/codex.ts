import stylesheetText from './codex.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const codexThemeManifest = {
  id: 'codex',
  displayName: 'Codex',
  description: 'Codex-inspired standard blue and crisp neutral hierarchy',
  stylesheetText,
} satisfies PresetThemeManifest;
