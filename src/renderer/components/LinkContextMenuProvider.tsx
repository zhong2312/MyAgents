import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';

import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useToast } from './Toast';
import { isExternalUrl, openExternal } from '@/utils/openExternal';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { copyPlainText } from '@/utils/clipboard';

// Global delegated right-click handler for external `<a href="…">` links.
//
// Why this exists: the main webview's WKWebView native context menu has an
// "Open Link" entry that triggers a top-frame navigation directly — bypassing
// React `onClick` and `e.preventDefault()` in MarkdownLink. Without this
// provider (and the matching Rust `on_navigation` safety net), the entire
// app gets navigated to an external URL with no way back (issue: right-click
// on link → 软件报废).
//
// Behavior: this provider attaches a single capture-phase `contextmenu`
// listener on `document`. When the event target is inside `a[href]` and the
// href is an external URL (http/https/mailto), it suppresses the native menu
// and renders a custom one with three actions:
//   - 预览（内置浏览器）：dispatch CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL.
//     Active Chat tab listens; if its split BrowserPanel is available, it
//     calls preventDefault() to claim the action. Otherwise we fall back to
//     openExternal so the action always feels responsive.
//   - 拷贝链接：cross-WebView clipboard helper + toast feedback.
//   - 在系统浏览器中打开：openExternal (existing routing).
// Non-external anchors (in-page #anchors, file paths) keep their default
// browser behavior — no interception.
interface MenuState {
    x: number;
    y: number;
    href: string;
}

export default function LinkContextMenuProvider({ children }: { children: React.ReactNode }) {
    const { t } = useTranslation('app');
    const [menu, setMenu] = useState<MenuState | null>(null);
    const toast = useToast();

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
            if (!anchor) return;
            // Prefer the raw attribute (preserves original URL string) over
            // the resolved property which absolutizes relative paths.
            const href = anchor.getAttribute('href') ?? '';
            if (!href || !isExternalUrl(href)) return;

            e.preventDefault();
            // stopImmediatePropagation defeats main.tsx's "block dev tools menu"
            // capture listener which would otherwise still run and observe
            // the (already-prevented) event — harmless today but keeps the
            // contract that no other capture handler sees link contextmenus.
            e.stopImmediatePropagation();
            setMenu({ x: e.clientX, y: e.clientY, href });
        };
        document.addEventListener('contextmenu', handler, true);
        return () => document.removeEventListener('contextmenu', handler, true);
    }, []);

    const closeMenu = () => setMenu(null);

    const items: ContextMenuItem[] = menu
        ? [
              ...(/^https?:\/\//i.test(menu.href) ? [{
                  label: t('linkContext.previewInternal'),
                  onClick: () => {
                      const url = menu.href;
                      const event = new CustomEvent(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, {
                          detail: { url },
                          cancelable: true,
                      });
                      window.dispatchEvent(event);
                      // No active Chat tab claimed the action — fall back to
                      // system browser so the click never feels dead.
                      if (!event.defaultPrevented) {
                          void openExternal(url);
                      }
                  },
              } satisfies ContextMenuItem] : []),
              {
                  label: t('linkContext.copyLink'),
                  onClick: () => {
                      copyPlainText(menu.href).then(
                          () => toast.success(t('linkContext.copied')),
                          () => toast.error(t('linkContext.copyFailed')),
                      );
                  },
              },
              {
                  label: t('linkContext.openSystem'),
                  onClick: () => {
                      void openExternal(menu.href);
                  },
              },
          ]
        : [];

    return (
        <>
            {children}
            {menu &&
                createPortal(
                    <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />,
                    document.body,
                )}
        </>
    );
}
