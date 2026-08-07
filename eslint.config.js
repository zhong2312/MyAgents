import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import eslintComments from 'eslint-plugin-eslint-comments';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

// ────────────────────────────────────────────────────────────────────────
// Lint message convention (read this if you're adding a rule):
//
//   Each `message` MUST tell an LLM reader BOTH the problem and the fix —
//   "what breaks if you violate" + "what to use instead". The lint catches
//   the syntax, but the LLM that gets the error needs to reason about edge
//   cases (is this an exception? do I really need this pattern?). A bare
//   "use X instead" leaves the LLM no way to judge — it just does what it's
//   told without understanding when the rule doesn't apply. Format:
//
//     "<symptom / what breaks>. Use <correct helper>. CLAUDE.md red-line."
//
//   When relevant, name the historical incident or class of bug (502 from
//   system proxy, console-window flash, OS-listener leak, …) so the LLM
//   can match its situation against the failure mode rather than blindly
//   following a recipe.
// ────────────────────────────────────────────────────────────────────────

// CLAUDE.md red-line selectors that apply EVERYWHERE (renderer + sidecar +
// shared). Spread into every block that defines `no-restricted-syntax`,
// because Flat Config's later-block-wins semantics would otherwise wipe
// these rules for files matched by a more specific block (the existing
// renderer-block / Phase-E selectors hit this exact trap — see the comment
// near line 88 for the post-mortem). Defining the array once and spreading
// it keeps the single-source-of-truth without re-introducing the bug.
const GLOBAL_RESTRICTED_SYNTAX = [
  {
    // CLAUDE.md red-line: synchronous busy-wait blocks the event loop.
    // Sidecar busy-wait kills the SDK pump (no messages flow until the
    // wait returns); renderer busy-wait freezes the UI thread.
    selector: "MemberExpression[object.name='Atomics'][property.name='wait']",
    message:
      'Atomics.wait blocks the event loop synchronously — Sidecar stops draining SDK messages, renderer freezes the UI. Use async polling: setTimeout / setInterval / withFileLock helpers. CLAUDE.md red-line.'
  },
  {
    // CLAUDE.md red-line: `<expr>.toISOString().split('T')[0]` returns the
    // UTC date. The unified log filename is built from the *local* date
    // (`~/.myagents/logs/unified-{YYYY-MM-DD}.log`), so using the UTC date
    // here means writes land in the wrong file for ~1/3 of every day in
    // UTC+8. The bug manifests as missing log entries when a user grep's
    // "today's" log around midnight CN time.
    selector:
      "CallExpression[callee.property.name='split'][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString'][arguments.0.value='T']",
    message:
      "toISOString().split('T')[0] returns UTC date — in UTC+8 it differs from the local date for ~1/3 of every day, so the log line lands in yesterday's/tomorrow's file. Use localDate() from '@/shared/logTime'. CLAUDE.md red-line."
  },
  {
    // CLAUDE.md red-line: native HTML `<select>` renders the OS-default
    // dropdown which looks/behaves differently on macOS, Windows, and
    // Linux. Worse, it can't be styled to match the app theme — it always
    // pops out as a system-chrome menu. `<CustomSelect>` is the styled
    // primitive used everywhere else in the app and matches DESIGN.md.
    selector: "JSXOpeningElement[name.name='select']",
    message:
      'Native <select> renders the OS dropdown — looks alien on every platform, cannot be themed, breaks DESIGN.md visual consistency. Use <CustomSelect> from @/components/CustomSelect. CLAUDE.md red-line.'
  },
  {
    // CLAUDE.md red-line: `shouldAbortSession = true` is the persistent-
    // session abort flag. Setting it directly skips the surrounding cleanup
    // (rescue pending items, notify IM bus subscribers, wake blocked
    // generator) and leaves the SDK in an inconsistent state — pending
    // requests never get an error reply and IM subscribers hang. The ONLY
    // legitimate setter is inside `abortPersistentSession()` in
    // agent-session.ts, which performs the full teardown sequence.
    // Re-setting it to `false` (lifecycle reset at session boundaries) is
    // fine — that's why we only ban `= true`.
    selector:
      "AssignmentExpression[operator='='][left.name='shouldAbortSession'][right.type='Literal'][right.value=true]",
    message:
      'Direct `shouldAbortSession = true` skips the abort cleanup chain (pending request rescue, IM bus notification, generator wake) — pending IM replies hang forever. Call abortPersistentSession() instead. CLAUDE.md red-line.'
  },
  // PRD 0.2.34 Part 3: tiers `text-2xs`(10) / `text-2sm`(12) / `text-md`(14)
  // were DELETED (merged into text-xs=12 / text-sm=14). No @theme token →
  // Tailwind generates NO utility → the class compiles fine and silently
  // renders with NO font-size (静默腐坏). GLOBAL (not renderer-only) because
  // the widget design contract (src/server/tools/generative-ui-tool.ts) and
  // sandbox template (widgetSandboxHtml.ts) embed class names in strings —
  // a dead name there teaches the MODEL to emit dead classes in widgets
  // (P3 cross-review: server side was an unguarded gap).
  {
    selector: 'Literal[value=/\\btext-(?:2xs|2sm|md)\\b/]',
    message:
      '`text-2xs`/`text-2sm`/`text-md` 是已删除的档位（PRD 0.2.34 Part 3 合并：2xs/2sm→text-xs=12px，md→text-sm=14px）。这些类名已无 @theme token，Tailwind 不会为其生成任何 CSS——写了编译不报错但字号静默失效；出现在 widget 契约/沙箱模板字符串里则会教模型产出死类名。改用现行七档：text-xs(12 meta/描述)/text-sm(14 UI/表格)/text-base(16 正文)/text-lg(18 弹窗标题)/text-xl(20)/text-2xl(22)/text-3xl(28)。',
  },
  {
    selector: 'TemplateElement[value.raw=/\\btext-(?:2xs|2sm|md)\\b/]',
    message:
      '`text-2xs`/`text-2sm`/`text-md` 是已删除的档位（PRD 0.2.34 Part 3 合并：2xs/2sm→text-xs=12px，md→text-sm=14px）。这些类名已无 @theme token，Tailwind 不会为其生成任何 CSS——写了编译不报错但字号静默失效；出现在 widget 契约/沙箱模板字符串里则会教模型产出死类名。改用现行七档：text-xs(12 meta/描述)/text-sm(14 UI/表格)/text-base(16 正文)/text-lg(18 弹窗标题)/text-xl(20)/text-2xl(22)/text-3xl(28)。',
  }
];

