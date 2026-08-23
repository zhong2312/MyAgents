import type { ChannelSurface } from '@/hooks/useSessionSurfaces';
import { i18n } from '@/i18n';

interface ChannelBoundSessionTransitionOptions {
  sessionId: string;
  tabId: string;
  boundChannel: ChannelSurface;
  migrateChannelToNewSession: (args: { oldSessionId: string; tabId: string; sessionKey: string }) => Promise<string | null>;
  adoptMigratedSession: (newSessionId: string, options: { sidecarAlreadyMigrated: true }) => Promise<boolean>;
  releaseMigratedTabOwner: (sessionId: string, tabId: string) => Promise<unknown>;
  reportError: (message: string) => void;
}

function channelTransitionError(): string {
  return String(i18n.t('chat:shell.toasts.channelRebindFailedNewCancelled'));
}

/**
 * Move a channel-bound desktop tab to a fresh session.
 *
 * Migration is fail-closed. A plain `/chat/reset` would bypass Rust's exact
 * Tab + Agent admission and can split Runtime identity from owner identity.
 */
export async function transitionChannelBoundSession(
  options: ChannelBoundSessionTransitionOptions,
): Promise<boolean> {
  const {
    sessionId,
    tabId,
    boundChannel,
    migrateChannelToNewSession,
    adoptMigratedSession,
    releaseMigratedTabOwner,
    reportError,
  } = options;
  let migratedSessionId: string | null = null;

  try {
    migratedSessionId = await migrateChannelToNewSession({
      oldSessionId: sessionId,
      tabId,
      sessionKey: boundChannel.sessionKey,
    });

    if (!migratedSessionId) {
      console.warn('[Chat] migrateChannelToNewSession returned null');
      reportError(channelTransitionError());
      return false;
    }

    console.log(`[Chat] Channel-bound new conversation: ${sessionId.slice(0, 8)} -> ${migratedSessionId.slice(0, 8)}`);
    const adopted = await adoptMigratedSession(migratedSessionId, { sidecarAlreadyMigrated: true });
    if (!adopted) {
      throw new Error(`Failed to adopt migrated channel session ${migratedSessionId}.`);
    }
    return true;
  } catch (err) {
    console.error('[Chat] Channel surface migration failed:', err);
    if (migratedSessionId) {
      await releaseMigratedTabOwner(migratedSessionId, tabId).catch((releaseError) => {
        console.error('[Chat] Failed to release migrated Tab owner after adoption failure:', releaseError);
      });
    }
    reportError(channelTransitionError());
    return false;
  }
}
