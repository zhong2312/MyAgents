/**
 * AddWorkspaceMenu — dropdown menu for workspace "Add" button
 * Two options: add local folder, create from template
 */

import { memo, useCallback, useRef, useState } from 'react';
import { BookOpen, Plus, FolderPlus, LayoutTemplate } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import Tip from '@/components/Tip';
import { Popover } from '@/components/ui/Popover';

export interface WorkbenchCreateAction {
    id: string;
    label: string;
    icon?: string;
}

interface AddWorkspaceMenuProps {
    onAddFolder: () => void;
    onCreateFromTemplate: () => void;
    workbenchCreateActions?: readonly WorkbenchCreateAction[];
    onCreateWorkbench?: (workbenchId: string) => void;
    variant?: 'label' | 'icon';
    onOpenChange?: (open: boolean) => void;
}

export default memo(function AddWorkspaceMenu({
    onAddFolder,
    onCreateFromTemplate,
    workbenchCreateActions = [],
    onCreateWorkbench,
    variant = 'label',
    onOpenChange,
}: AddWorkspaceMenuProps) {
    const { t } = useTranslation('launcher');
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const setMenuOpen = useCallback((next: boolean) => {
        setOpen(next);
        onOpenChange?.(next);
    }, [onOpenChange]);

    const toggle = useCallback(() => setMenuOpen(!open), [open, setMenuOpen]);

    const button = (
        <button
                ref={buttonRef}
                onClick={toggle}
                className={variant === 'icon'
                    ? 'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                    : 'flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]'}
                aria-label={t('addWorkspaceMenu.add')}
            >
                <Plus className="h-3.5 w-3.5" />
                {variant === 'label' && t('addWorkspaceMenu.add')}
            </button>
    );

    return (
        <>
            {variant === 'icon' ? (
                <Tip label={t('addWorkspaceMenu.add')} position="bottom" align="end" disabled={open}>
                    {button}
                </Tip>
            ) : button}
            <Popover
                open={open}
                onClose={() => setMenuOpen(false)}
                anchorRef={buttonRef}
                placement="bottom-end"
                className="global-sidebar-nested-layer w-48 py-1"
            >
                {workbenchCreateActions.map((action) => (
                    <button
                        key={action.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setMenuOpen(false);
                            onCreateWorkbench?.(action.id);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <BookOpen className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                        {action.label}
                    </button>
                ))}
                {workbenchCreateActions.length > 0 && (
                    <div className="mx-2 my-1 border-t border-[var(--line-subtle)]" />
                )}
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onAddFolder(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <FolderPlus className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    {t('addWorkspaceMenu.addLocalFolder')}
                </button>
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); onCreateFromTemplate(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <LayoutTemplate className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    {t('addWorkspaceMenu.createFromTemplateAgent')}
                </button>
            </Popover>
        </>
    );
});
