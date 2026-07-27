import stylesheetText from './proof.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const proofThemeManifest = {
  id: 'proof',
  displayName: 'Proof',
  description: 'Codex-inspired forest green and editorial paper',
  stylesheetText,
} satisfies PresetThemeManifest;
