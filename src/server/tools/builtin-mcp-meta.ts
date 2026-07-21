// Central META registrations for builtin MCP tools.
//
// Imported at side-effect cost ~0 from agent-session.ts. Each registration
// below stores a `load()` factory function reference, but does NOT evaluate
// the corresponding tool module. The heavy `@anthropic-ai/claude-agent-sdk`
// (~900KB) + `zod/v4` (~470KB) + per-tool zod-schema construction stay cold
// until `getBuiltinMcpInstance(id)` is called from `buildSdkMcpServers()`
// (during pre-warm) or from a Settings "Test"/"Enable" click.
//
// Adding a new builtin MCP = one block below + new tool file exporting
// `createXxxServer()` (async, SDK+zod imported inside). No other changes
// to agent-session.ts or the registry.
//
// What this optimization DOES vs DOES NOT save:
//   - `npm run build:server` uses esbuild `--bundle` without `--splitting`.
//     All dynamically-imported modules are INLINED into the single
//     `server-dist.js` output — there is no bundle-size or JS-parse win.
//   - The real win is DEFERRED EXECUTION: `createSdkMcpServer()` runs zod
//     schema construction that amortizes ~100-400ms per tool. We skip it
//     until the tool is actually needed by this Sidecar's lifetime (often
//     never, for Tabs that don't enable any builtin MCP).
//
// Guard against regression: never add `import { createSdkMcpServer, tool }
// from '@anthropic-ai/claude-agent-sdk'` or `import { z } from 'zod/v4'`
// at a tool file's top level — CLAUDE.md codifies this as a forbidden
// pattern, and any violation silently defeats the refactor.

import { registerBuiltinMcpMeta } from "./builtin-mcp-registry";

// --- User-toggleable builtins ---
// (gemini-image, edge-tts) — appear in Settings with `command: '__builtin__'`.
// buildSdkMcpServers() calls `.configure(env, ctx)` before handing the server
// to the SDK; `/api/mcp/enable` + `handleMcpTest` call `.validate(env)`.

registerBuiltinMcpMeta({
  id: "gemini-image",
  load: async () => {
    const m = await import("./gemini-image-tool");
    return {
      server: await m.createGeminiImageServer(),
      configure: m.configureGeminiImage,
      validate: m.validateGeminiImage,
    };
  },
});

registerBuiltinMcpMeta({
  id: "edge-tts",
  load: async () => {
    const m = await import("./edge-tts-tool");
    return {
      server: await m.createEdgeTtsServer(),
      configure: m.configureEdgeTts,
      // No validate — free service, no API key to verify
    };
  },
});

// --- Workbench-controlled native tool adapters ---
// Hidden from Settings. Product semantics and lifecycle are owned by the
// Workbench Host; createSdkMcpServer is only the Claude SDK's in-process
// custom-tool transport. Never expose this entry as an MCP service to users.
registerBuiltinMcpMeta({
  id: "novel-workbench",
  load: async () => {
    const m = await import("./novel-workbench-tool");
    return {
      server: await m.createNovelWorkbenchServer(),
      configure: m.configureNovelWorkbench,
    };
  },
});
