import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';

type SessionStoreModule = typeof import('../SessionStore');
type SessionMetadata = import('../types/session').SessionMetadata;

let home: string;
let originalHome: string | undefined;
let store: SessionStoreModule;

const sessionsDir = () => join(home, '.myagents', 'sessions');
const jsonlPath = (id: string) => join(sessionsDir(), `${id}.jsonl`);
const legacyJsonPath = (id: string) => join(sessionsDir(), `${id}.json`);

function managedCodexMeta(id: string, patch: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
        id,
        agentDir: '/tmp/prequery-workspace',
        title: 'New Chat',
        createdAt: '2026-07-06T00:00:00.000Z',
        lastActiveAt: '2026-07-06T00:00:00.000Z',
        unifiedSession: true,
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
        model: 'gpt-5.5',
        providerExecutionIdentity: {
            kind: 'runtime-backed-provider',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            runtime: 'codex',
            runtimeSource: 'managed-provider',
            model: 'gpt-5.5',
        },
        origin: { kind: 'desktop', surface: 'agent_card' },
        stats: {
            messageCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
        },
        ...patch,
    };
}

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'myagents-prequery-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    store = await import('../SessionStore');
});

afterAll(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
});

describe('pre-query session draft visibility', () => {
    it('commits a prepared session on the first real user turn without losing runtime identity', async () => {
        const id = '11111111-1111-4111-8111-111111111111';
        await store.saveSessionMetadata(managedCodexMeta(id, {
            materializationState: 'prepared',
            materializationSourceSessionId: 'pending-tab-a',
        }));

        const committed = await store.commitPreparedSessionForFirstUserTurn(id, {
            messageText: 'hello from managed codex',
            runtimeSessionId: 'codex-thread-1',
            lastActiveAt: '2026-07-14T10:00:00.000Z',
            lastMessagePreview: 'hello from managed codex',
        });

        expect(committed).toEqual(expect.objectContaining({
            id,
            title: 'hello from managed codex',
            titleSource: 'default',
            runtime: 'codex',
            runtimeSource: 'managed-provider',
            runtimeSessionId: 'codex-thread-1',
            lastActiveAt: '2026-07-14T10:00:00.000Z',
            lastMessagePreview: 'hello from managed codex',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            materializationState: undefined,
            materializationSourceSessionId: undefined,
        }));
        expect(committed?.providerExecutionIdentity).toEqual(expect.objectContaining({
            kind: 'runtime-backed-provider',
            runtimeSource: 'managed-provider',
            model: 'gpt-5.5',
        }));
        expect(store.isHistoryVisibleSession(store.getSessionMetadata(id)!)).toBe(true);
    });

    it('hides only legacy empty Managed Codex desktop births', async () => {
        const empty = managedCodexMeta('22222222-2222-4222-8222-222222222222');
        expect(store.isHistoryVisibleSession(empty)).toBe(false);

        const favorite = managedCodexMeta('33333333-3333-4333-8333-333333333333', { favorite: true });
        expect(store.isHistoryVisibleSession(favorite)).toBe(true);

        const channel = managedCodexMeta('44444444-4444-4444-8444-444444444444', {
            origin: { kind: 'agent-channel', surface: 'channel_message' },
        });
        expect(store.isHistoryVisibleSession(channel)).toBe(true);
    });

    it('hides system maintenance sessions from ordinary history', () => {
        const meta = managedCodexMeta('88888888-8888-4888-8888-888888888888', {
            title: 'Memory gardener',
            runtime: 'builtin',
            runtimeSource: undefined,
            providerId: undefined,
            providerExecutionIdentity: undefined,
            origin: { kind: 'automation', surface: 'cron' },
            systemMaintenanceKind: 'memory_gardener',
        });

        expect(store.isHistoryVisibleSession(meta)).toBe(false);
    });

    it('keeps legacy Managed Codex rows visible after a user message exists on disk', () => {
        const id = '55555555-5555-4555-8555-555555555555';
        const meta = managedCodexMeta(id);
        if (!existsSync(sessionsDir())) {
            mkdirSync(sessionsDir(), { recursive: true });
        }
        writeFileSync(jsonlPath(id), '{"id":"u1","role":"user","content":"hello","timestamp":"2026-07-06T00:00:00.000Z"}\n');

        expect(store.isHistoryVisibleSession(meta)).toBe(true);
    });

    it('keeps legacy Managed Codex rows visible when message files are corrupt', () => {
        const id = '66666666-6666-4666-8666-666666666666';
        const meta = managedCodexMeta(id);
        if (!existsSync(sessionsDir())) {
            mkdirSync(sessionsDir(), { recursive: true });
        }
        writeFileSync(jsonlPath(id), '{"role":"user"\n');

        expect(store.isHistoryVisibleSession(meta)).toBe(true);
    });

    it('keeps interrupted JSON to JSONL migrations visible when legacy JSON has user messages', () => {
        const id = '77777777-7777-4777-8777-777777777777';
        const meta = managedCodexMeta(id);
        if (!existsSync(sessionsDir())) {
            mkdirSync(sessionsDir(), { recursive: true });
        }
        writeFileSync(jsonlPath(id), '');
        writeFileSync(legacyJsonPath(id), JSON.stringify({
            messages: [{ id: 'u1', role: 'user', content: 'legacy hello' }],
        }));

        expect(store.isHistoryVisibleSession(meta)).toBe(true);
    });
});
