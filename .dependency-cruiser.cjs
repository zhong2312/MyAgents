// MyAgents architectural-boundary lint via dependency-cruiser.
//
// This file holds the "module-graph" rules that ESLint can't express:
// "module A is not allowed to import from module B." Each rule below
// codifies a structural invariant from CLAUDE.md so violations fail at
// `npm run lint:deps` instead of being caught (or missed) during review.
//
// LLM reader convention: each rule's `comment` field MUST explain BOTH
// the bug that arises if you violate (so you can match your situation
// to the failure mode) AND the correct path. See eslint.config.js header
// for the same convention.
//
// Run:  npx depcruise --config .dependency-cruiser.cjs src
// Or via npm script: `npm run lint:deps`

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies cause init-order surprises (one side sees `undefined` instead of an export at module-eval time, then fails at first call) and bloat bundles. Refactor to extract the shared interface into a third leaf module both sides can depend on. Cycles that pass through a React `lazy(() => import(...))` site are NOT flagged — the dynamic edge defers loading until runtime so the modules initialise in a well-defined order.',
      // dep-cruiser quirk: aliased dynamic imports (`@/components/X`) get
      // typed as ['aliased', 'aliased-tsconfig', 'local', ...] but NOT
      // 'dynamic-import' (only bare `import('./x')` does). The
      // `via.dependencyTypesNot: ['dynamic-import']` filter therefore
      // can't see the dynamic edge. The `via.path` filter also doesn't
      // reliably match across cycle reporting (dep-cruiser reports the
      // cycle starting from the first-discovered node, which varies).
      //
      // Brute-force workaround: list ALL nodes that participate in known
      // intentional cycles in `from.pathNot`. Each entry MUST carry a
      // matching `// dep-cruiser: intentional cycle, see X` comment near
      // the `lazy()` call so reviewers can audit it against the code.
      from: {
        pathNot: [
          // Cycle: FilePreviewModal → Markdown → InlineCode →
          //        FileActionContext → (lazy) → FilePreviewModal.
          // Broken at runtime by lazy(() => import('@/components/
          // FilePreviewModal')) in FileActionContext.tsx — the modal is
          // heavy (Monaco + SyntaxHighlighter). Markdown sub-components
          // (InlineCode) legitimately reach into the file-action context
          // to open previews on click; module init order is well-defined
          // because lazy() defers the back-edge.
          'src/renderer/components/FilePreviewModal\\.tsx$',
          'src/renderer/components/Markdown\\.tsx$',
          'src/renderer/components/markdown/InlineCode\\.tsx$',
          'src/renderer/context/FileActionContext\\.tsx$'
        ]
      },
      to: { circular: true }
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Orphan modules (no other file imports them) are usually leftovers from deleted features that nobody noticed. They still get type-checked and bundled. Either delete the file or wire it back into the entry it should serve. Excludes config files, declaration files, and entry points which are legitimately not imported.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(?:js|cjs|mjs|ts|json)$', // dotfiles like .eslintrc
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|nodemon|jest|vitest|webpack|esbuild|vite|tailwind|postcss|stylelint)\\.config\\.(js|cjs|mjs|ts)$',
          '^src/server/index\\.ts$', // sidecar entry
          '^src/server/plugin-bridge/main\\.ts$', // bridge entry
          '^src/cli/myagents\\.ts$', // CLI entry
          '^src/renderer/main\\.tsx$', // renderer entry
          '^src-tauri/', // Rust files: depcruise sees them only via fs walk; not part of TS graph
          // Type-only files. Since we set tsPreCompilationDeps:false, dep-cruiser
          // doesn't track `import type {...}` edges, so these files look orphan
          // even though `import type`-consumers exist throughout the codebase.
          // Patterns:
          //   types/<x>.ts  — `src/**/types/foo.ts`
          //   types.ts      — `src/**/types.ts`
          //   *Types.ts     — `src/**/treeTypes.ts`, `src/**/AgentTypes.ts`, etc.
          '(/|^)types/[^/]+\\.ts$',
          '(/|^)types\\.ts$',
          '(/|^)[^/]+[Tt]ypes\\.ts$'
        ]
      },
      to: {}
    },
    {
      // CLAUDE.md red-line: builtin MCP files (`src/server/tools/*.ts`)
      // run inside Sidecar but MUST stay isolated from the agent-session
      // module — they're loaded lazily at MCP-server-creation time, and
      // pulling in agent-session's transitive deps (SDK, zod, session
      // store, IM bus, …) would either re-trigger the cold-start tax that
      // the lazy-load is designed to avoid, OR create a circular dep
      // (agent-session imports from tools/ to register them).
      name: 'tools-no-import-agent-session',
      severity: 'error',
      comment:
        'src/server/tools/* MUST NOT import agent-session — would either re-trigger the cold-start singleton tax that the lazy-load architecture avoids, or create a circular import (agent-session is the one that calls into tools/ to register MCP servers). Restructure: pass any data the tool needs through the createXxxServer() factory args, not a top-level import.',
      from: { path: '^src/server/tools/[^/]+\\.ts$' },
      to: { path: '^src/server/agent-session\\.ts$' }
    },
    {
      // Builtin MCP factory isolation: tools shouldn't import each other
      // either. They're standalone factories registered into a single
      // registry. Cross-tool imports would couple their lazy-load
      // lifecycles and risk re-introducing eager-load bugs.
      // The registry + meta files are the legitimate cross-tool surface.
      name: 'tools-no-cross-imports',
      severity: 'error',
      comment:
        'Builtin MCP tool files in src/server/tools/ MUST NOT import each other — each is an independent lazy-loaded factory, cross-imports would couple their cold-start lifecycles and could resurrect the eager-load tax (~500–1000ms per tool) that the createXxxServer() pattern is designed to defer. Use src/server/tools/builtin-mcp-registry.ts or builtin-mcp-meta.ts as the shared surface.',
      from: {
        path: '^src/server/tools/[^/]+\\.ts$',
        pathNot: [
          '^src/server/tools/builtin-mcp-registry\\.ts$',
          '^src/server/tools/builtin-mcp-meta\\.ts$'
        ]
      },
      to: {
        path: '^src/server/tools/[^/]+\\.ts$',
        pathNot: [
          '^src/server/tools/builtin-mcp-registry\\.ts$',
          '^src/server/tools/builtin-mcp-meta\\.ts$'
        ]
      }
    },
    {
      // Process boundary: renderer runs in WebView, sidecar runs in
      // bundled Node. They CANNOT share runtime code — different module
      // resolution (Vite vs esbuild), different globals (window vs
      // process), different lifetimes (renderer reload vs sidecar
      // long-running). A renderer file importing src/server would either
      // crash at bundle time or, worse, silently inline server code into
      // the WebView bundle (fingerprint changes, security review surface).
      name: 'renderer-no-import-sidecar',
      severity: 'error',
      comment:
        'Renderer (WebView, Vite-bundled) MUST NOT import sidecar (Node, esbuild-bundled) — different runtime, different globals, different module resolution. Importing src/server from src/renderer either crashes at bundle time or silently inlines server code into the renderer bundle (security/size regression). Communicate via Tauri invokes or Sidecar HTTP. Shared types belong in src/shared.',
      from: { path: '^src/renderer/' },
      to: { path: '^src/server/' }
    },
    {
      // Inverse of the above: sidecar can't import renderer either.
      // Different reasons (renderer code uses DOM/React APIs that aren't
      // present in Node), but the architectural rule is the same.
      name: 'sidecar-no-import-renderer',
      severity: 'error',
      comment:
        'Sidecar (Node) MUST NOT import renderer (browser/React) — renderer code references window/document/JSX globals that Node lacks, and esbuild would either fail or pull in browser-only polyfills. Shared code belongs in src/shared. Sidecar talks to renderer via SSE / Tauri events, not direct import.',
      from: { path: '^src/server/' },
      to: { path: '^src/renderer/' }
    },
    {
      // Shared/ exists specifically to be the dependency target for both
      // renderer AND sidecar (types, pure utilities, constants). It
      // therefore MUST stay free of process-specific imports — anything
      // it pulls in would itself become "shared" and break the boundary
      // for the side that doesn't have those modules.
      name: 'shared-stays-pure',
      severity: 'error',
      comment:
        'src/shared is consumed by BOTH renderer and sidecar — it must stay free of process-specific imports. A renderer-only or sidecar-only dep would either crash on the other side at bundle time or sneak the wrong runtime code into the wrong bundle (e.g. React in the sidecar, fs in the renderer). If you need to share something process-specific, put it in src/renderer/shared or src/server/shared instead.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(renderer|server|cli)/' }
    },
    {
      name: 'workbench-core-no-concrete-imports',
      severity: 'error',
      comment:
        'MyAgents renderer core MUST NOT import a concrete workbench. Doing so makes each new workbench require core edits and turns the plugin boundary into a naming convention. Only src/renderer/workbench-registry.ts may aggregate src/renderer/workbenches/*; all other core code resolves definitions through workbench-sdk.',
      from: {
        path: '^src/renderer/',
        pathNot: [
          '^src/renderer/workbenches/',
          '^src/renderer/workbench-registry\\.ts$'
        ]
      },
      to: { path: '^src/renderer/workbenches/' }
    },
    {
      name: 'workbench-uses-sdk-boundary',
      severity: 'error',
      comment:
        'Concrete workbenches MUST depend on MyAgents only through src/renderer/workbench-sdk or src/shared/workbench-sdk. Importing App, config stores, Chat internals, sidecar code, or other host modules couples the workbench to unstable implementation details and prevents independent versioning. Add a capability to workbench-sdk instead.',
      from: { path: '^src/renderer/workbenches/' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/renderer/workbenches/',
          '^src/renderer/workbench-sdk/',
          '^src/shared/workbench-sdk/'
        ]
      }
    }
  ],
  options: {
    doNotFollow: {
      path: ['node_modules']
    },
    // Auto-generated SDK shim (~80 files at sdk-shim/plugin-sdk/*.js):
    // these are dynamically loaded by the bridge runtime via filename,
    // so they look like orphans to the static graph. Excluded entirely
    // from the cruise — orphan warnings here are noise, not signal.
    // Kept in sync with the same exclusion in eslint.config.js (line 17).
    exclude: {
      path: '^src/server/plugin-bridge/sdk-shim/'
    },
    // tsPreCompilationDeps: false → skip `import type` and other
    // type-only imports. Those are erased at compile time and don't
    // create a runtime dependency, so they shouldn't trigger boundary
    // rules like sidecar→renderer (which is about runtime code crossing
    // the process boundary, not types crossing it). Without this, every
    // shared type that lives in the wrong directory shows up as a
    // false-positive architectural violation.
    tsPreCompilationDeps: false,
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types', 'typings']
    }
  }
};
