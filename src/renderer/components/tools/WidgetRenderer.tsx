/**
 * WidgetRenderer — Sandboxed iframe container for Generative UI widgets.
 *
 * Handles:
 * - iframe lifecycle (srcdoc, ready detection, onLoad fallback)
 * - postMessage communication (update/finalize/resize/link)
 * - Streaming preview with script stripping + debounce
 * - Height synchronization with first-resize-no-transition optimization
 * - Module-level height cache to survive component remounts (CodePilot Bug #4)
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '@/utils/openExternal';
import { useNotifyRowLayoutChanged } from '@/context/ChatRowLayoutContext';
import { buildWidgetCssVars } from './widgetCssVars';
import { buildSandboxHtml } from './widgetSandboxHtml';
import { detectWidgetLibraries, loadLibrarySources, inlineWidgetLibraries } from './widgetLibraries';
import { useResolvedTheme } from '@/theme';

// ===== Module-level height cache (survives component lifecycle) =====
// Key: first 300 chars of widget_code (past the common <style> prefix).
// Prevents height jump on streaming→final remount. Capped at 100 entries.
const HEIGHT_CACHE_MAX = 100;
const heightCache = new Map<string, number>();

function getCacheKey(widgetCode: string): string {
  return widgetCode.slice(0, 300);
}

function setCacheHeight(key: string, height: number): void {
  if (heightCache.size >= HEIGHT_CACHE_MAX && !heightCache.has(key)) {
    // Evict oldest entry (first inserted)
    const firstKey = heightCache.keys().next().value;
    if (firstKey !== undefined) heightCache.delete(firstKey);
  }
  heightCache.set(key, height);
}

// ===== Script sanitization for streaming preview =====

function sanitizeForStreaming(html: string): string {
  // Remove complete <script>...</script> blocks
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove unclosed <script... tail (prevents half-script showing as visible text)
  const lastScriptOpen = cleaned.toLowerCase().lastIndexOf('<script');
  if (lastScriptOpen !== -1) {
    const hasClose = cleaned.toLowerCase().indexOf('</script>', lastScriptOpen);
    if (hasClose === -1) {
      cleaned = cleaned.substring(0, lastScriptOpen);
    }
  }
  // Remove all on* event handler attributes (quoted, single-quoted, unquoted, backtick)
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*`[^`]*`/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>"'`][^\s>]*/gi, '');
  // Remove javascript: URLs in href/src/action attributes
  cleaned = cleaned.replace(/\s+(href|src|action)\s*=\s*["']?\s*javascript\s*:[^"'>]*/gi, '');
  return cleaned;
}

// ===== Component =====

interface WidgetRendererProps {
  widgetCode: string;
  isStreaming: boolean;
  title: string;
}

const DEBOUNCE_MS = 120;
const MIN_HEIGHT = 60;

export default function WidgetRenderer({ widgetCode, isStreaming, title }: WidgetRendererProps) {
  const { t } = useTranslation('chat');
  const resolvedTheme = useResolvedTheme();
  const themeCss = useMemo(() => buildWidgetCssVars(resolvedTheme), [resolvedTheme]);
  const [initialThemeCss] = useState(themeCss);
  const scriptErrorPrefix = t('shell.toolChrome.widget.scriptErrorPrefix');
  const [initialScriptErrorPrefix] = useState(() => scriptErrorPrefix);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeReady = useRef(false);
  const lastSentHtml = useRef('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFinalized = useRef(false);
  const widgetErrorReports = useRef(0);
  const notifyRowLayoutChanged = useNotifyRowLayoutChanged();
  const lastNotifiedHeight = useRef<number | null>(null);

  // Initialize height from cache or default
  const cacheKey = getCacheKey(widgetCode);
  const [height, setHeight] = useState(() => heightCache.get(cacheKey) ?? MIN_HEIGHT);
  const [firstResize, setFirstResize] = useState(true);

  // Build srcdoc once (CSS vars captured at mount time).
  //
  // The iframe's document URL is `about:srcdoc`. The macOS WKWebView fires the
  // Rust `on_navigation` guard (src-tauri/src/lib.rs) for SUB-FRAME navigations
  // too — not just the top frame — and that guard blocks any scheme outside its
  // allow-list. `about:srcdoc` must therefore be explicitly allowed there, or
  // the sandbox iframe is blocked into an empty document and the widget renders
  // blank (the desktop-only widget-blank bug). about:srcdoc is iframe-only and
  // safe to allow (a top frame can't navigate to attacker-controlled srcdoc).
  // See that guard's comment for the full rationale.
  const srcdoc = useMemo(() => {
    return buildSandboxHtml(initialThemeCss, {
      scriptErrorPrefix: initialScriptErrorPrefix,
    });
  }, [initialScriptErrorPrefix, initialThemeCss]);

  // Send message to iframe
  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Finalize: send the full widget HTML, first swapping any known CDN library
  // <script src> (Chart.js …) for the app's locally-bundled source injected
  // inline — so it runs under the sandbox's 'unsafe-inline' regardless of the
  // inherited CSP (Chromium/WebView2 blocks the external CDN script; see
  // widgetLibraries.ts) and with no network dependency (offline / slow CDN).
  // Async only when a library is actually referenced; text/SVG widgets send
  // synchronously with zero overhead. Library sources are preloaded during the
  // streaming preview (effect below) so this is already resolved at finalize,
  // preserving "render the moment the widget block completes".
  const sendFinalize = useCallback((code: string) => {
    // Mark finalized at the React layer too (not just the iframe's own
    // `!finalized` guard): sendFinalize is only ever the finalize action, and
    // setting this stops the finalize-effect / any other entry point from
    // queuing a second (now async) finalize for the same widget.
    hasFinalized.current = true;
    const libs = detectWidgetLibraries(code);
    if (libs.length === 0) {
      sendToIframe({ type: 'widget:finalize', html: code });
      lastSentHtml.current = code;
      return;
    }
    void loadLibrarySources(libs)
      .then((sources) => inlineWidgetLibraries(code, sources))
      .catch(() => code) // bundling failed → original code (CDN where allowed + visible error)
      .then((html) => {
        sendToIframe({ type: 'widget:finalize', html });
        lastSentHtml.current = html;
      });
  }, [sendToIframe]);

  // Preload bundled library sources as soon as a widget references one (even
  // mid-stream), so the cache is warm by the time it finalizes.
  useEffect(() => {
    const libs = detectWidgetLibraries(widgetCode);
    // Swallow rejection here — a failed preload is retried at finalize (the
    // cache evicts rejects), and sendFinalize has its own fallback. Without the
    // catch a flaky chunk load would surface as a renderer unhandled rejection.
    if (libs.length > 0) void loadLibrarySources(libs).catch(() => {});
  }, [widgetCode]);

  // Handle messages from iframe
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only process messages from our own iframe (prevents cross-widget interference)
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!e.data?.type) return;

      switch (e.data.type) {
        case 'widget:ready':
          iframeReady.current = true;
          sendToIframe({ type: 'widget:i18n', scriptErrorPrefix });
          sendToIframe({ type: 'widget:theme', css: themeCss });
          // If we already have content, send it immediately
          if (widgetCode && !hasFinalized.current) {
            if (isStreaming) {
              const html = sanitizeForStreaming(widgetCode);
              sendToIframe({ type: 'widget:update', html });
              lastSentHtml.current = html;
            } else {
              sendFinalize(widgetCode);
            }
          }
          break;

        case 'widget:resize': {
          const h = Math.max(MIN_HEIGHT, Math.min(4000, Number(e.data.height) || MIN_HEIGHT));
          if (lastNotifiedHeight.current === null || Math.abs(h - lastNotifiedHeight.current) >= 24) {
            notifyRowLayoutChanged('widget-resize');
            lastNotifiedHeight.current = h;
          }
          setHeight(h);
          setCacheHeight(cacheKey, h);
          if (e.data.first) setFirstResize(false);
          break;
        }

        case 'widget:link':
          if (e.data.href && /^https?:|^mailto:/i.test(String(e.data.href))) {
            openExternal(String(e.data.href));
          }
          break;

        case 'widget:error':
          // A script inside the sandboxed widget failed (commonly malformed JS
          // from a weaker model). The iframe shows an inline notice; mirror it
          // here so it also lands in the main console / app logs for debugging
          // instead of being invisible inside the sandbox. Cap + truncate: the
          // message is arbitrary widget-controlled text and console.warn is
          // persisted to the unified log on disk, so a looping/hostile widget
          // (which can postMessage 'widget:error' directly) could flood it.
          if (widgetErrorReports.current < 5) {
            widgetErrorReports.current += 1;
            console.warn(
              `[widget] script failed to run (title=${title || 'untitled'}):`,
              String(e.data.message ?? '').slice(0, 300),
            );
          }
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetCode, isStreaming, sendToIframe, sendFinalize, cacheKey, title, scriptErrorPrefix, notifyRowLayoutChanged, themeCss]);

  useEffect(() => {
    if (!iframeReady.current) return;
    sendToIframe({ type: 'widget:i18n', scriptErrorPrefix });
  }, [scriptErrorPrefix, sendToIframe]);

  // Push the resolved Theme adapter without recreating the iframe or Widget content.
  useEffect(() => {
    if (iframeReady.current) sendToIframe({ type: 'widget:theme', css: themeCss });
  }, [sendToIframe, themeCss]);

  // iframe onLoad fallback for ready race condition (CodePilot Bug #6)
  const onIframeLoad = useCallback(() => {
    if (!iframeReady.current) {
      iframeReady.current = true;
      sendToIframe({ type: 'widget:i18n', scriptErrorPrefix });
      sendToIframe({ type: 'widget:theme', css: themeCss });
      if (widgetCode) {
        if (isStreaming) {
          const html = sanitizeForStreaming(widgetCode);
          sendToIframe({ type: 'widget:update', html });
          lastSentHtml.current = html;
        } else {
          sendFinalize(widgetCode);
        }
      }
    }
  }, [widgetCode, isStreaming, sendToIframe, sendFinalize, scriptErrorPrefix, themeCss]);

  // Streaming update: debounced, script-stripped
  useEffect(() => {
    if (!isStreaming || !iframeReady.current || hasFinalized.current) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const html = sanitizeForStreaming(widgetCode);
      if (html !== lastSentHtml.current) {
        sendToIframe({ type: 'widget:update', html });
        lastSentHtml.current = html;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [widgetCode, isStreaming, sendToIframe]);

  // Finalize: when streaming ends, send full HTML with scripts (bundled libs
  // inlined via sendFinalize).
  useEffect(() => {
    if (!isStreaming && widgetCode && iframeReady.current && !hasFinalized.current) {
      hasFinalized.current = true;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      sendFinalize(widgetCode);
    }
  }, [isStreaming, widgetCode, sendFinalize]);

  // Show skeleton until iframe reports real content height (> MIN_HEIGHT)
  const hasVisibleContent = height > MIN_HEIGHT;
  const showSkeleton = isStreaming && !hasVisibleContent;

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        height: showSkeleton ? undefined : `${height}px`,
        minHeight: showSkeleton ? '48px' : undefined,
        transition: firstResize ? 'none' : 'height 0.15s ease',
      }}
    >
      {/* iframe always mounted (pre-loaded), hidden during skeleton */}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        onLoad={onIframeLoad}
        title={title}
        className="h-full w-full border-none"
        style={{ display: showSkeleton ? 'none' : 'block' }}
      />
      {/* Skeleton: shown until iframe renders visible content */}
      {showSkeleton && (
        <div className="space-y-2.5 py-1">
          <div className="h-3 w-3/4 animate-[shimmer-slide_2s_ease-in-out_infinite] rounded bg-gradient-to-r from-[var(--paper-inset)] via-[var(--paper)] to-[var(--paper-inset)] bg-[length:200%_100%]" />
          <div className="h-3 w-1/2 animate-[shimmer-slide_2s_ease-in-out_infinite_0.2s] rounded bg-gradient-to-r from-[var(--paper-inset)] via-[var(--paper)] to-[var(--paper-inset)] bg-[length:200%_100%]" />
        </div>
      )}
    </div>
  );
}
