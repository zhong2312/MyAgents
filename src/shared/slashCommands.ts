// Slash Commands Service
// Provides slash command discovery and management for the chat input
// Supports builtin commands, custom commands (.claude/commands/), and skills (.claude/skills/, ~/.myagents/skills/)

import { load as yamlLoad } from 'js-yaml';

export interface SlashCommand {
    name: string;           // Human-readable menu label
    invocationName?: string; // Stable slash token; falls back to name for legacy/builtin entries
    description: string;    // Human readable description
    source: 'builtin' | 'client' | 'custom' | 'skill' | 'sdk';  // Source type: runtime builtin, renderer action, custom command, local skill, or SDK-provided command
    scope?: 'user' | 'project';  // Where the item is defined
    path?: string;          // File path for custom commands or skills
    folderName?: string;    // Folder name for skills (may differ from display name after rename)
    fileName?: string;      // File name without .md for custom commands (may differ from display name when frontmatter overrides)
    argumentHint?: string;  // SDK-provided argument hint, when available
    aliases?: string[];     // SDK-provided aliases, when available
}

/**
 * Skill frontmatter projection used by the editor. Standard fields remain
 * round-trippable; `author` is a normalized compatibility view; the remaining
 * advanced fields are MyAgents/Claude extensions.
 */
export interface SkillFrontmatter {
    name: string;
    description: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    /**
     * Normalized UI/API projection. Readers accept legacy top-level `author`
     * and standard `metadata.author`; serializers always write the standard
     * nested form.
     */
    author?: string;
    // Advanced options
    'disable-model-invocation'?: boolean;
    'user-invocable'?: boolean;
    'allowed-tools'?: string;
    context?: 'fork' | string;
    agent?: 'Explore' | 'Plan' | 'general-purpose' | string;
    'argument-hint'?: string;
}

/**
 * Complete Command frontmatter interface
 */
export interface CommandFrontmatter {
    name?: string;
    description: string;
    author?: string;
}

