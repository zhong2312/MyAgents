/**
 * AgentCapabilitiesPanel - Panel showing enabled agent capabilities
 * Used in the Chat sidebar (DirectoryPanel) to show Sub-Agents, Skills, Commands
 *
 * Interactions:
 * - Default collapsed, click header to toggle
 * - Hover: tooltip with scope + description
 * - Click Skills/Commands: insert /name into chat input
 * - Click Agent: toast hint (AI decides when to use)
 * - Right-click Agent: enable/disable, settings
 * - Right-click Skills/Commands: settings
 */
import { Bot, ChevronDown, ChevronRight, Globe, RefreshCw, Settings2, Sparkles, Terminal } from 'lucide-react';
import { memo, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { useToast } from '@/components/Toast';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import type { CapabilityInitialSelect } from '../../shared/skillsTypes';

interface CapabilityItem {
    name: string;
    description: string;
    scope?: 'user' | 'project';
    model?: string;
    /** Skill: folder name on disk (used to route to detail panel) */
    folderName?: string;
    /** Custom command: file name without .md (used to route to detail panel) */
    fileName?: string;
}

interface AgentCapabilitiesPanelProps {
    enabledAgents?: Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project'; folderName?: string }>;
    enabledSkills?: CapabilityItem[];
    enabledCommands?: CapabilityItem[];
    /** Insert /command into chat input */
    onInsertSlashCommand?: (command: string) => void;
    /** Open settings panel (skills tab); when invoked from "设置" on a specific item,
     *  the receiving panel uses `initialSelect` to open that item's detail directly. */
    onOpenSettings?: (initialSelect?: CapabilityInitialSelect) => void;
    /** Set of global skill folderNames (for hiding "sync to global" on already-global skills) */
    globalSkillFolderNames?: Set<string>;
    /** Copy a project skill to global skills */
    onSyncSkillToGlobal?: (folderName: string) => void;
    /** Called when expand/collapse state changes (for sibling layout recalculation) */
    onExpandChange?: (expanded: boolean) => void;
    /** Trigger full refresh (file tree + capabilities) */
    onRefresh?: () => void;
    /** Height ratio (0-1) when expanded, controlled by parent drag. Default 0.4. */
    heightRatio?: number;
}

/** Tooltip shown on hover — width matches the sidebar with small inset */
function ItemTooltip({ scope, description, children }: {
    scope?: string;
    description?: string;
    children: React.ReactNode;
}) {
    const { t } = useTranslation('settings');
    const [show, setShow] = useState(false);
    const [pos, setPos] = useState({ x: 0, y: 0, width: 240 });
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    const handleMouseEnter = useCallback((e: React.MouseEvent) => {
        const el = e.currentTarget as HTMLElement;
        const rect = el.getBoundingClientRect();
        // Walk up to the nearest scrollable panel to get sidebar width
        const panel = el.closest('[data-capabilities-panel]') as HTMLElement | null;
        const panelRect = panel?.getBoundingClientRect();
        const panelLeft = panelRect?.left ?? rect.left;
        const panelWidth = panelRect?.width ?? 240;
        const inset = 8; // px padding from sidebar edges
        setPos({ x: panelLeft + inset, y: rect.top - 4, width: panelWidth - inset * 2 });
        timerRef.current = setTimeout(() => setShow(true), 400);
    }, []);

    const handleMouseLeave = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setShow(false);
    }, []);

    // Cleanup timer on unmount to prevent state update on unmounted component
    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    return (
        <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} className="relative">
            {children}
            {show && (scope || description) && (
                <div
                    className="fixed z-50 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 shadow-lg"
                    style={{ left: pos.x, top: pos.y, width: pos.width, transform: 'translateY(-100%)' }}
                >
                    {scope && (
                        <span className="mb-1 inline-block rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                            {scope === 'user' ? t('agentSettings.capabilities.scopeUser') : scope === 'project' ? t('agentSettings.capabilities.scopeProject') : scope}
                        </span>
                    )}
                    {description && (
                        <p className="text-xs leading-relaxed text-[var(--ink-muted)]">{description}</p>
                    )}
                </div>
            )}
        </div>
    );
}

