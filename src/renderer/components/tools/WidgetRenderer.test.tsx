// jsdom + RTL regression test for the generative-UI widget sandbox transport.
//
// Red line (desktop-only widget-blank bug): the widget iframe is served via
// `srcDoc` (document URL `about:srcdoc`), which the Rust on_navigation guard
// (src-tauri/src/lib.rs) explicitly allows. It must NOT switch to a `blob:` /
// `data:` `src` — those schemes are blocked by that guard (they're top-frame
// attack vectors) so the iframe would load an empty document and render blank
// in the macOS WKWebView. If the transport changes, the nav guard's allow-list
// (and its cargo test) must change in lockstep.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

import WidgetRenderer from './WidgetRenderer';

afterEach(() => cleanup());

const CODE = '<style>.x{color:red}</style><div class="x">hi</div>';

describe('WidgetRenderer iframe transport', () => {
  it('serves the sandbox via srcDoc (about:srcdoc), not a blocked blob:/data: src', () => {
    const { container } = render(
      <ThemeRuntimeProvider selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}>
        <WidgetRenderer widgetCode={CODE} isStreaming={false} title="t" />
      </ThemeRuntimeProvider>,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    // srcdoc carries the sandbox receiver document …
    const srcdoc = iframe!.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('widget:ready');
    expect(srcdoc).toContain('id="root"');
    // … and the iframe must NOT use a src= URL (blob:/data: are nav-guard-blocked).
    expect(iframe!.getAttribute('src')).toBeNull();
    // sandbox stays scripts-only (opaque origin, postMessage-only).
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('pushes Theme CSS to the loaded iframe without replacing its document or content', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const view = render(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'light' }}
      >
        <WidgetRenderer widgetCode={CODE} isStreaming title="t" />
      </ThemeRuntimeProvider>,
    );
    const iframe = view.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');
    fireEvent.load(iframe);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'widget:theme',
      css: expect.stringContaining('--widget-text: #21002f;'),
    }), '*');

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: syntheticTheme.id, appearanceMode: 'dark' }}
      >
        <WidgetRenderer widgetCode={CODE} isStreaming title="t" />
      </ThemeRuntimeProvider>,
    );

    expect(view.container.querySelector('iframe')).toBe(iframe);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'widget:theme',
      css: expect.stringContaining('--widget-text: #ffe8ff;'),
    }), '*');

    view.rerender(
      <ThemeRuntimeProvider
        registry={registry}
        selection={{ themeId: 'myagents-default', appearanceMode: 'light' }}
      >
        <WidgetRenderer widgetCode={CODE} isStreaming title="t" />
      </ThemeRuntimeProvider>,
    );

    expect(view.container.querySelector('iframe')).toBe(iframe);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'widget:theme',
      css: expect.stringContaining('--widget-text: #1c1612;'),
    }), '*');
    expect(postMessage).not.toHaveBeenLastCalledWith(expect.objectContaining({
      css: expect.stringContaining('synthetic-'),
    }), '*');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'widget:finalize' }), '*');
  });
});