// Built-in Claude Agent SDK slash commands with descriptions.
// These are *text-insertion* builtins (selecting one inserts `/name ` and sends
// it to the builtin SDK). UI-action commands that change product state instead
// of sending text (e.g. `goal`) are NOT listed here — they are renderer-only
// and defined in `src/renderer/utils/slashActions.ts` (their names are reserved there).
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
    { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
    { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
    { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
    { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
    { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
    { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
    { name: 'review', description: '对代码进行审查', source: 'builtin' },
    { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
];

const SLASH_COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}:_-]{0,127}$/u;
const RESERVED_PRODUCT_COMMAND_NAMES = new Set([
    ...BUILTIN_SLASH_COMMANDS.map(command => command.name),
    // Renderer client action plus its public alias. Their behavior remains in
    // slashActions.ts; the shared capability contract only reserves names.
    'goal',
    'loop',
]);

export function isValidSlashCommandName(name: string): boolean {
    return SLASH_COMMAND_NAME_RE.test(name);
}

/**
 * Command invocation identity comes from its lexical path below the Command
 * root. Frontmatter `name` is display metadata and must not rename the slash
 * token. Nested project paths use Claude's colon namespace convention.
 */
export function slashCommandNameFromSourceLocalId(sourceLocalId: string): string | null {
    const name = sourceLocalId.replaceAll('\\', '/').split('/').join(':');
    return isValidSlashCommandName(name) ? name : null;
}

export function isReservedSlashCommandName(name: string): boolean {
    return RESERVED_PRODUCT_COMMAND_NAMES.has(name);
}

/**
 * Extract YAML frontmatter string from markdown content
 */
function extractFrontmatter(content: string): { frontmatterStr: string; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    return {
        frontmatterStr: match[1],
        body: match[2] || ''
    };
}

type LooseScalarParse =
    | { ok: true; value: string | boolean }
    | { ok: false };

function parseLooseScalarValue(rawValue: string): LooseScalarParse {
    const value = rawValue.trim();
    if (!value || value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
        return { ok: false };
    }
    if (value.startsWith('[') || value.startsWith('{')) {
        return { ok: false };
    }
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        if (!value.endsWith(quote)) return { ok: false };
        const inner = value.slice(1, -1);
        return {
            ok: true,
            value: quote === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
        };
    }
    return { ok: true, value };
}

function parseLooseFrontmatterScalars(frontmatterStr: string): Record<string, unknown> | null {
    const result: Record<string, unknown> = {};
    let metadata: Record<string, unknown> | null = null;
    let recoveredScalarCount = 0;

    for (const line of frontmatterStr.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith('#')) continue;

        const topLevelMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
        if (topLevelMatch) {
            const [, key, rawValue = ''] = topLevelMatch;
            if (key === 'metadata' && rawValue.trim() === '') {
                metadata = {};
                result.metadata = metadata;
                continue;
            }
            if (key === 'metadata') return null;
            metadata = null;
            const parsed = parseLooseScalarValue(rawValue);
            if (!parsed.ok) return null;
            result[key] = parsed.value;
            recoveredScalarCount += 1;
            continue;
        }

        if (metadata) {
            const nestedMatch = /^\s+([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
            if (!nestedMatch) return null;
            const [, key, rawValue = ''] = nestedMatch;
            const parsed = parseLooseScalarValue(rawValue);
            if (!parsed.ok) return null;
            metadata[key] = parsed.value;
            recoveredScalarCount += 1;
            continue;
        }

        return null;
    }

    return recoveredScalarCount > 0 ? result : null;
}

function loadFrontmatterObject(frontmatterStr: string, warnLabel: string): Record<string, unknown> | null {
    try {
        const parsed = yamlLoad(frontmatterStr) as Record<string, unknown> | null;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        const loose = parseLooseFrontmatterScalars(frontmatterStr);
        if (loose) return loose;
        console.warn(warnLabel, error);
        return null;
    }
}

/**
 * Extract author from parsed YAML object
 * Standard `metadata.author` wins when both forms exist. Top-level
 * `author`/`Author` remains a read-only compatibility fallback.
 */
function extractAuthor(parsed: Record<string, unknown>): string | undefined {
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === 'object') {
        if (typeof metadata.author === 'string') return metadata.author;
        if (typeof metadata.Author === 'string') return metadata.Author;
    }

    if (typeof parsed.author === 'string') return parsed.author;
    if (typeof parsed.Author === 'string') return parsed.Author;

    return undefined;
}

/**
 * Preserve standard Skill metadata through the detail editor. The official
 * schema requires string values; scalar legacy values are normalized to
 * strings on the next save instead of being silently dropped.
 */
function extractSkillMetadata(parsed: Record<string, unknown>): Record<string, string> | undefined {
    const value = parsed.metadata;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const metadata = Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => ['string', 'number', 'boolean'].includes(typeof entry))
            .map(([key, entry]) => [key, String(entry)]),
    );
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Parse YAML frontmatter from a markdown file to extract description and author
 * For custom commands (.claude/commands/*.md)
 * Author can be at top-level (author/Author) or nested (metadata.author/Author)
 * Format:
 * ---
 * description: Some description here
 * author: author-name
 * ---
 */
export function parseYamlFrontmatter(content: string): { description?: string; author?: string } {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return {};
        }
        const parsed = loadFrontmatterObject(extracted.frontmatterStr, 'Failed to parse YAML frontmatter:');
        if (!parsed) {
            return {};
        }
        return {
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            author: extractAuthor(parsed)
        };
    } catch (e) {
        console.warn('Failed to parse YAML frontmatter:', e);
        return {};
    }
}

/**
 * Parse YAML frontmatter from a SKILL.md file to extract name, description and author
 * Skills use 'name' and 'description' fields in frontmatter
 * Author can be at top-level (author/Author) or nested (metadata.author/Author)
 * Format:
 * ---
 * name: skill-name
 * description: "What this skill does and when to use it"
 * author: author-name
 * ---
 * or:
 * ---
 * name: skill-name
 * metadata:
 *   author: author-name
 * ---
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string; author?: string } {
    try {
        const extracted = extractFrontmatter(content);
        let name: string | undefined;
        let description: string | undefined;
        let author: string | undefined;

        if (extracted) {
            const parsed = loadFrontmatterObject(extracted.frontmatterStr, 'Failed to parse skill frontmatter:');
            if (parsed) {
                name = typeof parsed.name === 'string' ? parsed.name : undefined;
                description = typeof parsed.description === 'string' ? parsed.description : undefined;
                author = extractAuthor(parsed);
            }
        }

        // If name is not in frontmatter, try to extract from first # heading in body
        if (!name) {
            const bodyContent = extracted?.body || content;
            const headingMatch = bodyContent.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                name = headingMatch[1].trim();
            }
        }

        return { name, description, author };
    } catch (e) {
        console.warn('Failed to parse skill frontmatter:', e);
        return {};
    }
}

/**
 * Extract command name from file path
 * e.g., "/path/to/review-code.md" -> "review-code"
 * Supports both / and \ path separators for cross-platform compatibility
 */
export function extractCommandName(filePath: string): string {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    return fileName.replace(/\.md$/, '');
}

/**
 * Parse complete SKILL.md frontmatter with all fields
 * Returns both frontmatter and markdown body content
 */
export function parseFullSkillContent(content: string): {
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return { frontmatter: {}, body: content };
        }

        const parsed = loadFrontmatterObject(extracted.frontmatterStr, 'Failed to parse full skill content:');
        if (!parsed) {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<SkillFrontmatter> = {};

        if (typeof parsed.name === 'string') frontmatter.name = parsed.name;
        if (typeof parsed.description === 'string') frontmatter.description = parsed.description;
        if (typeof parsed.license === 'string') frontmatter.license = parsed.license;
        if (typeof parsed.compatibility === 'string') frontmatter.compatibility = parsed.compatibility;
        const metadata = extractSkillMetadata(parsed);
        if (metadata) frontmatter.metadata = metadata;
        const author = extractAuthor(parsed);
        if (author) frontmatter.author = author;
        if (typeof parsed['disable-model-invocation'] === 'boolean') {
            frontmatter['disable-model-invocation'] = parsed['disable-model-invocation'];
        }
        if (typeof parsed['user-invocable'] === 'boolean') {
            frontmatter['user-invocable'] = parsed['user-invocable'];
        }
        if (typeof parsed['allowed-tools'] === 'string') {
            frontmatter['allowed-tools'] = parsed['allowed-tools'];
        }
        if (typeof parsed.context === 'string') frontmatter.context = parsed.context;
        if (typeof parsed.agent === 'string') frontmatter.agent = parsed.agent;
        if (typeof parsed['argument-hint'] === 'string') {
            frontmatter['argument-hint'] = parsed['argument-hint'];
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full skill content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Parse complete Command file content
 * Returns both frontmatter and markdown body content
 * If name is not in frontmatter, tries to extract from first # heading in body
 */
export function parseFullCommandContent(content: string): {
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            // No frontmatter, try to extract name from # heading
            const headingMatch = content.match(/^#\s+(.+)$/m);
            const name = headingMatch ? headingMatch[1].trim() : undefined;
            return { frontmatter: name ? { name } : {}, body: content };
        }

        const parsed = loadFrontmatterObject(extracted.frontmatterStr, 'Failed to parse full command content:');
        if (!parsed) {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<CommandFrontmatter> = {};
        if (typeof parsed.name === 'string') {
            frontmatter.name = parsed.name;
        }
        if (typeof parsed.description === 'string') {
            frontmatter.description = parsed.description;
        }
        // Extract author from top-level or nested metadata
        const author = extractAuthor(parsed);
        if (author) {
            frontmatter.author = author;
        }

        // If name is not in frontmatter, try to extract from first # heading in body
        if (!frontmatter.name) {
            const headingMatch = extracted.body.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                frontmatter.name = headingMatch[1].trim();
            }
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full command content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Serialize Skill frontmatter and body back to SKILL.md format
 */
export function serializeSkillContent(frontmatter: Partial<SkillFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    if (frontmatter.name) lines.push(`name: ${frontmatter.name}`);
    if (frontmatter.description) lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    if (frontmatter.license) lines.push(`license: ${JSON.stringify(frontmatter.license)}`);
    if (frontmatter.compatibility) lines.push(`compatibility: ${JSON.stringify(frontmatter.compatibility)}`);

    // `author` is a normalized projection for old callers and the UI. Persist
    // it only through the Agent Skills standard `metadata` map. Other metadata
    // survives an edit even though the current panel does not expose fields
    // for it.
    const metadata = { ...(frontmatter.metadata ?? {}) };
    if (frontmatter.author) {
        delete metadata.Author;
        metadata.author = frontmatter.author;
    }
    if (Object.keys(metadata).length > 0) {
        lines.push('metadata:');
        for (const [key, value] of Object.entries(metadata)) {
            const yamlKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
            lines.push(`  ${yamlKey}: ${JSON.stringify(String(value))}`);
        }
    }
    if (frontmatter['disable-model-invocation'] !== undefined) {
        lines.push(`disable-model-invocation: ${frontmatter['disable-model-invocation']}`);
    }
    if (frontmatter['user-invocable'] !== undefined) {
        lines.push(`user-invocable: ${frontmatter['user-invocable']}`);
    }
    if (frontmatter['allowed-tools']) lines.push(`allowed-tools: ${frontmatter['allowed-tools']}`);
    if (frontmatter.context) lines.push(`context: ${frontmatter.context}`);
    if (frontmatter.agent) lines.push(`agent: ${frontmatter.agent}`);
    if (frontmatter['argument-hint']) lines.push(`argument-hint: ${frontmatter['argument-hint']}`);

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}

/**
 * Serialize Command frontmatter and body back to markdown format
 */
export function serializeCommandContent(frontmatter: Partial<CommandFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    // Always quote name to handle special characters (colons, quotes, etc.)
    if (frontmatter.name) {
        lines.push(`name: "${frontmatter.name.replace(/"/g, '\\"')}"`);
    }
    if (frontmatter.description) {
        lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    }

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}
