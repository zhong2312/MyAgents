/**
 * searchClient.ts — Search API abstraction layer.
 *
 * Search is a Tauri-only feature. It calls the Rust `SearchEngine` directly
 * via Tauri IPC — there is no Node Sidecar path. Browser dev mode
 * (`start_dev.sh`) does not ship a search fallback; the UI entry points are
 * gated so the buttons don't appear outside Tauri.
 */

import { invoke } from '@tauri-apps/api/core';

// ── Types ──────────────────────────────────────────────────────────

export interface SessionSearchResult {
    hits: SessionSearchHit[];
    totalCount: number;
    queryTimeMs: number;
}

export interface SessionSearchHit {
    sessionId: string;
    title: string;
    agentDir: string;
    score: number;
    /** "title" or "content" */
    matchType: string;
    /** Context snippet for content matches */
    snippet: string | null;
    /** Highlight positions within the snippet: [[start, end], ...] */
    snippetHighlights: [number, number][];
    /** Highlight positions within the title: [[start, end], ...] */
    titleHighlights: [number, number][];
    /** "user" or "assistant" for content matches */
    matchedRole: string | null;
    lastActiveAt: string;
    source: string | null;
    turnCount: number | null;
}

export interface FileSearchResult {
    hits: FileSearchHit[];
    totalFiles: number;
    totalMatches: number;
    queryTimeMs: number;
}

export interface FileSearchHit {
    path: string;
    name: string;
    matchCount: number;
    matches: FileMatchLine[];
}

export interface FileMatchLine {
    lineNumber: number;
    lineContent: string;
    /** Highlight positions within lineContent: [[start, end], ...] */
    highlights: [number, number][];
}

// ── API Functions ──────────────────────────────────────────────────

/**
 * Search session history (title + content).
 * Global scope — searches across all workspaces.
 */
export async function searchSessions(
    query: string,
    limit = 50,
): Promise<SessionSearchResult> {
    if (!query.trim()) {
        return { hits: [], totalCount: 0, queryTimeMs: 0 };
    }
    return invoke<SessionSearchResult>('cmd_search_sessions', { query, limit });
}

/**
 * Search workspace files (name + content).
 * Scoped to a specific workspace directory.
 */
export async function searchWorkspaceFiles(
    query: string,
    workspace: string,
    limit = 50,
    maxMatchesPerFile = 10,
): Promise<FileSearchResult> {
    if (!query.trim()) {
        return { hits: [], totalFiles: 0, totalMatches: 0, queryTimeMs: 0 };
    }
    return invoke<FileSearchResult>('cmd_search_workspace_files', {
        query,
        workspace,
        limit,
        maxMatchesPerFile,
    });
}

/**
 * Invalidate a workspace file index so it is rebuilt from scratch on the next
 * search. Kept for hard resets (schema migration, corruption recovery).
 */
export async function invalidateWorkspaceFileIndex(workspace: string): Promise<void> {
    return invoke('cmd_invalidate_workspace_index', { workspace });
}

/**
 * Incrementally refresh a workspace file index against the current filesystem.
 * Walks metadata only and re-indexes just the files whose mtime/size changed.
 *
 * Explicit refresh hook. Do not call this as background prewarm for ordinary
 * tab opens or empty search mode: cold refreshes are heavy IO/CPU work. The
 * file-search UI calls search first, then uses this as stale-while-revalidate
 * follow-up work, or for an explicit user action.
 *
 * Returns `[totalFiles, changedFiles]`.
 */
export async function refreshWorkspaceFileIndex(workspace: string): Promise<[number, number]> {
    return invoke<[number, number]>('cmd_refresh_workspace_index', { workspace });
}
