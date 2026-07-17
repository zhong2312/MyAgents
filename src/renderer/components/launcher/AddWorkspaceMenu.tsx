/**
 * AddWorkspaceMenu — dropdown menu for workspace "Add" button
 * Two options: add local folder, create from template
 */

import { memo, useCallback, useRef, useState } from 'react';
import { BookOpen, Plus, FolderPlus, LayoutTemplate } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
}

export default memo(function AddWorkspaceMenu({
    onAddFolder,
    onCreateFromTemplate,
    workbenchCreateActions = [],
    onCreateWorkbench,
}: AddWorkspaceMenuProps) {
    const { t } = useTranslation('launcher');
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const toggle = useCallback(() => setOpen(prev => !prev), []);

    return (
        <>
            <button
                ref={buttonRef}
                onClick={toggle}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
                <Plus className="h-3.5 w-3.5" />
                {t('addWorkspaceMenu.add')}
            </button>
            <Popover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={buttonRef}
                placement="bottom-end"
                className="w-[210px] py-1"
            >
                {workbenchCreateActions.map((action) => (
                    <button
                        key={action.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
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
                    onClick={() => { setOpen(false); onAddFolder(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <FolderPlus className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    {t('addWorkspaceMenu.addLocalFolder')}
                </button>
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onCreateFromTemplate(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <LayoutTemplate className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    {t('addWorkspaceMenu.createFromTemplateAgent')}
                </button>
            </Popover>
        </>
    );
});
