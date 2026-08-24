// Project management — CRUD, touch, sort
import { join, basename } from '@tauri-apps/api/path';

import type { Project } from '../types';
import { isProjectArchived, isSystemPresetProject } from '../types';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import {
    isBrowserDevMode,
    withProjectsLock,
    ensureConfigDir,
    getConfigDir,
    PROJECTS_FILE,
    safeLoadJson,
    safeWriteJson,
} from './configStore';
import { apiGetJson, apiPutJson } from '@/api/apiFetch';
import {
    mockLoadProjects,
    mockSaveProjects,
} from '@/utils/browserMock';

// ============= Helpers =============

function sortProjectsByLastOpened(projects: Project[]): Project[] {
    return [...projects].sort((a, b) => {
        const timeA = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
        const timeB = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
        return timeB - timeA;
    });
}

function isValidProjectsArray(data: unknown): data is Project[] {
    return Array.isArray(data) && data.every(
        (item) => item && typeof item === 'object' && 'id' in item && 'name' in item && 'path' in item,
    );
}

// ============= CRUD =============

export async function loadProjects(): Promise<Project[]> {
    if (isBrowserDevMode()) {
        try {
            const result = await apiGetJson<{ success: true; projects: Project[] }>('/api/workbench-dev-storage/projects');
            return sortProjectsByLastOpened(result.projects);
        } catch (error) {
            // 独立 Vite 开发没有 profile 后端时，继续沿用浏览器本地工作流。
            console.warn('[configService] Browser project registry unavailable, using localStorage:', error);
            return sortProjectsByLastOpened(mockLoadProjects());
        }
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);

        const projects = await safeLoadJson<Project[]>(projectsPath, isValidProjectsArray);
        if (projects) {
            return sortProjectsByLastOpened(projects);
        }
        console.log('[configService] No valid projects file found, returning empty array');
        return [];
    } catch (error) {
        console.error('[configService] Failed to load projects:', error);
        return [];
    }
}

export async function saveProjects(projects: Project[]): Promise<void> {
    if (isBrowserDevMode()) {
        try {
            await apiPutJson<{ success: true }>('/api/workbench-dev-storage/projects', { projects });
        } catch (error) {
            console.warn('[configService] Browser project registry unavailable, saving to localStorage:', error);
            mockSaveProjects(projects);
        }
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);
        await safeWriteJson(projectsPath, projects);
        console.log('[configService] Projects saved successfully');
    } catch (error) {
        console.error('[configService] Failed to save projects:', error);
        throw error;
    }
}

export async function addProject(path: string): Promise<Project> {
    console.log('[configService] addProject called with path:', path);

    return withProjectsLock(async () => {
        const projects = await loadProjects();

        // #320: dedup by canonical workspace identity, not raw `===`, so a path
        // arriving in a different separator/case form doesn't create a duplicate
        // project pointing at the same directory.
        const existing = projects.find((p) => workspacePathsEqual(p.path, path));
        if (existing) {
            console.log('[configService] Project already exists, updating lastOpened');
            existing.lastOpened = new Date().toISOString();
            if (existing.name && (existing.name.includes('/') || existing.name.includes('\\'))) {
                const parts = existing.name.replace(/\\/g, '/').split('/').filter(Boolean);
                existing.name = parts[parts.length - 1] || existing.name;
                console.log('[configService] Fixed project name from path to:', existing.name);
            }
            await saveProjects(projects);
            return existing;
        }

        let name: string;
        try {
            name = await basename(path);
            if (!name || name.trim().length === 0) {
                throw new Error('Empty basename result');
            }
        } catch (err) {
            console.warn('[configService] basename() failed, using fallback:', err);
            const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
            name = parts[parts.length - 1] || 'Unknown';
        }

        const newProject: Project = {
            id: crypto.randomUUID(),
            name,
            path,
            lastOpened: new Date().toISOString(),
            providerId: null,
            permissionMode: null,
        };

        console.log('[configService] Creating new project:', newProject);
        projects.push(newProject);
        await saveProjects(projects);
        return newProject;
    });
}

export async function updateProject(project: Project): Promise<void> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === project.id);
        if (index >= 0) {
            projects[index] = project;
            await saveProjects(projects);
        }
    });
}

