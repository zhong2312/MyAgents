/**
 * Shared types for Skills & Commands management
 */
import type { SkillFrontmatter, CommandFrontmatter } from './slashCommands';
import type { ProjectCapabilitySource } from './projectCapabilities';
import type { SkillIntegrityIssue } from './skillIntegrity';

// Re-export frontmatter types
export type { SkillFrontmatter, CommandFrontmatter };

/**
 * Skill item in list view
 */
export interface SkillItem {
    name: string;
    description: string;
    scope: 'user' | 'project';
    path: string;
    folderName: string;
    author?: string;
    /** Content is versioned and force-synced by MyAgents. */
    systemOwned: boolean;
    /** Product contract requires this global skill to remain enabled. */
    required: boolean;
    /** Effective enablement (always true for project and required skills). */
    enabled: boolean;
    /** Present in the workspace capability list; stable project override key. */
    capabilityId?: string;
    /** Physical origin after resolving MyAgents-managed project symlinks. */
    origin?: ProjectCapabilitySource;
}

/**
 * Command item in list view
 */
export interface CommandItem {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    invocationName?: string; // Slash token derived from the source path in project capability snapshots
    fileName: string;       // Actual file name without .md extension
    description: string;
    scope: 'user' | 'project';
    path: string;
    author?: string;
    enabled?: boolean;
    required?: boolean;
    capabilityId?: string;
    origin?: ProjectCapabilitySource;
}

/**
 * Full skill detail with frontmatter and body
 */
export interface SkillDetail {
    name: string;
    folderName: string;
    path: string;
    scope: 'user' | 'project';
    /** Content is versioned and maintained by MyAgents. */
    systemOwned: boolean;
    /** Product contract requires this global Skill to remain available. */
    required: boolean;
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
}

/**
 * Full command detail with frontmatter and body
 */
export interface CommandDetail {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    fileName: string;       // Actual file name without .md extension
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
}

/**
 * API response types
 */
export interface SkillsListResponse {
    success: boolean;
    skills: SkillItem[];
    integrityIssues?: SkillIntegrityIssue[];
    error?: string;
}

export interface CommandsListResponse {
    success: boolean;
    commands: CommandItem[];
    error?: string;
}

export interface SkillDetailResponse {
    success: boolean;
    skill: SkillDetail;
    error?: string;
}

export interface CommandDetailResponse {
    success: boolean;
    command: CommandDetail;
    error?: string;
}

export interface ApiSuccessResponse {
    success: boolean;
    error?: string;
    path?: string;
    folderName?: string;
    name?: string;
}

/**
 * Capability kinds shown in AgentCapabilitiesPanel.
 * Used to route a "drill into this item" intent from the chat sidebar
 * to the right detail panel in Settings / WorkspaceConfig.
 */
export type CapabilityKind = 'skill' | 'command' | 'agent';

/**
 * Tells a settings panel "open already showing this item's detail".
 *
 * Discriminated by `kind`, so the on-disk identifier is paired with the
 * kind that owns it — TS rejects mismatches at construction:
 *   - skill   → folderName (e.g. "github")
 *   - command → fileName without .md (e.g. "review")
 *   - agent   → folderName (e.g. "code-reviewer")
 *
 * Display names can be overridden via frontmatter and are not stable —
 * disk identifiers are. Compare with `SlashCommand.source` in `slashCommands.ts`,
 * which has overlapping but different domain (no 'agent', plus 'builtin' /
 * SDK runtime commands) and therefore can't be reused directly.
 */
export type CapabilityInitialSelect =
    | { kind: 'skill'; folderName: string; scope: 'user' | 'project' }
    | { kind: 'command'; fileName: string; scope: 'user' | 'project' }
    | { kind: 'agent'; folderName: string; scope: 'user' | 'project' };

/**
 * Extracts the disk identifier regardless of kind. Use only when the
 * receiving code genuinely doesn't care which kind it is (e.g. for logging);
 * otherwise switch on `kind` so adding a new kind fails the build.
 */
export function capabilitySelectId(select: CapabilityInitialSelect): string {
    switch (select.kind) {
        case 'skill': return select.folderName;
        case 'command': return select.fileName;
        case 'agent': return select.folderName;
    }
}
