import { AlertCircle, Check, Copy, ExternalLink, Link, Loader2, RefreshCw, Unlink, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import SubscriptionProviderCardContent from '@/components/SubscriptionProviderCardContent';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { openExternal } from '@/utils/openExternal';
import { copyPlainText } from '@/utils/clipboard';
import {
  cancelGrokLogin,
  getGrokAuthStatus,
  getGrokLoginStatus,
  logoutGrok,
  startGrokLogin,
  verifyGrokAccount,
  type GrokAuthStatus,
  type GrokDeviceLoginView,
} from '@/config/services/grokSubscriptionService';

interface GrokSubscriptionProviderProps {
  onAuthChanged: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function accountLabel(status: GrokAuthStatus | null, fallback: string): string {
  return status?.account?.email ?? status?.account?.displayName ?? fallback;
}

export default function GrokSubscriptionProvider({ onAuthChanged }: GrokSubscriptionProviderProps) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<GrokAuthStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loginView, setLoginView] = useState<GrokDeviceLoginView | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifyingSessionRef = useRef<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const dialogOpenRef = useRef(false);
  const loginGenerationRef = useRef(0);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getGrokAuthStatus();
      if (mountedRef.current) {
        setStatus(next);
        setOperationError(null);
      }
    } catch (error) {
      if (mountedRef.current) setOperationError(errorMessage(error));
    } finally {
      if (mountedRef.current) setLoadingStatus(false);
    }
  }, []);

  const syncProviderState = useCallback(async () => {
    await Promise.all([refreshStatus(), onAuthChanged()]);
  }, [onAuthChanged, refreshStatus]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus();
    return () => {
      mountedRef.current = false;
      loginGenerationRef.current += 1;
      dialogOpenRef.current = false;
      clearPollTimer();
      const activeSession = activeSessionRef.current;
      activeSessionRef.current = null;
      if (activeSession) void cancelGrokLogin(activeSession).catch(() => undefined);
    };
  }, [clearPollTimer, refreshStatus]);

  useEffect(() => {
    if (!dialogOpen || !loginView?.expiresAt || loginView.status !== 'waiting') {
      setRemainingSeconds(0);
      return;
    }
    const updateRemaining = () => {
      setRemainingSeconds(Math.max(0, loginView.expiresAt - Math.floor(Date.now() / 1000)));
    };
    updateRemaining();
    const timer = setInterval(updateRemaining, 1000);
    return () => clearInterval(timer);
  }, [dialogOpen, loginView?.expiresAt, loginView?.status]);

  const closeDialog = useCallback(() => {
    loginGenerationRef.current += 1;
    dialogOpenRef.current = false;
    clearPollTimer();
    const activeSession = loginView && (loginView.status === 'waiting' || loginView.status === 'validating')
      ? loginView.sessionId
      : null;
    setDialogOpen(false);
    setLoginView(null);
    setBusy(false);
    verifyingSessionRef.current = null;
    activeSessionRef.current = null;
    if (activeSession) {
      void cancelGrokLogin(activeSession)
        .then(syncProviderState)
        .catch(error => { if (mountedRef.current) setOperationError(errorMessage(error)); });
    }
  }, [clearPollTimer, loginView, syncProviderState]);

  useCloseLayer(() => {
    if (!dialogOpen) return false;
    closeDialog();
    return true;
  }, 200);

  const runVerification = useCallback(async (sessionId?: string, generation?: number) => {
    if (generation !== undefined
        && (!dialogOpenRef.current || loginGenerationRef.current !== generation)) return;
    if (sessionId && verifyingSessionRef.current === sessionId) return;
    if (sessionId) verifyingSessionRef.current = sessionId;
    setBusy(true);
    try {
      const result = await verifyGrokAccount();
      if (!mountedRef.current
          || (generation !== undefined
            && (!dialogOpenRef.current || loginGenerationRef.current !== generation))) return;
      if (!result.success) throw result.error ?? new Error(t('providers.grok.verificationFailed'));
      await syncProviderState();
      if (!mountedRef.current
          || (generation !== undefined
            && (!dialogOpenRef.current || loginGenerationRef.current !== generation))) return;
      if (sessionId) {
        activeSessionRef.current = null;
        dialogOpenRef.current = false;
        setDialogOpen(false);
        setLoginView(null);
      }
      setOperationError(null);
    } catch (error) {
      if (mountedRef.current) {
        const message = errorMessage(error);
        await syncProviderState().catch(() => undefined);
        if (!mountedRef.current
            || (generation !== undefined
              && (!dialogOpenRef.current || loginGenerationRef.current !== generation))) return;
        setOperationError(message);
        if (sessionId) {
          setLoginView(previous => previous?.sessionId === sessionId
            ? { ...previous, status: 'error', error: { code: 'verification_failed', message } }
            : previous);
        }
      }
    } finally {
      const isCurrent = generation === undefined || loginGenerationRef.current === generation;
      if (sessionId && isCurrent) verifyingSessionRef.current = null;
      if (mountedRef.current && isCurrent) setBusy(false);
    }
  }, [syncProviderState, t]);

  const pollLogin = useCallback(async (sessionId: string, generation: number) => {
    if (!dialogOpenRef.current || loginGenerationRef.current !== generation) return;
    clearPollTimer();
    try {
      const next = await getGrokLoginStatus(sessionId);
      if (!mountedRef.current
          || !dialogOpenRef.current
          || loginGenerationRef.current !== generation) return;
      setLoginView(next);
      if (next.status === 'validating') {
        activeSessionRef.current = sessionId;
        await runVerification(sessionId, generation);
        return;
      }
      if (next.status === 'waiting') {
        activeSessionRef.current = sessionId;
        pollTimerRef.current = setTimeout(
          () => { void pollLogin(sessionId, generation); },
          Math.max(1, next.pollIntervalSeconds) * 1000,
        );
        return;
      }
      if (next.status === 'succeeded') {
        activeSessionRef.current = null;
        await syncProviderState();
        if (mountedRef.current
            && dialogOpenRef.current
            && loginGenerationRef.current === generation) {
          dialogOpenRef.current = false;
          setDialogOpen(false);
        }
      }
    } catch (error) {
      if (mountedRef.current
          && dialogOpenRef.current
          && loginGenerationRef.current === generation) {
        const message = errorMessage(error);
        setOperationError(message);
        setLoginView(previous => previous?.sessionId === sessionId
          ? { ...previous, status: 'error', error: { code: 'poll_failed', message } }
          : previous);
      }
    }
  }, [clearPollTimer, runVerification, syncProviderState]);

  const beginLogin = useCallback(async () => {
    const generation = loginGenerationRef.current + 1;
    loginGenerationRef.current = generation;
    dialogOpenRef.current = true;
    clearPollTimer();
    setDialogOpen(true);
    setLoginView(null);
    setOperationError(null);
    setBusy(true);
    try {
      const view = await startGrokLogin();
      if (!mountedRef.current
          || !dialogOpenRef.current
          || loginGenerationRef.current !== generation) {
        if (view.status === 'waiting' || view.status === 'validating') {
          await cancelGrokLogin(view.sessionId).catch(() => undefined);
        }
        return;
      }
      setLoginView(view);
      activeSessionRef.current = view.status === 'waiting' || view.status === 'validating'
        ? view.sessionId
        : null;
      const loginUrl = view.verificationUriComplete ?? view.verificationUri;
      if (loginUrl) void openExternal(loginUrl);
      if (view.status === 'validating') {
        await runVerification(view.sessionId, generation);
      } else if (view.status === 'waiting') {
        pollTimerRef.current = setTimeout(
          () => { void pollLogin(view.sessionId, generation); },
          Math.max(1, view.pollIntervalSeconds) * 1000,
        );
      }
    } catch (error) {
      if (mountedRef.current && loginGenerationRef.current === generation) {
        setOperationError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current && loginGenerationRef.current === generation) setBusy(false);
    }
  }, [clearPollTimer, pollLogin, runVerification]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await logoutGrok();
      await syncProviderState();
    } catch (error) {
      if (mountedRef.current) setOperationError(errorMessage(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [syncProviderState]);

  const loginUrl = loginView?.verificationUriComplete ?? loginView?.verificationUri;
  const displayAccount = accountLabel(status, t('providers.grok.account'));
  const statusLabel = useMemo(() => {
    if (loadingStatus) return t('providers.grok.checkingStatus');
    if (status?.verified) return displayAccount;
    return t(`providers.grok.states.${status?.state ?? 'logged_out'}`, { defaultValue: t('providers.grok.states.logged_out') });
  }, [displayAccount, loadingStatus, status, t]);
  const visibleError = operationError ?? status?.lastError?.message ?? loginView?.error?.message;
  const remainingLabel = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  const loginFailed = (loginView !== null
      && !['waiting', 'validating', 'succeeded'].includes(loginView.status))
    || (!loginView && !!operationError);

  return (
    <>
      <SubscriptionProviderCardContent
        description={t('providers.grok.description')}
        status={
          <>
            <span className="truncate font-mono text-xs text-[var(--ink-muted)]">{statusLabel}</span>
            {status?.verified && (
              <span className="shrink-0 rounded bg-[var(--success-bg)] px-1.5 py-0.5 text-xs font-medium text-[var(--success)]">
                {t('providers.verified')}
              </span>
            )}
          </>
        }
        actions={
          <>
            {status?.hasGrant && (
              <>
                <button
                  type="button"
                  onClick={() => { void runVerification(); }}
                  disabled={busy}
                  title={t('providers.reverify')}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => { void handleLogout(); }}
                  disabled={busy}
                  title={t('providers.grok.logout')}
                  className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-50"
                >
                  <Unlink className="h-4 w-4" />
                </button>
              </>
            )}
            {!status?.verified && (
              <button
                type="button"
                onClick={() => { void beginLogin(); }}
                disabled={busy || loadingStatus}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link className="h-3.5 w-3.5" />}
                {t('providers.login')}
              </button>
            )}
          </>
        }
        error={visibleError
          ? <p className="break-words text-xs text-[var(--error)]">{visibleError}</p>
          : undefined}
      />

      {dialogOpen && createPortal(
        <OverlayBackdrop onClose={closeDialog} className="z-[200] overflow-y-auto px-4 py-8">
          <div className="w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ink)]">{t('providers.grok.loginTitle')}</h2>
                <p className="mt-1 text-sm text-[var(--ink-muted)]">{t('providers.grok.loginDescription')}</p>
              </div>
              <button type="button" aria-label={t('providers.grok.close')} onClick={closeDialog} className="rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                <X className="h-4 w-4" />
              </button>
            </div>

            {!loginView && !operationError && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('providers.grok.preparingLogin')}
              </div>
            )}

            {loginFailed && (
              <div className="mt-5 rounded-xl border border-[var(--error)] bg-[var(--error-bg)] p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--error)]">
                  <AlertCircle className="h-4 w-4" />
                  {t('providers.grok.loginFailed')}
                </div>
                <p className="mt-2 break-words text-sm text-[var(--ink-muted)]">
                  {operationError ?? loginView?.error?.message ?? t('providers.grok.verificationFailed')}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={closeDialog} className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]">
                    {t('providers.grok.close')}
                  </button>
                  <button type="button" onClick={() => { void beginLogin(); }} className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]">
                    {t('providers.grok.retryLogin')}
                  </button>
                </div>
              </div>
            )}

            {loginView && !loginFailed && (
              <div className="mt-5 space-y-4">
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                    {loginView.status === 'validating'
                      ? <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
                      : <ExternalLink className="h-4 w-4 text-[var(--info)]" />}
                    {loginView.status === 'validating' ? t('providers.grok.validating') : t('providers.grok.browserOpened')}
                  </div>
                  {loginView.userCode && (
                    <div className="mt-4">
                      <p className="text-xs text-[var(--ink-muted)]">{t('providers.grok.deviceCode')}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <code className="flex-1 rounded-lg bg-[var(--paper)] px-3 py-2 text-lg font-semibold tracking-widest text-[var(--ink)]">{loginView.userCode}</code>
                        <button type="button" onClick={() => { void copyPlainText(loginView.userCode ?? '').catch(error => console.warn('[Grok] Failed to copy device code:', error)); }} className="rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]" title={t('providers.grok.copyCode')}>
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {loginUrl && (
                  <div>
                    <p className="text-xs text-[var(--ink-muted)]">{t('providers.grok.loginUrl')}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <button type="button" onClick={() => { void openExternal(loginUrl); }} className="min-w-0 flex-1 truncate rounded-lg border border-[var(--line)] px-3 py-2 text-left text-sm text-[var(--accent)] hover:bg-[var(--paper-inset)]">
                        {loginUrl}
                      </button>
                      <button type="button" onClick={() => { void copyPlainText(loginUrl).catch(error => console.warn('[Grok] Failed to copy login URL:', error)); }} className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" title={t('providers.grok.copyUrl')}>
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
                  <span className="flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
                    {loginView.status === 'waiting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {loginView.status === 'waiting' ? t('providers.grok.waitingForLogin') : t('providers.grok.validating')}
                    {loginView.status === 'waiting' && remainingSeconds > 0 && (
                      <span>· {t('providers.grok.expiresIn', { time: remainingLabel })}</span>
                    )}
                  </span>
                  <button type="button" onClick={closeDialog} className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                    {t('providers.grok.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </OverlayBackdrop>,
        document.body,
      )}
    </>
  );
}