export function applyProjectPatch(project: Project, updates: Partial<Omit<Project, 'id'>>): Project {
    const next: Project = { ...project, ...updates };
    for (const key of Object.keys(updates) as Array<keyof Omit<Project, 'id'>>) {
        if (updates[key] === undefined) {
            delete (next as Partial<Record<keyof Omit<Project, 'id'>, unknown>>)[key];
        }
    }
    return next;
}

export function applyProjectArchiveIntent(
    projects: Project[],
    projectId: string,
    options: {
        archivedAtIso?: string;
        agentEnabledBeforeArchive?: boolean;
    } = {},
): { project: Project; projects: Project[] } | null {
    const index = projects.findIndex((p) => p.id === projectId);
    if (index < 0) return null;

    const project = projects[index];
    const existingArchived = isProjectArchived(project);
    const archivedProject = applyProjectPatch(project, {
        archivedAt: existingArchived
            ? project.archivedAt
            : options.archivedAtIso ?? new Date().toISOString(),
        archivedAgentEnabledBeforeArchive: existingArchived
            ? project.archivedAgentEnabledBeforeArchive ?? options.agentEnabledBeforeArchive ?? false
            : options.agentEnabledBeforeArchive ?? false,
        pinnedAt: undefined,
    });
    const nextProjects = [...projects];
    nextProjects[index] = archivedProject;
    return { project: archivedProject, projects: nextProjects };
}

export function applyProjectUnarchiveIntent(
    projects: Project[],
    projectId: string,
): { project: Project; projects: Project[] } | null {
    const index = projects.findIndex((p) => p.id === projectId);
    if (index < 0) return null;

    const project = applyProjectPatch(projects[index], {
        archivedAt: undefined,
        archivedAgentEnabledBeforeArchive: undefined,
    });
    const nextProjects = [...projects];
    nextProjects[index] = project;
    return { project, projects: nextProjects };
}

export async function patchProject(projectId: string, updates: Partial<Omit<Project, 'id'>>): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === projectId);
        if (index >= 0) {
            projects[index] = applyProjectPatch(projects[index], updates);
            await saveProjects(projects);
            return projects[index];
        }
        return null;
    });
}

export async function archiveProject(
    projectId: string,
    options: { archivedAtIso?: string; agentEnabledBeforeArchive?: boolean } = {},
): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const result = applyProjectArchiveIntent(projects, projectId, {
            archivedAtIso: options.archivedAtIso,
            agentEnabledBeforeArchive: options.agentEnabledBeforeArchive,
        });
        if (!result) return null;
        await saveProjects(result.projects);
        return result.project;
    });
}

export async function unarchiveProject(projectId: string): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const result = applyProjectUnarchiveIntent(projects, projectId);
        if (!result) return null;
        await saveProjects(result.projects);
        return result.project;
    });
}

export interface RemoveOrHideProjectResult {
    action: 'removed' | 'hidden';
    project: Project;
    projects: Project[];
}

export function applyProjectRemovalIntent(
    projects: Project[],
    projectId: string,
    hiddenAtIso: string = new Date().toISOString(),
): RemoveOrHideProjectResult | null {
    const index = projects.findIndex((p) => p.id === projectId);
    if (index < 0) return null;

    const project = projects[index];
    if (isSystemPresetProject(project)) {
        const hiddenProject: Project = {
            ...project,
            hidden: true,
            hiddenAt: hiddenAtIso,
        };
        const nextProjects = [...projects];
        nextProjects[index] = hiddenProject;
        return { action: 'hidden', project: hiddenProject, projects: nextProjects };
    }

    return {
        action: 'removed',
        project,
        projects: projects.filter((p) => p.id !== projectId),
    };
}

/**
 * User-facing workspace removal.
 *
 * Ordinary workspaces are removed from projects.json. System preset workspaces
 * are soft-deleted instead, preserving the registry row so startup self-healing
 * can distinguish "user hid this preset" from "registration was corrupted".
 */
export async function removeOrHideProject(projectId: string): Promise<RemoveOrHideProjectResult | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const result = applyProjectRemovalIntent(projects, projectId);
        if (!result) return null;
        await saveProjects(result.projects);
        return result;
    });
}

export async function touchProject(projectId: string): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === projectId);
        if (index < 0) {
            console.warn('[configService] touchProject: project not found:', projectId);
            return null;
        }

        const updatedProject = {
            ...projects[index],
            lastOpened: new Date().toISOString(),
        };
        projects[index] = updatedProject;
        await saveProjects(projects);
        console.log('[configService] Project touched:', projectId);
        return updatedProject;
    });
}
