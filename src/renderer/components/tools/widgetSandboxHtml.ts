/**
 * Sandbox iframe receiver HTML for Generative UI widgets.
 *
 * This HTML is injected as the iframe's `srcdoc`. It:
 * - Sets a strict CSP: 4 CDN domains for scripts, no connect-src, and Google
 *   Fonts (fonts.googleapis.com stylesheet + fonts.gstatic.com woff2 — both hops
 *   needed) for decorative web fonts. On WebKit THIS meta CSP governs the iframe
 *   (the parent app CSP isn't inherited); on Chromium/WebView2 the srcdoc also
 *   intersects the parent CSP, so tauri.conf.json must list the same font hosts.
 * - Listens for postMessage commands: widget:update (streaming), widget:finalize (final)
 * - Reports height changes back to the parent via widget:resize
 * - Intercepts link clicks and forwards them to the parent via widget:link
 */

import { i18n } from '@/i18n';

export function buildSandboxHtml(
  cssVarsBlock: string,
  options: { scriptErrorPrefix?: string } = {},
): string {
  const scriptErrorPrefix = JSON.stringify(
    options.scriptErrorPrefix ?? String(i18n.t('chat:shell.toolChrome.widget.scriptErrorPrefix')),
  );
  // The receiver template. All dynamic content arrives via postMessage.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh; img-src data: https:; font-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.gstatic.com;">
<style>
${cssVarsBlock}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
/* body = host prose tier (16px/1.7, DESIGN.md §2.2) — keep in lockstep with
   --text-base / --text-base--line-height in index.css @theme. The size values
   below (headings + .text-* utilities) are ALSO quoted in the widget design
   contract prompt (src/server/tools/generative-ui-tool.ts SECTION_CORE);
   change one → sync the other. */
body { font-family: var(--widget-font-body); font-size: 16px; line-height: 1.7; color: var(--widget-text); }
#root { min-height: 20px; }

/* Pre-styled form elements — AI writes bare tags, they look polished */
input[type="text"], input[type="number"], select, textarea {
  font-family: inherit; font-size: 14px; line-height: 1.5;
  padding: 8px 12px; border: 1px solid var(--widget-border); border-radius: var(--widget-radius-control);
  background: var(--widget-bg-elevated); color: var(--widget-text);
  outline: none; transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: var(--widget-accent); }
input[type="range"] {
  width: 100%; height: 6px; -webkit-appearance: none; appearance: none;
  background: var(--widget-border); border-radius: var(--widget-radius-track); outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 18px; height: 18px; border-radius: var(--widget-radius-full);
  background: var(--widget-accent); cursor: pointer; border: 2px solid var(--widget-primary-text);
  box-shadow: var(--widget-control-shadow);
}
button {
  font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  padding: 8px 16px; border-radius: var(--widget-radius-control); border: 1px solid var(--widget-border);
  background: var(--widget-bg-elevated); color: var(--widget-text);
  transition: all 0.15s;
}
button:hover { border-color: var(--widget-border-strong); }
button.primary {
  background: var(--widget-accent); color: var(--widget-primary-text); border-color: var(--widget-accent);
}
button.primary:hover { opacity: 0.9; }
label { font-size: 12px; font-weight: 600; color: var(--widget-text-secondary); display: block; margin-bottom: 4px; }

/* Heading reset — widgets are embedded cards, one step below the host's
   Markdown heading ladder (host H1=22). Without this, a bare <h1>/<h2> falls
   through to browser defaults (h1=2em/700) — larger than the host app's own
   H1 and violating the widget design contract's "never 700" weight rule. */
h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 0 0 8px; line-height: 1.3; color: var(--widget-text); }
h1 { font-size: 20px; }
h2 { font-size: 18px; }
h3 { font-size: 16px; }
h4, h5, h6 { font-size: 14px; }
p { margin: 0 0 8px; }

/* Layout utilities — AI can use these classes */
.flex { display: flex; } .flex-col { flex-direction: column; }
.items-center { align-items: center; } .justify-center { justify-content: center; } .justify-between { justify-content: space-between; }
.gap-2 { gap: 8px; } .gap-3 { gap: 12px; } .gap-4 { gap: 16px; } .gap-6 { gap: 24px; }
.grid { display: grid; }
.grid-2 { grid-template-columns: repeat(2, 1fr); } .grid-3 { grid-template-columns: repeat(3, 1fr); } .grid-4 { grid-template-columns: repeat(4, 1fr); }
.p-2 { padding: 8px; } .p-3 { padding: 12px; } .p-4 { padding: 16px; }
.px-3 { padding-left: 12px; padding-right: 12px; } .py-2 { padding-top: 8px; padding-bottom: 8px; }
.m-0 { margin: 0; } .mt-2 { margin-top: 8px; } .mt-4 { margin-top: 16px; } .mb-2 { margin-bottom: 8px; } .mb-4 { margin-bottom: 16px; }
.w-full { width: 100%; } .text-center { text-align: center; }
/* Text utilities mirror the host app's type scale (v2.5: xs=12 / sm=14 /
   lg=18 / xl=20 / 2xl=22) so widget text never reads a tier different from
   the same class in the host UI. Big stand-alone numbers should use
   .stat-value, not .text-2xl. */
