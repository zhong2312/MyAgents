import { describe, expect, it } from 'vitest';

import {
    buildTypedOpenClawConfig,
    isOpenClawConfigValueInvalid,
    isOpenClawConfigValueMissing,
    mergeOpenClawSchemaProperties,
} from './openclawConfigScalars';

describe('OpenClaw config scalar typing', () => {
    it('keeps booleans and numbers typed while custom keys remain strings', () => {
        expect(buildTypedOpenClawConfig(
            { streaming: false, retries: '3', name: ' Lark ' },
            {
                streaming: { type: 'boolean' },
                retries: { type: 'integer' },
                name: { type: 'string' },
            },
            [{ key: 'custom', value: ' 001 ' }],
        )).toEqual({ streaming: false, retries: 3, name: 'Lark', custom: '001' });
    });

    it('does not treat false or zero as missing and rejects invalid schema numbers', () => {
        expect(isOpenClawConfigValueMissing(false)).toBe(false);
        expect(isOpenClawConfigValueMissing(0)).toBe(false);
        expect(isOpenClawConfigValueInvalid('1.5', { type: 'number' })).toBe(false);
        expect(isOpenClawConfigValueInvalid('1.5', { type: 'integer' })).toBe(true);
        expect(buildTypedOpenClawConfig(
            { retries: '' },
            { retries: { type: 'integer' } },
        )).toEqual({});
    });

    it('adds typed promoted defaults without overriding manifest schema', () => {
        expect(mergeOpenClawSchemaProperties(
            { streaming: { type: 'boolean', description: 'manifest' } },
            { streaming: true, timeout: 30 },
        )).toEqual({
            streaming: { type: 'boolean', description: 'manifest' },
            timeout: { type: 'number' },
        });
    });
});
