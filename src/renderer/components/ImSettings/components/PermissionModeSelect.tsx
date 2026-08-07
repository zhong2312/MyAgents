import React from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSION_MODES } from '@/config/types';

export default function PermissionModeSelect({
    value,
    onChange,
    modes,
}: {
    value: string;
	onChange: (mode: string) => void;
    modes?: readonly { value: string; label: string; icon: string; description: string }[];
}) {
    const { t } = useTranslation('settings');
    const displayModes = modes ?? PERMISSION_MODES;
    const usesProductVocabulary = modes === undefined;
    return (
        <div className="space-y-2">
            <div className="space-y-2">
                {displayModes.map((mode) => (
                    <label
                        key={mode.value}
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                            value === mode.value
                                ? 'border-[var(--button-primary-bg)] bg-[var(--paper-inset)]'
                                : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                        }`}
                    >
                        <input
                            type="radio"
                            name="im-permission-mode"
                            value={mode.value}
                            checked={value === mode.value}
                            onChange={() => onChange(mode.value)}
                            className="sr-only"
                        />
                        <div className={`h-4 w-4 flex-shrink-0 rounded-full border-2 transition-colors ${
                            value === mode.value
                                ? 'border-[var(--button-primary-bg)] bg-[var(--button-primary-bg)]'
                                : 'border-[var(--ink-subtle)]'
                        }`}>
                            {value === mode.value && (
                                <div className="flex h-full w-full items-center justify-center">
                                    <div className="h-1.5 w-1.5 rounded-full bg-[var(--toggle-thumb)]" />
                                </div>
                            )}
                        </div>
                        <div>
                            <div className="text-sm font-medium text-[var(--ink)]">
                                {mode.icon} {usesProductVocabulary
                                    ? t(`agentSettings.permission.${mode.value}`, { defaultValue: mode.label })
                                    : mode.label}
                            </div>
                            <p className="text-xs text-[var(--ink-muted)]">
                                {usesProductVocabulary
                                    ? t(`agentSettings.permission.${mode.value}Description`, { defaultValue: mode.description })
                                    : mode.description}
                            </p>
                        </div>
                    </label>
                ))}
            </div>
        </div>
    );
}