.text-sm { font-size: 14px; } .text-xs { font-size: 12px; } .text-lg { font-size: 18px; } .text-xl { font-size: 20px; } .text-2xl { font-size: 22px; }
.font-semibold { font-weight: 600; } .font-normal { font-weight: 400; }
.rounded { border-radius: var(--widget-radius-control); } .rounded-lg { border-radius: var(--widget-radius-card); }
.border { border: 1px solid var(--widget-border); }
.bg-elevated { background: var(--widget-bg-elevated); }
.bg-inset { background: var(--widget-bg-inset); }
.text-muted { color: var(--widget-text-muted); }
.text-secondary { color: var(--widget-text-secondary); }
.text-accent { color: var(--widget-accent); }
.overflow-hidden { overflow: hidden; }
.relative { position: relative; } .absolute { position: absolute; }
.flex-wrap { flex-wrap: wrap; } .flex-1 { flex: 1; }
.cursor-pointer { cursor: pointer; }

/* Stat card pattern */
.stat-card { background: var(--widget-bg-elevated); border-radius: var(--widget-radius-card); padding: 16px; border: 1px solid var(--widget-border); }
.stat-value { font-size: 24px; font-weight: 600; color: var(--widget-text); }
.stat-label { font-size: 12px; color: var(--widget-text-muted); margin-top: 4px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  var root = document.getElementById('root');
  var currentHtml = '';
  var finalized = false;

  // Height reporting via ResizeObserver
  var lastHeight = 0;
  var firstResize = true;
  function reportHeight() {
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      window.parent.postMessage({ type: 'widget:resize', height: h, first: firstResize }, '*');
      firstResize = false;
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(root);
  }
  // Also report on load and after script execution
  window.addEventListener('load', reportHeight);

  // Link interception — open in parent's system browser
  document.addEventListener('click', function(e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (a && a.href) {
      e.preventDefault();
      window.parent.postMessage({ type: 'widget:link', href: a.href }, '*');
    }
  });

  // Surface a widget script failure instead of rendering a silent blank box.
  //
  // A weaker / non-Claude model routinely emits a widget whose inline JS is
  // malformed — e.g. an unbalanced brace in a Chart config (DeepSeek shipped a
  // chart whose options object was missing one closing brace). The parse or
  // runtime error is thrown INSIDE this
  // sandboxed iframe, so it never reaches the parent [REACT] console or the
  // app's unified log: the user just sees an empty box with no clue why, and a
  // maintainer burns a long investigation rediscovering "the model wrote broken
  // JS". We can't fix the model's code, but we can make the failure visible
  // (an inline notice) and resilient (one bad script no longer aborts the rest
  // of the widget). The error is also forwarded to the parent so it lands in
  // the main console / logs.
  var widgetErrored = false;
  var errorReports = 0;
  var widgetScriptErrorPrefix = ${scriptErrorPrefix};
  function showWidgetError(msg) {
    var text = String(msg || 'script error');
    // Bound parent-log spam: a widget whose error repeats (e.g. throws every
    // animation frame) shouldn't flood the main console — surface the first few.
    if (errorReports < 3) {
      errorReports++;
      try { window.parent.postMessage({ type: 'widget:error', message: text }, '*'); } catch (e) {}
    }
    if (widgetErrored) return; // one notice per widget, even if several scripts fail
    widgetErrored = true;
    var note = document.createElement('div');
    note.setAttribute('data-widget-error', '');
    note.style.cssText = 'margin-top:8px;padding:8px 12px;border-radius:var(--widget-radius-control);font-size:12px;line-height:1.5;'
      + 'background:var(--widget-bg-inset);border:1px solid var(--widget-border);color:var(--widget-text-muted);';
    // Engines often mask the detail to a generic "Script error." for sandboxed
    // scripts, so lead with a self-explanatory line and append whatever detail
    // the engine did give.
    note.textContent = '⚠️ ' + widgetScriptErrorPrefix + text;
    root.appendChild(note);
    reportHeight();
  }
  // Most engines report a dynamically-inserted inline script's parse error (and
  // any runtime error) asynchronously on window 'error' rather than throwing at
  // the insertion site; this catches those. The synchronous-throw engines
  // (WebKit) are covered by the try/catch around replaceChild in runScripts.
  window.addEventListener('error', function(e) {
    showWidgetError(e && e.message ? e.message : 'script error');
  });
  // Async failures (e.g. a widget that fetches data and the promise rejects)
  // don't reach the 'error' listener — surface those too.
  window.addEventListener('unhandledrejection', function(e) {
    var r = e && e.reason;
    showWidgetError(r && r.message ? r.message : 'unhandled promise rejection');
  });

  // Execute script tags in document order (innerHTML doesn't run them).
  //
  // A DOM-inserted <script src> loads ASYNCHRONOUSLY and does NOT block the
  // next script — unlike a parser-inserted one. So replacing every <script> in
  // one synchronous pass runs an inline "new Chart(...)" BEFORE the CDN
  // chart.js it depends on has loaded → "Chart is not defined" (thrown inside
  // this iframe, invisible to the parent console) → blank widget. Contract-
  // compliant widgets dodge it via the documented onload="init()" + window.Lib
  // fallback, but weaker / non-Claude models routinely emit the naive shape
  // (issue #221: widgets blank on GLM etc.).
  //
  // Fix: walk scripts sequentially and BLOCK on each external script's load
  // before running the next — replicating native parser-blocking order, so an
  // inline script that references a CDN global always runs after it loads. We
  // chain via load/error listeners and drop the script's own on* handler
  // attributes: with external-before-inline guaranteed, the inline
  // "if(window.Lib)init()" fallback covers init, while a stale onload="init()"
  // firing before the inline defines init would otherwise throw or double-run.
  function runScripts() {
    var scripts = Array.prototype.slice.call(root.querySelectorAll('script'));
    var i = 0;
    function runNext() {
      if (i >= scripts.length) { requestAnimationFrame(reportHeight); return; }
      var old = scripts[i++];
      var s = document.createElement('script');
      // Copy attributes except src (set explicitly) and on* handlers (managed here).
      Array.from(old.attributes).forEach(function(attr) {
        if (attr.name === 'src' || /^on/i.test(attr.name)) return;
        s.setAttribute(attr.name, attr.value);
      });
      if (old.src) {
        s.src = old.src;
        // Proceed once the external script settles. 'error' also advances so a
        // blocked / failed CDN never stalls the chain; a watchdog covers the
        // rare case where a hung connection fires neither event.
        var advanced = false;
        var timer = null;
        var advance = function() {
          if (advanced) return;
          advanced = true;
          if (timer) clearTimeout(timer);
          runNext();
        };
        s.addEventListener('load', advance);
        s.addEventListener('error', advance);
        timer = setTimeout(advance, 10000);
        old.parentNode.replaceChild(s, old);
      } else {
        s.textContent = old.textContent;
        try {
          old.parentNode.replaceChild(s, old); // inline scripts run synchronously
        } catch (err) {
          // WebKit throws a malformed inline script's SyntaxError synchronously
          // at insertion. Catch it so this widget's remaining scripts still run
          // and the failure shows as a notice rather than a blank box.
          showWidgetError(err && err.message ? err.message : 'script error');
        }
        runNext();
      }
    }
    runNext();
  }

  // Message handler
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'widget:i18n' && typeof e.data.scriptErrorPrefix === 'string') {
      widgetScriptErrorPrefix = e.data.scriptErrorPrefix;
    }

    if (e.data.type === 'widget:update' && !finalized) {
      // Streaming preview — update HTML without executing scripts
      if (e.data.html !== currentHtml) {
        currentHtml = e.data.html;
        root.innerHTML = currentHtml;
        reportHeight();
      }
    }

    if (e.data.type === 'widget:finalize' && !finalized) {
      finalized = true;
      var newHtml = e.data.html;
      // Always rebuild DOM on finalize — streaming updates had scripts stripped,
      // so we need to set the full HTML (with scripts) and execute them.
      root.innerHTML = newHtml;
      currentHtml = newHtml;
      runScripts();
      reportHeight();
    }

    if (e.data.type === 'widget:theme') {
      // Theme update — inject new CSS variables
      var styleEl = document.getElementById('theme-vars');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'theme-vars';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = e.data.css;
      reportHeight();
    }
  });

  // Signal ready
  window.parent.postMessage({ type: 'widget:ready' }, '*');
})();
</script>
</body>
</html>`;
}