// Sidecar-only restrictions. Includes everything in GLOBAL plus the
// __dirname ban (esbuild hardcodes __dirname at bundle time).
const SIDECAR_RESTRICTED_SYNTAX = [
  ...GLOBAL_RESTRICTED_SYNTAX,
  {
    selector: 'ImportDeclaration > Literal[value=/^\\.\\./][value=/renderer/]',
    message:
      'Server imports from Renderer reverse the Node/WebView owner boundary and can pull browser-owned contracts into the Sidecar. Move shared wire/domain types to src/shared and import that owner directly.'
  },
  {
    // CLAUDE.md red-line: esbuild bundles src/server into a single
    // server-dist.js, hardcoding __dirname to the SOURCE file's directory.
    // At runtime the bundle lives in dist/, so any path.join(__dirname,
    // ...) reads a path that doesn't exist (or, worse, exists from an old
    // build and serves stale content).
    selector: "Identifier[name='__dirname']",
    message:
      'esbuild hardcodes __dirname to the source file path at bundle time → at runtime the path points into a non-existent (or stale) source tree. Use fileURLToPath(import.meta.url) or getScriptDir() from @/server/utils/runtime. CLAUDE.md red-line.'
  }
];

// Tools + plugin-bridge restrictions. Includes everything in SIDECAR plus
// the bare-fetch ban — these code paths run inside SDK turns / IM bridge
// processing, where a stuck fetch holds the turn / message indefinitely.
const TOOLS_BRIDGE_RESTRICTED_SYNTAX = [
  ...SIDECAR_RESTRICTED_SYNTAX,
  {
    // CLAUDE.md red-line: bare fetch() inside tool / bridge code has no
    // AbortSignal, so when the upstream hangs (Feishu API timeout, network
    // pause, server slow-loris) the tool turn / IM message processing
    // hangs forever. The whole user-visible session appears frozen until
    // the OS TCP timeout (minutes). cancellableFetch() wires a 30s default
    // timeout AND parent-signal propagation so caller cancellation
    // (turn abort, session cancel, …) actually tears down the request.
    selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
    message:
      'Bare fetch() in tools/bridge has no AbortSignal — upstream hang freezes the SDK turn / IM message until OS TCP timeout (minutes). Use cancellableFetch from @/server/utils/cancellation, which wires a default 30s timeout and propagates parent abort signals. CLAUDE.md red-line.'
  },
  {
    // Same hazard via the namespaced form: `globalThis.fetch(...)` /
    // `window.fetch(...)` / `self.fetch(...)`. AST-equivalent to bare
    // `fetch(...)` — same lifetime, same lack of default AbortSignal — so
    // it must be banned alongside. Indirect-via-rebinding (`const f =
    // globalThis.fetch; f(...)`) is harder to express in ESLint and is
    // left to review.
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='fetch'][callee.object.name=/^(globalThis|window|self)$/]",
    message:
      'Namespaced fetch (globalThis.fetch / window.fetch / self.fetch) has the same hang risk as bare fetch() — Use cancellableFetch from @/server/utils/cancellation. CLAUDE.md red-line.'
  }
];

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  {
    // Additional ignore patterns for build output and bundled resources
    ignores: ['**/out/**', '**/dist/**', '**/.vite/**', '**/coverage/**', '**/.eslintcache', 'bundled-skills/**', '**/sdk-shim/**', '.opendesign/export/**']
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    plugins: {
      'eslint-comments': eslintComments,
      react,
      'react-hooks': reactHooks
    }
  },
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  // Pit-of-success guard: bare imports of `listen` from `@tauri-apps/api/event`
  // leak the Tauri-side listener if the component unmounts during the
  // `await listen(...)` race window. `listenWithCleanup` from
  // `@/utils/tauriListen` encapsulates the correct teardown pattern (pre-await
  // abort, handler-time abort, post-await unlisten, auto-cleanup on signal).
  // Files that legitimately need bare `listen` (`SseConnection.ts`, the helper
  // itself, the helper test, and `TerminalPanel.tsx` whose listener lifecycle
  // is intentionally decoupled from the React effect) are exempted via
  // `ignores`. `import type { UnlistenFn }` is fine — type-only imports erase.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: [
      'src/renderer/utils/tauriListen.ts',
      'src/renderer/utils/tauriListen.test.ts',
      'src/renderer/api/SseConnection.ts',
      'src/renderer/components/TerminalPanel.tsx',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/api/event',
              importNames: ['listen'],
              message: "Use `listenWithCleanup` from '@/utils/tauriListen' instead — bare `await listen(...)` leaks the Tauri listener if the component unmounts mid-registration. See `tauriListen.ts` doc-comment.",
              allowTypeImports: true,
            },
          ],
        },
      ],
      // NOTE: `no-restricted-syntax` for dynamic-import detection lives in
      // the renderer block below (~line 130), MERGED with the Phase E sidecar
      // endpoint selectors. Splitting it across two config blocks doesn't
      // work — Flat Config's later-block-wins semantics meant the renderer
      // block's `no-restricted-syntax` wiped out anything we set here, so a
      // dynamic `import('@tauri-apps/api/event').then(({ listen }) => …)`
      // slipped through the guard. (Codex review of this migration caught
      // exactly this — 4 such callsites had been quietly bypassed.)
    },
  },
  // Renderer process (Browser + React environment)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off', // Using TypeScript for prop validation
      // Phase E (PRD 0.2.7): the renderer MUST NOT reach the deleted
      // sidecar workspace-IO endpoints. Workspace file ops go through Rust
      // `cmd_workspace_*` invokes via `useWorkspaceFileService`. Each
      // banned endpoint is matched via a `Literal[value=...]` selector
      // (esquery's regex literals are flaky in flat-config mode, so we
      // enumerate). Comments aren't `Literal` nodes, so red-line history
      // can still reference these strings in CLAUDE.md / PRD docs.
      'no-restricted-syntax': [
        'error',
        ...GLOBAL_RESTRICTED_SYNTAX,
        {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='writeText'][callee.object.type='MemberExpression'][callee.object.object.name='navigator'][callee.object.property.name='clipboard']",
          message: "Direct navigator.clipboard.writeText() can reject in focused desktop WebViews even when the API exists, causing silent or false-success copies. Use copyPlainText() from '@/utils/clipboard', which falls back to selection copy and rejects only when every path fails.",
        },
        // Dynamic-import guard for `@tauri-apps/api/event`. Catches
        // `import('@tauri-apps/api/event').then(({ listen }) => …)` which
        // bypasses the static `no-restricted-imports` rule above — that
        // rule only sees named imports in `ImportDeclaration` nodes. The
        // dynamic-import form ALSO needs to be locked down to seal the
        // pit-of-success: 4 such callsites bypassed the migration before
        // this selector was added. (Codex review CRIT-1 of the migration.)
        // Note: this matches ALL dynamic imports of the package, including
        // `emit`-only access. Migrate any legitimate `emit` callsite to a
        // static `import { emit } from '@tauri-apps/api/event'` (no leak
        // risk because emit doesn't subscribe).
        {
          selector: "ImportExpression > Literal[value='@tauri-apps/api/event']",
          message: "Dynamic `import('@tauri-apps/api/event')` is forbidden — bypasses the static `listen` ban. Use `listenWithCleanup` from '@/utils/tauriListen' for subscriptions, or a static `import { emit } from '@tauri-apps/api/event'` for one-shot dispatch.",
        },
        // #333: gradient stops must never fade to/from the `transparent`
        // keyword. `transparent` is rgba(0,0,0,0) — when an engine interpolates
        // a gradient without premultiplied alpha (macOS 27 beta WebKit does
        // this on Tailwind v4's `in oklab` gradient path), the ramp from an
        // opaque color to transparent BLACK passes through visible gray — the
        // user sees a dark smear band exactly where the fade sits, on every
        // theme, surviving restarts. Correct form: fade to the SAME color at
        // alpha 0 via the `--*-a0` twin tokens in index.css (e.g.
        // `to-[var(--paper-elevated-a0)]`) — a constant-color alpha ramp
        // renders identically under every interpolation implementation.
        {
          selector: 'Literal[value=/\\b(?:to|from|via)-transparent\\b/]',
          message: 'Gradient stop `(to|from|via)-transparent` is forbidden (#333): `transparent` = rgba(0,0,0,0) and buggy gradient interpolation (macOS 27 beta WebKit, oklab path) renders the ramp through BLACK as a gray smear band. Fade to the same color at alpha 0 instead — use the `--*-a0` twin tokens from index.css, e.g. `to-[var(--paper-elevated-a0)]`.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\b(?:to|from|via)-transparent\\b/]',
          message: 'Gradient stop `(to|from|via)-transparent` is forbidden (#333): `transparent` = rgba(0,0,0,0) and buggy gradient interpolation (macOS 27 beta WebKit, oklab path) renders the ramp through BLACK as a gray smear band. Fade to the same color at alpha 0 instead — use the `--*-a0` twin tokens from index.css, e.g. `to-[var(--paper-elevated-a0)]`.',
        },
        // Same #333 hazard in the RAW CSS form — the original regressions
        // (TabBar / SimpleChatInput / QueryNavigator) were inline
        // `style={{ background: 'linear-gradient(..., transparent)' }}`
        // strings, which the Tailwind-class selectors above never match.
        {
          selector: 'Literal[value=/(?:linear|radial|conic)-gradient\\(.*\\btransparent\\b/]',
          message: 'CSS gradient with a `transparent` stop is forbidden (#333): `transparent` = rgba(0,0,0,0) and buggy gradient interpolation (macOS 27 beta WebKit, oklab path) renders the ramp through BLACK as a gray smear band. Fade to the same color at alpha 0 instead — use the `--*-a0` twin tokens from index.css, e.g. `linear-gradient(to right, var(--paper), var(--paper-a0))`.',
        },
        {
          selector: 'TemplateElement[value.raw=/(?:linear|radial|conic)-gradient\\(.*\\btransparent\\b/]',
          message: 'CSS gradient with a `transparent` stop is forbidden (#333): `transparent` = rgba(0,0,0,0) and buggy gradient interpolation (macOS 27 beta WebKit, oklab path) renders the ramp through BLACK as a gray smear band. Fade to the same color at alpha 0 instead — use the `--*-a0` twin tokens from index.css, e.g. `linear-gradient(to right, var(--paper), var(--paper-a0))`.',
        },
        // PRD 0.2.34: arbitrary px font-size literals (`text-[13px]`) bypass
        // the Type Scale and are the root cause of the "字号大小不一" user
        // complaint — ghost tiers grew to ~700 callsites before the
        // unification. The scale lives in index.css `@theme` (single source
        // of truth). Since Part 3 the ladder is 12/14/16/18/20/22/28 —
        // text-xs/sm/base/lg/xl now MATCH Tailwind defaults; the only
        // remaining divergence is text-2xl=22px (official 24).
        //
        // Known escape surface (accepted, do NOT widen the regex without
        // re-reading DESIGN.md §2.2 边界): rem/em arbitrary values
        // (`text-[2.5rem]` brand title, `text-[0.9em]` inline code) are
        // legitimate relative/display forms; `style={{fontSize}}` API
        // configs (Monaco/xterm/syntax-highlighter) are out of Tailwind's
        // reach anyway; `.css` files aren't linted (fb.css 已对齐 v2.5 字阶, see
        // PRD 0.2.35); dynamic `text-[${n}px]` escapes the lint but
        // Tailwind JIT never generates CSS for it, so it self-neutralizes.
        // Banning ALL `text-[...]` would false-positive on the color form
        // `text-[var(--ink)]` — px-only is the deliberate scope.
        //
        // 死类名封禁（text-2xs/2sm/md）已上移至 GLOBAL_RESTRICTED_SYNTAX —
        // P3 cross-review 指出 server 侧（widget 契约 generative-ui-tool.ts）
        // 同样需要设防，renderer-only 是缺口。
        {
          selector: 'Literal[value=/\\btext-\\[[0-9]+(?:\\.[0-9]+)?px\\]/]',
          message: '任意 px 字号 `text-[Npx]` 被禁止（PRD 0.2.34）：绕过 Type Scale 会重新长出幽灵字阶，正是"字号大小不一"投诉的根因。改用七档梯子：text-xs(12 meta/描述)/text-sm(14 UI/表格)/text-base(16 正文)/text-lg(18 弹窗标题)/text-xl(20 H2)/text-2xl(22 H1)/text-3xl(28 大数字)。xs/sm/base/lg/xl 与 Tailwind 官方值一致，唯 text-2xl=22px（官方 24）与 text-3xl=28px（官方 30）。确需离阶值的展示型场景（如品牌字）先在 DESIGN.md 立档，再对单行 eslint-disable 并注明出处。',
        },
        {
          selector: 'TemplateElement[value.raw=/\\btext-\\[[0-9]+(?:\\.[0-9]+)?px\\]/]',
          message: '任意 px 字号 `text-[Npx]` 被禁止（PRD 0.2.34）：绕过 Type Scale 会重新长出幽灵字阶，正是"字号大小不一"投诉的根因。改用七档梯子：text-xs(12 meta/描述)/text-sm(14 UI/表格)/text-base(16 正文)/text-lg(18 弹窗标题)/text-xl(20 H2)/text-2xl(22 H1)/text-3xl(28 大数字)。xs/sm/base/lg/xl 与 Tailwind 官方值一致，唯 text-2xl=22px（官方 24）与 text-3xl=28px（官方 30）。确需离阶值的展示型场景（如品牌字）先在 DESIGN.md 立档，再对单行 eslint-disable 并注明出处。',
        },
        ...[
          '/api/files/import-base64',
          '/api/files/copy',
          '/api/files/read-as-base64',
          '/api/files/add-gitignore',
          '/api/commands',
          '/api/git/branch',
          '/api/claude-md',
          '/agent/dir',
          '/agent/dir/expand',
          '/agent/file',
          '/agent/download',
          '/agent/import',
          '/agent/new-file',
          '/agent/new-folder',
          '/agent/rename',
          '/agent/delete',
          '/agent/move',
          '/agent/open-in-finder',
          '/agent/open-with-default',
          '/agent/open-path',
          '/agent/search-files',
          '/agent/check-paths',
          '/agent/save-file'
        ].map((endpoint) => ({
          selector: `Literal[value=${JSON.stringify(endpoint)}]`,
          message: `Phase E (PRD 0.2.7): sidecar HTTP endpoint '${endpoint}' was deleted. Workspace file IO must go through Rust cmd_workspace_* invokes via useWorkspaceFileService. See CLAUDE.md red-line.`
        }))
      ]
    }
  },
  // Global rules for all files
  {
    rules: {
      // TypeScript rules
      'no-undef': 'off', // TypeScript handles this
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Prevent disabling no-explicit-any via inline comments — it hides real
      // type bugs behind `any`. Ban list extends below for ESM-targeted files
      // (which is everything except `src/cli/**`).
      'eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-explicit-any']
    }
  },
  // ESM-targeted files (everything except the CJS-bundled CLI): forbid
  // `// eslint-disable-next-line @typescript-eslint/no-require-imports`.
  //
  // Why: bare `require()` in an ESM file throws `ReferenceError: require is
  // not defined` at runtime. The Bun→Node v0.2.0 migration accumulated 6+
  // sites where developers reached for `require()` (probably copy-paste from
  // legacy CJS code) and silenced the lint with a disable comment. Each one
  // was a latent crash waiting for the right code path. The MCP playwright
  // "initialization failed: require is not defined" regression in v0.2.0 was
  // caused by exactly this. ESM files MUST use static `import` or
  // `await import()` — never `require()`.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['src/cli/**'],
    rules: {
      'eslint-comments/no-restricted-disable': [
        'error',
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-require-imports'
      ]
    }
  },
  // CLI is bundled by esbuild with `--format=cjs` (see package.json:build:cli),
  // so `require()` runs in a real CJS context after bundling. Disable the rule
  // entirely for CLI files — relying on disable-next-line comments would force
  // every `require()` call site to carry boilerplate, and (per Codex review)
  // doesn't actually constitute a true exemption since the underlying rule
  // would still fire if a contributor forgot the comment.
  {
    files: ['src/cli/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // Structural guard: builtin MCP tool files MUST NOT eager-import the SDK
  // or zod at module top (value imports only — `import type { ... }` is
  // erased at compile time and is fine). Value imports from these modules
  // must be loaded inside `createXxxServer()` via `await import(...)` so
  // the Sidecar cold-start singleton-creation tax (~500-1000ms) stays
  // deferred. Enforces the "Pit of success" convention codified in
  // CLAUDE.md 补充禁止事项 and builtin-mcp-meta.ts header.
  //
  // Uses @typescript-eslint/no-restricted-imports (not the base rule) so
  // that `allowTypeImports: true` lets us keep type-only imports zero-cost.
  {
    files: ['src/server/tools/*.ts'],
    ignores: ['src/server/tools/builtin-mcp-registry.ts', 'src/server/tools/builtin-mcp-meta.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message:
                "Top-level value-import of @anthropic-ai/claude-agent-sdk in src/server/tools/* defeats the lazy-load architecture: the SDK's createSdkMcpServer() singleton-init runs at module-eval time, paid by every Sidecar cold start (~500–1000ms each, 6 tools = ~3–6s). Move the import inside the `createXxxServer()` factory body via `await import('@anthropic-ai/claude-agent-sdk')` so the cost is paid only when the tool is actually used. `import type { ... }` at module top is fine — types erase at compile. CLAUDE.md red-line.",
              allowTypeImports: true
            },
            {
              name: 'zod',
              message:
                "Top-level value-import of zod in src/server/tools/* eager-creates the schema-validation runtime — same Sidecar cold-start tax as the SDK ban above (~500ms per tool). Move inside `createXxxServer()` via `await import('zod/v4')`. `import type { ... }` at module top is fine. CLAUDE.md red-line.",
              allowTypeImports: true
            },
            {
              name: 'zod/v4',
              message:
                "Same as the `zod` rule above: top-level value-import eager-creates the schema runtime at Sidecar cold start. Move inside `createXxxServer()` via `await import('zod/v4')`. `import type { ... }` at module top is fine. CLAUDE.md red-line.",
              allowTypeImports: true
            }
          ]
        }
      ]
    }
  },
  // Sidecar (`src/server/**`): inherits GLOBAL bans + adds the __dirname
  // ban (esbuild hardcodes __dirname at bundle time → runtime path
  // resolves into a non-existent source tree).
  //
  // SIDECAR_RESTRICTED_SYNTAX is the full set: GLOBAL + __dirname.
  // The next block (tools/plugin-bridge) is more specific (later in the
  // file) and adds the fetch ban on top — Flat Config's later-block-wins
  // semantics mean the more specific block must respread the full set,
  // which TOOLS_BRIDGE_RESTRICTED_SYNTAX does.
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SIDECAR_RESTRICTED_SYNTAX]
    }
  },
  // Tools + plugin-bridge: bare fetch() ban on top of all sidecar rules.
  // These code paths run inside SDK turns (tools/) or IM message processing
  // (plugin-bridge/), where a stuck upstream freezes the user-visible
  // session. cancellableFetch() from @/server/utils/cancellation provides
  // a default 30s timeout and propagates parent abort signals.
  //
  // Tests (`__tests__/`) and the cancellation helper itself are exempt —
  // the helper IS the wrapper around raw fetch.
  {
    files: ['src/server/tools/**/*.ts', 'src/server/plugin-bridge/**/*.ts'],
    ignores: [
      'src/server/utils/cancellation.ts', // the wrapper itself
      'src/server/**/__tests__/**',
      'src/server/**/*.test.ts'
    ],
    rules: {
      'no-restricted-syntax': ['error', ...TOOLS_BRIDGE_RESTRICTED_SYNTAX]
    }
  },
  // Other-files catchall: shared / cli / scripts that didn't match any
  // earlier block above still need the Atomics.wait + UTC-date bans.
  // The renderer + sidecar + tools-bridge blocks override this for their
  // own files (each carrying its own restricted-syntax superset).
  {
    files: ['src/**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: ['src/renderer/**', 'src/server/**'],
    rules: {
      'no-restricted-syntax': ['error', ...GLOBAL_RESTRICTED_SYNTAX]
    }
  }
);