export default memo(function AgentCapabilitiesPanel({
    enabledAgents,
    enabledSkills,
    enabledCommands,
    onInsertSlashCommand,
    onOpenSettings,
    globalSkillFolderNames,
    onSyncSkillToGlobal,
    onExpandChange,
    onRefresh,
    heightRatio = 0.4,
}: AgentCapabilitiesPanelProps) {
    const { t } = useTranslation('settings');
    const [isExpanded, setIsExpanded] = useState(false);
    const toast = useToast();
    const toastRef = useRef(toast);
    useEffect(() => { toastRef.current = toast; }, [toast]);

    // Stabilize onExpandChange ref to avoid re-creating toggleExpand
    const onExpandChangeRef = useRef(onExpandChange);
    useEffect(() => { onExpandChangeRef.current = onExpandChange; }, [onExpandChange]);

    // Stabilize onSyncSkillToGlobal ref
    const onSyncSkillToGlobalRef = useRef(onSyncSkillToGlobal);
    useEffect(() => { onSyncSkillToGlobalRef.current = onSyncSkillToGlobal; }, [onSyncSkillToGlobal]);

    // Stabilize globalSkillFolderNames ref (Set changes on every render from parent)
    const globalSkillFolderNamesRef = useRef(globalSkillFolderNames);
    useEffect(() => { globalSkillFolderNamesRef.current = globalSkillFolderNames; }, [globalSkillFolderNames]);

    // Context menu state
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

    const toggleExpand = useCallback(() => {
        setIsExpanded(prev => {
            const next = !prev;
            // Notify parent after DOM update for layout recalculation
            requestAnimationFrame(() => onExpandChangeRef.current?.(next));
            return next;
        });
    }, []);

    // Convert agents map to list. `folderName` rides through so the context-menu
    // "设置" handler can route to the agent's detail panel without a second lookup.
    const agentList = useMemo<CapabilityItem[]>(() =>
        enabledAgents
            ? Object.entries(enabledAgents).map(([name, def]) => ({
                name,
                description: def.description || '',
                model: def.model,
                scope: def.scope,
                folderName: def.folderName,
            }))
            : [],
    [enabledAgents]);

    const skillsList = enabledSkills || [];
    const commandsList = enabledCommands || [];

    const agentCount = agentList.length;
    const skillsCount = skillsList.length;
    const commandsCount = commandsList.length;
    const totalCount = agentCount + skillsCount + commandsCount;

    // Click handlers
    const handleSkillClick = useCallback((name: string) => {
        track('skill_use', { skill_name: name });
        onInsertSlashCommand?.(name);
    }, [onInsertSlashCommand]);

    const handleCommandClick = useCallback((name: string) => {
        onInsertSlashCommand?.(name);
    }, [onInsertSlashCommand]);

    const handleAgentClick = useCallback(() => {
        toastRef.current.info(t('agentSettings.capabilities.enabledHint'));
    }, [t]);

    // Map capability kind → Settings page section the global panel lives under.
    // 'sub-agents' (not 'agents') is the canonical section name in
    // Settings.tsx VALID_SECTIONS — passing 'agents' was a no-op before.
    const sectionForKind = (kind: CapabilityInitialSelect['kind'] | undefined): 'skills' | 'sub-agents' =>
        kind === 'agent' ? 'sub-agents' : 'skills';

    // Route a selection to the right settings surface. `select` may be undefined
    // (e.g. data still loading and the disk identifier wasn't available); in
    // that case we still open the right surface based on `scope` so the user
    // never sees a no-op "设置" click — they just land on the list view.
    const openSettingsFor = useCallback((scope: 'user' | 'project' | undefined, select: CapabilityInitialSelect | undefined) => {
        const effectiveScope = select?.scope ?? scope;
        if (effectiveScope === 'user') {
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                detail: { section: sectionForKind(select?.kind), selectItem: select },
            }));
        } else {
            onOpenSettings?.(select);
        }
        setCtxMenu(null);
    }, [onOpenSettings]);

    // Right-click handlers — split per kind so each constructs the right
    // discriminated payload (folderName vs fileName) and TS catches mismatches.
    const handleAgentContextMenu = useCallback((e: React.MouseEvent, scope: 'user' | 'project' | undefined, folderName: string | undefined) => {
        e.preventDefault();
        e.stopPropagation();
        const select: CapabilityInitialSelect | undefined =
            scope && folderName ? { kind: 'agent', folderName, scope } : undefined;
        const items: ContextMenuItem[] = [
            { label: t('agentSettings.capabilities.settings'), icon: <Settings2 className="h-3.5 w-3.5" />, onClick: () => openSettingsFor(scope, select) },
            { label: t('agentSettings.capabilities.refresh'), icon: <RefreshCw className="h-3.5 w-3.5" />, onClick: () => onRefresh?.() },
        ];
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }, [openSettingsFor, onRefresh, t]);

    const handleSkillContextMenu = useCallback((e: React.MouseEvent, scope: 'user' | 'project' | undefined, folderName: string | undefined) => {
        e.preventDefault();
        e.stopPropagation();
        const select: CapabilityInitialSelect | undefined =
            scope && folderName ? { kind: 'skill', folderName, scope } : undefined;
        const items: ContextMenuItem[] = [
            { label: t('agentSettings.capabilities.settings'), icon: <Settings2 className="h-3.5 w-3.5" />, onClick: () => openSettingsFor(scope, select) },
            { label: t('agentSettings.capabilities.refresh'), icon: <RefreshCw className="h-3.5 w-3.5" />, onClick: () => onRefresh?.() },
        ];
        // Project skills can be synced to global (hide if already exists globally)
        if (scope === 'project' && folderName && !globalSkillFolderNamesRef.current?.has(folderName)) {
            items.push({
                label: t('agentSettings.capabilities.syncToGlobal'),
                icon: <Globe className="h-3.5 w-3.5" />,
                onClick: () => {
                    onSyncSkillToGlobalRef.current?.(folderName);
                    setCtxMenu(null);
                },
            });
        }
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }, [openSettingsFor, onRefresh, t]);

    const handleCommandContextMenu = useCallback((e: React.MouseEvent, scope: 'user' | 'project' | undefined, fileName: string | undefined) => {
        e.preventDefault();
        e.stopPropagation();
        const select: CapabilityInitialSelect | undefined =
            scope && fileName ? { kind: 'command', fileName, scope } : undefined;
        const items: ContextMenuItem[] = [
            { label: t('agentSettings.capabilities.settings'), icon: <Settings2 className="h-3.5 w-3.5" />, onClick: () => openSettingsFor(scope, select) },
            { label: t('agentSettings.capabilities.refresh'), icon: <RefreshCw className="h-3.5 w-3.5" />, onClick: () => onRefresh?.() },
        ];
        setCtxMenu({ x: e.clientX, y: e.clientY, items });
    }, [openSettingsFor, onRefresh, t]);

    // Empty state. The tree↔capabilities boundary is owned by the parent
    // (DirectoryPanel's drag-divider) — this branch must NOT draw its own top
    // border or two separator lines render back-to-back (#314).
    if (totalCount === 0) {
        return (
            <div data-capabilities-panel className="flex shrink-0 flex-col">
                <button
                    onClick={toggleExpand}
                    aria-expanded={isExpanded}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink)] transition-colors"
                >
                    {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                    <span className="font-semibold">{t('agentSettings.capabilities.title')}</span>
                </button>
                {isExpanded && (
                    <div className="px-4 pb-3 text-center">
                        <p className="text-sm text-[var(--ink-muted)]">
                            {t('agentSettings.capabilities.emptyDescription')}
                        </p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div
            data-capabilities-panel
            className={`flex flex-col ${isExpanded ? 'min-h-0' : 'shrink-0'}`}
            style={isExpanded ? { flex: `0 0 ${heightRatio * 100}%` } : undefined}
        >
            {/* Header - always visible */}
            <button
                onClick={toggleExpand}
                aria-expanded={isExpanded}
                className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-sm text-[var(--ink)] transition-colors"
            >
                {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span className="font-semibold">{t('agentSettings.capabilities.titleWithCount', { count: totalCount })}</span>
            </button>

            {/* Expanded content - scrollable */}
            {isExpanded && (
                <div
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 space-y-2"
                    style={{ scrollbarGutter: 'stable' }}
                >
                    {/* Commands Group */}
                    {commandsCount > 0 && (
                        <div>
                            <p className="px-1 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Commands ({commandsCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {commandsList.map(item => (
                                    <ItemTooltip key={`cmd-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={() => handleCommandClick(item.name)}
                                            onContextMenu={e => handleCommandContextMenu(e, item.scope, item.fileName)}
                                            // handleCommandClick inserts /name then focuses the chat textarea;
                                            // without this the click is dropped on a macOS WebKit trackpad tap
                                            // (focus-steal). preventDefault on mousedown keeps the textarea focused.
                                            onMouseDown={retainFocusOnMouseDown}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover-bg)] transition-colors"
                                        >
                                            <Terminal className="h-3 w-3 shrink-0 text-[var(--success)]" />
                                            <p className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{item.name}</p>
                                        </button>
                                    </ItemTooltip>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Skills Group */}
                    {skillsCount > 0 && (
                        <div>
                            <p className="px-1 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Skills ({skillsCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {skillsList.map(item => (
                                    <ItemTooltip key={`skill-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={() => handleSkillClick(item.name)}
                                            onContextMenu={e => handleSkillContextMenu(e, item.scope, item.folderName)}
                                            // Same focus-steal guard as the command rows above.
                                            onMouseDown={retainFocusOnMouseDown}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover-bg)] transition-colors"
                                        >
                                            <Sparkles className="h-3 w-3 shrink-0 text-amber-500" />
                                            <p className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{item.name}</p>
                                        </button>
                                    </ItemTooltip>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Sub-Agents Group */}
                    {agentCount > 0 && (
                        <div>
                            <p className="px-1 text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]/60">
                                Sub-Agents ({agentCount})
                            </p>
                            <div className="mt-0.5 space-y-0.5">
                                {agentList.map(item => (
                                    <ItemTooltip key={`agent-${item.name}`} scope={item.scope} description={item.description}>
                                        <button
                                            onClick={handleAgentClick}
                                            onContextMenu={e => handleAgentContextMenu(e, item.scope, item.folderName)}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--hover-bg)] transition-colors"
                                        >
                                            <Bot className="h-3 w-3 shrink-0 text-violet-500" />
                                            <p className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">{item.name}</p>
                                            {item.model && (
                                                <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1 py-0.5 text-xs text-[var(--ink-muted)]">
                                                    {item.model}
                                                </span>
                                            )}
                                        </button>
                                    </ItemTooltip>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Context Menu */}
            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={ctxMenu.items}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </div>
    );
});
