import type { SlashCommand } from '../SlashCommandMenu';
import { USER_IMAGE_ATTACHMENT_MAX_BYTES } from '../../../shared/fileTypes';

export const BUILTIN_FALLBACK_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Compress chat history to free context space', source: 'builtin' },
  { name: 'context', description: 'Show or manage the current context', source: 'builtin' },
  { name: 'cost', description: 'View token usage and cost', source: 'builtin' },
  { name: 'init', description: 'Initialize project config (.CLAUDE.md)', source: 'builtin' },
  { name: 'pr-comments', description: 'Generate Pull Request comments', source: 'builtin' },
  { name: 'release-notes', description: 'Generate release notes from recent commits', source: 'builtin' },
  { name: 'review', description: 'Review code', source: 'builtin' },
  { name: 'security-review', description: 'Run a security-focused code review', source: 'builtin' },
];

export const LINE_HEIGHT = 26;
export const MAX_LINES = 9;
export const LAUNCHER_MIN_LINES = 3;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_SIZE = USER_IMAGE_ATTACHMENT_MAX_BYTES;
