/**
 * OS notification service.
 *
 * Front-end's only job here is "should we ask the OS to show a toast right
 * now?" — gating on user focus and throttling. The actual toast rendering and
 * (critically) click handling live in Rust (`notification.rs`), so the
 * `tab_id` deep-link path is structural rather than a JS-side time-window
 * race.
 *
 * Why no `@tauri-apps/plugin-notification` import: that package's
 * `sendNotification` returns void on desktop and never gives us a handle to
 * attach `onclick`, so click activation always silently failed on Windows.
 * The Rust module bypasses the plugin's JS shim and uses
 * `tauri-winrt-notification`'s `Toast::on_activated` directly.
 */

import { invoke } from '@tauri-apps/api/core';

import { i18n } from '@/i18n';
import { isTauriEnvironment } from '../utils/browserMock';

let lastNotifyTime = 0;
const NOTIFY_THROTTLE_MS = 3000;

let isWindowVisible = true;

/**
 * Update window visibility state.
 * Called by useTrayEvents when window is hidden/shown.
 */
export function setWindowVisible(visible: boolean): void {
    isWindowVisible = visible;
    console.log('[Notification] Window visibility updated:', visible);
}

/**
 * Returns true when the user isn't actively looking at the app, so a system
 * notification is worth showing.
 */
export function shouldNotifyUser(): boolean {
    if (!isWindowVisible) return true;
    if (document.hidden) return true;
    if (!document.hasFocus()) return true;
    return false;
}

async function notify(title: string, body?: string, tabId?: string): Promise<void> {
    if (!isTauriEnvironment()) return;
    if (!shouldNotifyUser()) return;

    const now = Date.now();
    if (now - lastNotifyTime < NOTIFY_THROTTLE_MS) return;
    lastNotifyTime = now;

    try {
        await invoke('cmd_show_notification', {
            title,
            body: body ?? '',
            tabId: tabId ?? null,
            sessionId: null,
            workspacePath: null,
        });
    } catch (error) {
        console.warn('[Notification] cmd_show_notification failed:', error);
    }
}

function notificationText(key: string, options?: Record<string, unknown>): string {
    return String(i18n.t(`app:notifications.${key}`, options));
}

/**
 * Notify that a cron task has completed.
 * Used by the cron path that originates inside Rust — kept on the front-end
 * surface for symmetry, but the cron module emits via Rust directly so the
 * normal flow doesn't pass through this function.
 */
export function notifyCronTaskComplete(title: string, body: string, tabId?: string): void {
    void notify(title, body, tabId);
}

export function notifyPermissionRequest(toolName: string): void {
    void notify(notificationText('permissionTitle'), notificationText('permissionBody', { toolName }));
}

export function notifyAskUserQuestion(): void {
    void notify(notificationText('askUserTitle'), notificationText('askUserBody'));
}

export function notifyPlanModeRequest(): void {
    void notify(notificationText('planModeTitle'), notificationText('planModeBody'));
}

/**
 * Tell Rust the window has just been activated externally — flushes any
 * pending click target the front-end didn't yet receive (covers macOS / Linux
 * where the OS auto-activates the app on toast click but no in-process
 * Activated callback fires).
 */
export async function consumePendingNotificationClick(): Promise<boolean> {
    if (!isTauriEnvironment()) return false;
    try {
        return await invoke<boolean>('cmd_consume_notification_click');
    } catch (error) {
        console.warn('[Notification] cmd_consume_notification_click failed:', error);
        return false;
    }
}

/**
 * Initialize notification service.
 *
 * Permission flow is intentionally absent: desktop OS notifications under
 * `tauri-plugin-notification` and the WinRT path don't require a runtime
 * permission grant — macOS / Linux rely on system-level settings,
 * Windows uses AUMID via NSIS shortcut. Anything we'd do here would just be
 * theatre.
 */
export async function initNotificationService(): Promise<void> {
    // No-op kept for symmetry with existing call sites.
}
