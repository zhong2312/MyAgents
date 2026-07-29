import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const failures = [];

const claude = read('CLAUDE.md');
const lineCount = claude.split('\n').length;
const byteCount = Buffer.byteLength(claude);

// CLAUDE.md is injected into every turn. Keep enough headroom for genuine
// cross-cutting knowledge without allowing a module catalog to regrow there.
if (lineCount > 180 || byteCount > 16_000) {
  failures.push(
    `CLAUDE.md exceeds the always-on context budget (${lineCount}/180 lines, ${byteCount}/16000 bytes). ` +
      'Move task-specific rules to the owning tech doc or an executable guard.',
  );
}

for (const heading of [
  'Owner 与 authority 优先',
  '通信分为控制面和大载荷数据面',
  'Runtime 分流只有一个入口',
  '按任务加载文档',
  'Git 与共享工作区',
]) {
  if (!claude.includes(heading)) {
    failures.push(`CLAUDE.md lost attention-critical section: ${heading}`);
  }
}

if (claude.includes('Pit-of-Success 红线总表') || claude.includes('| 禁止 | 后果 | 正确做法 |')) {
  failures.push(
    'CLAUDE.md contains an exhaustive redline table. Keep the full catalog in ' +
      'specs/tech_docs/pit_of_success.md and enforce mechanical rules in lint/tests.',
  );
}

const routedDocs = new Set(claude.match(/specs\/[A-Za-z0-9_./-]+\.md/g) ?? []);
for (const path of routedDocs) {
  if (!existsSync(resolve(root, path))) {
    failures.push(`CLAUDE.md routes to a missing document: ${path}`);
  }
}

const architecture = read('specs/ARCHITECTURE.md');
if (/所有前端 HTTP \/ SSE 流量 MUST[\s\S]{0,100}禁止.*WebView.*HTTP/.test(architecture)) {
  failures.push(
    'ARCHITECTURE.md bans every WebView HTTP request, which contradicts the registered ' +
      '/refs and /attachment data-plane exception.',
  );
}

const readme = read('README.md');
if (
  readme.includes('WebView 不直接访问 Sidecar 端口') ||
  readme.includes('WebView does not access Sidecar ports directly')
) {
  failures.push(
    'README.md states the Rust control-plane rule as an absolute ban and hides the registered ' +
      '/refs and /attachment data-plane exception.',
  );
}
if (/external runtimes? (?:go|走).*external-session\.ts/i.test(readme)) {
  failures.push(
    'README.md bypasses the SessionEngine facade by presenting external-session.ts as the runtime routing entry.',
  );
}

for (const path of [
  'specs/tech_docs/auto_update.md',
  'specs/guides/build_and_release_guide.md',
]) {
  if (/^\s*git add (?:-A|\.)\s*$/m.test(read(path))) {
    failures.push(`${path} teaches broad staging; release examples must list their intended files explicitly.`);
  }
}

if (failures.length > 0) {
  console.error('Agent documentation verification failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Agent docs verified: CLAUDE.md ${lineCount} lines / ${byteCount} bytes; ${routedDocs.size} routed docs exist.`,
);
