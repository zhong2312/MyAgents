/**
 * Path detection utility for inline code in AI output.
 *
 * Determines if a text string looks like a file or directory path,
 * so that only plausible candidates are sent to the backend for existence checks.
 */
import { AUDIO_EXTENSIONS } from '@/utils/audioPlayer';

export type InlineCodeTarget =
  | { kind: 'web'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'plain' };

/**
 * Common file extensions that strongly indicate a file path.
 *
 * NOTE: This set is for path detection only, not for preview eligibility.
 * - PATH_EXTENSIONS: used for "does this look like a path?" heuristic (includes images, locks, etc.)
 * - isPreviewable() in shared/fileTypes.ts: uses a binary-blocklist strategy for preview eligibility
 */
const PATH_EXTENSIONS = new Set([
  // Web / JS / TS
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
  // Config
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml',
  // Docs
  'md', 'mdx', 'txt', 'rst', 'csv', 'log',
  // Systems
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'kt', 'sh', 'bash', 'zsh',
  // Build / package
  'lock', 'sum', 'mod',
  // Images (still paths even though they're binary)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  // Audio (imported from audioPlayer to avoid duplication)
  ...AUDIO_EXTENSIONS,
]);

/** Well-known dotfiles that are valid paths but lack a "normal" extension */
const KNOWN_DOTFILES = new Set([
  '.gitignore', '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc',
  '.npmrc', '.nvmrc', '.env', '.env.local', '.env.development', '.env.production',
  '.babelrc', '.prettierignore', '.eslintignore',
]);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Quick, synchronous check: does `text` look like it could be a file or directory path?
 *
 * Returns `true` for plausible path candidates, `false` for obvious non-paths.
 * False positives are OK — the backend will verify existence.
 * False negatives should be minimised — we don't want to miss real paths.
 */
export function looksLikeFilePath(text: string): boolean {
  const path = text.trim();

  // Too short to be a path (e.g., "a", "go")
  if (path.length < 2) return false;

  // Too long to be a realistic path
  if (path.length > 300) return false;

  // Control characters cannot belong to an inline path target. Spaces and
  // Unicode are intentionally allowed — the backend existence check, not this
  // heuristic, is the final authority (e.g. `docs/Product Guide.md`).
  if (hasControlCharacter(path)) return false;

  // file:// is a local-file boundary handled by workspaceFileLinks. All other
  // schemes are not filesystem paths; HTTP(S) is classified before this helper.
  if (/^file:\/\//i.test(path)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return false;

  // Contains code-like characters that disqualify it as a path
  // () {} [] ; => are used in code expressions, not paths
  if (/[(){}[\];=>]/.test(path)) return false;

  // Contains template literal / interpolation syntax
  if (path.includes('${') || path.includes('`')) return false;

  // Known dotfiles (exact match)
  if (KNOWN_DOTFILES.has(path)) return true;

  // Starts with ./ or ../ — very strong path signal
  if (path.startsWith('./') || path.startsWith('../')) return true;

  // Contains path separator — strong signal, but filter out common non-path patterns
  // like "true/false", "yes/no", "input/output"
  if (path.includes('/') || path.includes('\\')) {
    const segments = path.split(/[/\\]/).filter(Boolean);
    // Single segment with separator (e.g., trailing slash) — still plausible
    if (segments.length < 2) return true;
    // At least one segment should contain a dot (extension / dotfile) OR
    // the total path should be long enough to be a real path (> 5 chars)
    const hasDot = segments.some(s => s.includes('.'));
    if (hasDot || path.length > 5) return true;
    return false;
  }

  // Any syntactically plausible file suffix is a candidate. The historical
  // allowlist remains a strong signal/documentation aid, but it must not hide a
  // real PDF/DOCX/custom-extension file from the authoritative existence check.
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < path.length - 1) {
    const ext = path.slice(dotIndex + 1).toLowerCase();
    if (PATH_EXTENSIONS.has(ext) || /^[\p{L}\p{N}_+-]{1,32}$/u.test(ext)) return true;
  }

  // Single word without extension or separator — not a path
  return false;
}

/**
 * Classify inferred inline-code targets before any action is attached.
 *
 * Explicit Markdown links already carry author intent. Backtick content does
 * not, so it is promoted only when it is a syntactically valid HTTP(S) URL or
 * a plausible file candidate whose existence will subsequently be checked by
 * FileActionContext.
 */
export function classifyInlineCodeTarget(text: string): InlineCodeTarget {
  const value = text.trim();
  if (!value) return { kind: 'plain' };

  if (!hasControlCharacter(value) && !/%(?![\da-f]{2})/i.test(value)) {
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
        return { kind: 'web', url: value };
      }
    } catch {
      // Fall through to file/plain classification.
    }
  }

  return looksLikeFilePath(value)
    ? { kind: 'file', path: value }
    : { kind: 'plain' };
}

/**
 * Shorten a path for display purposes only.
 * Replaces common macOS / Windows user profile prefixes with `~/`.
 *
 * This is purely cosmetic — never use the returned value for file operations.
 */
export function shortenPathForDisplay(path: string): string {
  if (!path) return path;
  // macOS: /Users/<username>/... → ~/...
  const normalized = path.replace(/\\/g, '/');
  const macMatch = normalized.match(/^\/Users\/[^/]+\/(.*)/);
  if (macMatch) return `~/${macMatch[1]}`;
  // Windows: C:\Users\<username>\... / C:/Users/<username>/... → ~/...
  const windowsMatch = normalized.match(/^[A-Za-z]:\/Users\/[^/]+\/(.*)/);
  if (windowsMatch) return `~/${windowsMatch[1]}`;
  return path;
}
