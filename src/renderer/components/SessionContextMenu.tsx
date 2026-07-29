import { BarChart2, Copy, Star, Trash2 } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { SessionMetadata } from '@/api/sessionClient';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover, type PopoverPlacement } from '@/components/ui/Popover';

interface SessionContextMenuProps {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    placement?: PopoverPlacement;
    session: SessionMetadata;
    deleteProtected: boolean;
    onCopySessionId: () => void | Promise<void>;
    onToggleFavorite: () => void | Promise<void>;
    onShowStats: (origin?: HTMLElement | null) => void;
    onDelete: (origin?: HTMLElement | null) => void;
}

/**
 * The single owner of the Session resource menu shared by the global sidebar
 * and history-search overlay. Keep item order, labels and action hints here
 * so the two entry points cannot drift.
 */
export default function SessionContextMenu({
    open,
    onClose,
    anchorRef,
    placement = 'bottom-end',
    session,
    deleteProtected,
    onCopySessionId,
    onToggleFavorite,
    onShowStats,
    onDelete,
}: SessionContextMenuProps) {
    const { t } = useTranslation('launcher');

    return (
        <Popover
            open={open}
            onClose={onClose}
            anchorRef={anchorRef}
            placement={placement}
            offset={placement === 'bottom-start' ? 0 : undefined}
            className="session-context-menu global-sidebar-nested-layer w-44 py-1"
        >
            <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                label={t('rightRail.copySessionId')}
                onClick={() => {
                    onClose();
                    void onCopySessionId();
                }}
            />
            <MenuItem
                icon={<Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />}
                label={session.favorite ? t('rightRail.unfavorite') : t('rightRail.favorite')}
                onClick={() => {
                    onClose();
                    void onToggleFavorite();
                }}
            />
            <MenuItem
                icon={<BarChart2 className="h-3.5 w-3.5" />}
                label={t('rightRail.viewStats')}
                onClick={() => {
                    onClose();
                    onShowStats(anchorRef.current);
                }}
            />
            <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label={t('rightRail.delete')}
                tone="danger"
                title={deleteProtected ? t('rightRail.deleteBlockedByOwner') : undefined}
                onClick={() => {
                    onClose();
                    onDelete(anchorRef.current);
                }}
            />
        </Popover>
    );
}
