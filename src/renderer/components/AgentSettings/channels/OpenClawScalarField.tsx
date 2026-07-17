import CustomSelect from '@/components/CustomSelect';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import {
    coerceOpenClawConfigValue,
    isOpenClawConfigValueInvalid,
    type OpenClawSchemaField,
} from './openclawConfigScalars';

interface OpenClawScalarFieldProps {
    name: string;
    field: OpenClawSchemaField;
    value: unknown;
    required?: boolean;
    placeholder?: string;
    onChange: (value: unknown) => void;
}

export default function OpenClawScalarField({
    name,
    field,
    value,
    required = false,
    placeholder,
    onChange,
}: OpenClawScalarFieldProps) {
    const { t } = useTranslation('settings');
    const inputId = useId();
    const displayName = t(`agentSettings.channelDetail.configFields.${name}`, {
        defaultValue: field.title?.trim() || name,
    });
    const label = (
        <label htmlFor={field.enum?.length ? undefined : inputId} className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
            {displayName}
            {required && <span className="ml-1 text-[var(--error)]">*</span>}
        </label>
    );

    if (field.type === 'boolean') {
        const checked = coerceOpenClawConfigValue(value, field) === true;
        return (
            <div>
                {label}
                {field.description && (
                    <p className="mb-2 text-xs text-[var(--ink-muted)]">{field.description}</p>
                )}
                <button
                    type="button"
                    id={inputId}
                    role="switch"
                    aria-label={displayName}
                    aria-checked={checked}
                    onClick={() => onChange(!checked)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none ${
                        checked ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                    }`}
                >
                    <span
                        className={`pointer-events-none absolute left-0.5 top-0.5 inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                            checked ? 'translate-x-5' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>
        );
    }

    if (field.enum?.length) {
        return (
            <div>
                {label}
                {field.description && (
                    <p className="mb-1 text-xs text-[var(--ink-muted)]">{field.description}</p>
                )}
                <CustomSelect
                    value={String(value ?? '')}
                    options={field.enum.map(option => ({ value: String(option), label: String(option) }))}
                    onChange={(selected) => onChange(coerceOpenClawConfigValue(selected, field))}
                    placeholder={placeholder}
                    size="md"
                />
            </div>
        );
    }

    const isNumber = field.type === 'number' || field.type === 'integer';
    const invalid = isOpenClawConfigValueInvalid(value, field);
    const errorId = `${inputId}-error`;
    return (
        <div>
            {label}
            {field.description && (
                <p className="mb-1 text-xs text-[var(--ink-muted)]">{field.description}</p>
            )}
            <input
                id={inputId}
                type={isNumber ? 'number' : /secret|token|password|key/i.test(name) ? 'password' : 'text'}
                step={field.type === 'integer' ? 1 : undefined}
                value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                onChange={(event) => onChange(event.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? errorId : undefined}
                placeholder={placeholder}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] transition-colors focus:border-[var(--button-primary-bg)] focus:outline-none"
            />
            {invalid && (
                <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--error)]">
                    {t(field.type === 'integer'
                        ? 'agentSettings.channelDetail.integerRequired'
                        : 'agentSettings.channelDetail.numberRequired')}
                </p>
            )}
        </div>
    );
}
