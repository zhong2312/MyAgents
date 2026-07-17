export type OpenClawSchemaField = {
    type?: string;
    title?: string;
    description?: string;
    enum?: unknown[];
    default?: unknown;
};

export type OpenClawSchemaProperties = Record<string, OpenClawSchemaField>;

export function inferOpenClawSchemaField(value: unknown): OpenClawSchemaField {
    if (typeof value === 'boolean') return { type: 'boolean' };
    if (typeof value === 'number') return { type: 'number' };
    return { type: 'string' };
}

export function mergeOpenClawSchemaProperties(
    manifestProperties: OpenClawSchemaProperties | undefined,
    defaults: Record<string, unknown> | undefined,
): OpenClawSchemaProperties {
    const merged = { ...(manifestProperties ?? {}) };
    for (const [key, value] of Object.entries(defaults ?? {})) {
        if (!merged[key]) merged[key] = inferOpenClawSchemaField(value);
    }
    return merged;
}

export function isOpenClawConfigValueMissing(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

export function isOpenClawConfigValueInvalid(
    value: unknown,
    field: OpenClawSchemaField | undefined,
): boolean {
    if (isOpenClawConfigValueMissing(value)) return false;
    if (field?.type !== 'number' && field?.type !== 'integer') return false;
    if (typeof value === 'number') return !Number.isFinite(value);
    if (typeof value !== 'string' || !value.trim()) return true;
    const parsed = Number(value);
    return !Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed));
}

export function coerceOpenClawConfigValue(
    value: unknown,
    field: OpenClawSchemaField | undefined,
): unknown {
    if (field?.enum) {
        return field.enum.find(option => String(option) === String(value)) ?? value;
    }
    if (field?.type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    }
    if (field?.type === 'number' || field?.type === 'integer') {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && (field.type !== 'integer' || Number.isInteger(parsed))) {
                return parsed;
            }
        }
    }
    return typeof value === 'string' ? value.trim() : value;
}

export function buildTypedOpenClawConfig(
    values: Record<string, unknown>,
    schema: OpenClawSchemaProperties,
    customFields: Array<{ key: string; value: string }> = [],
): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
        if (isOpenClawConfigValueMissing(value) || isOpenClawConfigValueInvalid(value, schema[key])) continue;
        config[key] = coerceOpenClawConfigValue(value, schema[key]);
    }
    for (const field of customFields) {
        const key = field.key.trim();
        const value = field.value.trim();
        if (key && value) config[key] = value;
    }
    return config;
}
