import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { GroupPermission } from '../../../../shared/types/im';

export default function GroupPermissionList({
    permissions,
    onApprove,
    onReject,
    onRemove,
}: {
    permissions: GroupPermission[];
    onApprove: (groupId: string) => Promise<void>;
    onReject: (groupId: string) => Promise<void>;
    onRemove: (groupId: string) => Promise<void>;
}) {
    const { t } = useTranslation('settings');
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const [loading, setLoading] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const pending = permissions.filter(p => p.status === 'pending');
    const approved = permissions.filter(p => p.status === 'approved');

    const handleAction = async (action: () => Promise<void>, groupId: string) => {
        setLoading(groupId);
        setError(null);
        try {
            await action();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            console.error('[GroupPermission] Action failed:', msg);
        } finally {
            setLoading(null);
        }
    };

    return (
        <div className="space-y-3">
            {/* Error display */}
            {error && (
                <p className="text-xs text-[var(--error)]">{error}</p>
            )}

            {/* Pending groups */}
            {pending.length > 0 && (
                <div className="space-y-2">
                    <label className="text-xs font-medium text-[var(--warning)]">
                        {t('agentSettings.imComponents.pendingReview')}
                    </label>
                    {pending.map(g => (
                        <div
                            key={g.groupId}
                            className="flex items-center justify-between rounded-lg border border-[var(--warning)]/20 bg-[var(--warning)]/5 px-3 py-2"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-[var(--ink)]">{g.groupName}</p>
                                <p className="text-xs text-[var(--ink-muted)]">
	                                    {g.platform === 'telegram' ? 'Telegram' : g.platform === 'dingtalk' ? '钉钉' : '飞书'}
                                    {g.addedBy && ` · ${t('agentSettings.imComponents.addedBy', { name: g.addedBy })}`}
                                </p>
                            </div>
                            <div className="ml-3 flex items-center gap-1.5">
                                <button
                                    onClick={() => handleAction(() => onApprove(g.groupId), g.groupId)}
                                    disabled={loading === g.groupId}
                                    className="rounded-md bg-[var(--accent)] p-1.5 text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                                    title={t('agentSettings.imComponents.allow')}
                                >
                                    <Check className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    onClick={() => handleAction(() => onReject(g.groupId), g.groupId)}
                                    disabled={loading === g.groupId}
                                    className="rounded-md bg-[var(--paper-inset)] p-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--error)] disabled:opacity-50"
                                    title={t('agentSettings.imComponents.reject')}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Approved groups */}
            {approved.length > 0 && (
                <div className="space-y-2">
                    <label className="text-xs font-medium text-[var(--ink-muted)]">
                        {t('agentSettings.imComponents.approvedGroups')}
                    </label>
                    {approved.map(g => (
                        <div
                            key={g.groupId}
                            className="group flex items-center justify-between rounded-lg bg-[var(--paper-inset)] px-3 py-2"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-[var(--ink)]">{g.groupName}</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    {g.platform === 'telegram' ? 'Telegram' : g.platform === 'dingtalk' ? '钉钉' : '飞书'}
                                </p>
                            </div>
                            <button
                                onClick={() => setConfirmRemove(g.groupId)}
                                className="ml-3 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100"
                                title={t('agentSettings.imComponents.remove')}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Empty state */}
            {permissions.length === 0 && (
                <p className="text-xs text-[var(--ink-muted)]">
                    {t('agentSettings.imComponents.groupsEmpty')}
                </p>
            )}

            {/* Remove confirmation */}
            {confirmRemove && (
                <ConfirmDialog
                    title={t('agentSettings.imComponents.removeGroupTitle')}
                    message={t('agentSettings.imComponents.removeGroupMessage', {
                        name: approved.find(g => g.groupId === confirmRemove)?.groupName ?? confirmRemove,
                    })}
                    confirmText={t('agentSettings.imComponents.removeGroupConfirm')}
                    cancelText={t('agentSettings.botRegistry.cancel')}
                    confirmVariant="danger"
                    onConfirm={async () => {
                        try {
                            await onRemove(confirmRemove);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            setError(msg);
                        } finally {
                            setConfirmRemove(null);
                        }
                    }}
                    onCancel={() => setConfirmRemove(null)}
                />
            )}
        </div>
    );
}
