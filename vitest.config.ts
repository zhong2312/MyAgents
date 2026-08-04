import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// MUST mirror vite.config.ts `resolve.alias` for raw-imported widget libraries;
// otherwise the dom project fails to resolve widgetLibraries dynamic imports
// when it renders WidgetRenderer. Lookahead keeps the trailing `?raw` query.
const alias = [
  { find: '@', replacement: resolve(__dirname, 'src/renderer') },
  { find: /^chartjs-umd-source(?=$|\?)/, replacement: resolve(__dirname, 'node_modules/chart.js/dist/chart.umd.js') },
  { find: /^d3-umd-source(?=$|\?)/, replacement: resolve(__dirname, 'node_modules/d3/dist/d3.min.js') },
  { find: /^lucide-umd-source(?=$|\?)/, replacement: resolve(__dirname, 'node_modules/lucide/dist/umd/lucide.min.js') },
];

// Test projects are split by what a test TOUCHES — so the dev loop gets a
// fast, parallel pure-logic pool while stateful integration tests keep their
// required serial isolation without mixing in credentialed real-network smoke.
//
//  - `unit`     : pure logic. No module-level singletons, no fixed ports, no
//                 real SDK, no shared disk path → safe to run in PARALLEL forks.
//                 Target: < 5s, run on every save (`npm run test:unit`).
//  - `integration`: credential-free stateful server tests. May touch module
//                 globals, loopback ports, scratch HOME, or SessionStore, but
//                 MUST NOT talk to real upstream network. Runs singleFork serial.
//  - `credentialed`: real SDK/provider/network smoke. Explicit only; not part
//                 of default npm test or public CI.
//
// Routing rule: shared/* and renderer/* are pure today (DOM-free util/service
// tests under node env) → `unit`. Server tests MUST use an explicit suffix:
// `*.unit.test.ts`, `*.integration.test.ts`, or `*.credentialed.test.ts`.
// `npm run test:classification` enforces this; do not add bare `*.test.ts`.
// If a `unit` test ever flakes under parallelism (turns out to import a stateful
// module), move it to `integration` — correctness over speed.
//
// The `dom` project runs `*.test.tsx` in jsdom with @testing-library/react for
// component / hook behaviour (focus, events, rendering). Component tests that
// need canvas / real WebView (pdf.js render, etc.) are out of scope for jsdom —
// extract their pure logic and test that in `unit` instead.
export default defineConfig({
  resolve: { alias },
  test: {
    // Coverage is aggregated across projects. No hard % threshold on purpose —
    // we ratchet per changed file rather than chase a global number (which
    // invites filler tests). Run with `npm run coverage`.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__tests__/**', 'src/test/**'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          // Theme manifests validate the exact co-located CSS source. Vitest
          // mocks CSS to an empty module by default, which would bypass that
          // production contract; process only the Theme package styles here.
          css: { include: /theme\/.*\.css/ },
          include: [
            'src/shared/**/*.test.ts',
            'src/renderer/**/*.test.ts',
            'src/cli/**/*.unit.test.ts',
            'src/server/**/*.unit.test.ts',
          ],
          setupFiles: ['src/test/setup-no-egress.ts'],
          // Fast pure tests — a tight timeout surfaces accidental real I/O.
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
          // parallel (vitest default) — no singleFork
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/server/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          setupFiles: ['src/test/setup-integration.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'credentialed',
          environment: 'node',
          include: ['src/server/**/*.credentialed.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'dom',
          environment: 'jsdom',
          css: { include: /theme\/.*\.css/ },
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup-dom.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
        },
      },
    ],
  },
});
