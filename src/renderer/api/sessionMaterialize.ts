import type { SessionMetadata } from './sessionClient';
import type { SessionSnapshotPatch } from './persistInputOption';
import { sessionSidecarFetch, upgradeSessionId as defaultUpgradeSessionId } from './tauriClient';

export type MaterializePhase = 'prepare' | 'commit' | 'rollback';

export type MaterializeResponse = {
    success?: boolean;
    sessionId?: string;
    metadata?: SessionMetadata;
    error?: string;
};

export type MaterializePostBody = {
    workspacePath: string;
    phase: MaterializePhase;
    preparedSessionId?: string;
    snapshotPatch?: SessionSnapshotPatch;
};

export type MaterializeTransport = {
    postCurrent: (body: MaterializePostBody) => Promise<MaterializeResponse>;
    postForSession?: (sessionId: string, body: MaterializePostBody) => Promise<MaterializeResponse>;
    upgradeSessionId?: (oldSessionId: string, newSessionId: string, tabId: string) => Promise<boolean>;
};

async function postMaterializeForSession(
    targetSessionId: string,
    tabId: string,
    body: MaterializePostBody,
): Promise<MaterializeResponse> {
    const response = await sessionSidecarFetch(
        targetSessionId,
        { type: 'tab', id: tabId },
        '/api/session/materialize',
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        },
    );
    const payload = await response.json().catch(() => ({})) as MaterializeResponse;
    if (!response.ok) {
        throw new Error(payload.error ?? `Materialize request failed with HTTP ${response.status}.`);
    }
    return payload;
}

export async function materializePendingSessionConfig(params: {
    pendingSessionId: string;
    tabId: string;
    workspacePath: string;
    snapshotPatch: SessionSnapshotPatch;
    transport: MaterializeTransport;
}): Promise<{ sessionId: string; metadata: SessionMetadata }> {
    const postCurrent = params.transport.postCurrent;
    const postForSession = params.transport.postForSession
        ?? ((sessionId, body) => postMaterializeForSession(sessionId, params.tabId, body));
    const upgradeSessionId = params.transport.upgradeSessionId ?? defaultUpgradeSessionId;

    const prepare = await postCurrent({
        workspacePath: params.workspacePath,
        phase: 'prepare',
        snapshotPatch: params.snapshotPatch,
    });
    if (!prepare?.success || !prepare.sessionId || !prepare.metadata) {
        throw new Error(prepare?.error ?? 'Failed to prepare pending session materialization.');
    }

    const preparedSessionId = prepare.sessionId;
    let rustUpgraded = false;
    let committed = false;
    try {
        rustUpgraded = await upgradeSessionId(params.pendingSessionId, preparedSessionId, params.tabId);
        if (!rustUpgraded) {
            await postCurrent({
                workspacePath: params.workspacePath,
                phase: 'rollback',
                preparedSessionId,
            }).catch((rollbackError) => {
                console.warn('[sessionMaterialize] rollback after Rust upgrade failure failed:', rollbackError);
            });
            throw new Error(`Failed to upgrade sidecar session id ${params.pendingSessionId} -> ${preparedSessionId}.`);
        }

        const commit = await postForSession(preparedSessionId, {
            workspacePath: params.workspacePath,
            phase: 'commit',
            preparedSessionId,
        });
        if (!commit?.success || !commit.sessionId || !commit.metadata) {
            throw new Error(commit?.error ?? 'Failed to commit pending session materialization.');
        }
        committed = true;
        return { sessionId: commit.sessionId, metadata: commit.metadata };
    } catch (error) {
        if (!committed) {
            if (rustUpgraded) {
                await postForSession(preparedSessionId, {
                    workspacePath: params.workspacePath,
                    phase: 'rollback',
                    preparedSessionId,
                }).catch((rollbackError) => {
                    console.warn('[sessionMaterialize] rollback on target sidecar failed:', rollbackError);
                });
                await upgradeSessionId(preparedSessionId, params.pendingSessionId, params.tabId).catch((rollbackError) => {
                    console.warn('[sessionMaterialize] Rust session id rollback failed:', rollbackError);
                });
            } else {
                await postCurrent({
                    workspacePath: params.workspacePath,
                    phase: 'rollback',
                    preparedSessionId,
                }).catch((rollbackError) => {
                    console.warn('[sessionMaterialize] rollback on pending sidecar failed:', rollbackError);
                });
            }
        }
        throw error;
    }
}
