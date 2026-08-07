import stylesheetText from './myagents-light.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const myAgentsLightThemeManifest = {
  id: 'myagents-light',
  displayName: 'MyAgents Light',
  description: 'Claude-inspired surfaces with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
