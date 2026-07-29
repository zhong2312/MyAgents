import { createContext, useContext } from 'react';

import type { SessionDeleteResult } from '@/api/tauriClient';

export type DeleteSessionFromApp = (sessionId: string) => Promise<SessionDeleteResult>;

export const SessionDeletionContext = createContext<DeleteSessionFromApp | null>(null);

/**
 * Session deletion is an App capability because App owns the set of mounted
 * Tabs that must detach before Rust can authorize storage mutation.
 */
export function useSessionDeletion(): DeleteSessionFromApp {
    const deleteSession = useContext(SessionDeletionContext);
    if (!deleteSession) {
        throw new Error('useSessionDeletion must be used inside SessionDeletionContext.Provider');
    }
    return deleteSession;
}
