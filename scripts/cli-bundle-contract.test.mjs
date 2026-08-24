import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');

test('built CLI keeps general surfaces and #523/#524 on exact routes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'myagents-cli-contract-'));
  const outfile = join(scratch, 'myagents.cjs');
  const attachment = join(scratch, 'evidence.txt');
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: {} }));
    });
  });

  try {
    await build({
      absWorkingDir: repoRoot,
      entryPoints: ['src/cli/myagents.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      define: { __MYAGENTS_VERSION__: JSON.stringify('0.4.7-test') },
    });
    await writeFile(attachment, 'evidence', 'utf8');
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const cases = [
      {
        args: ['space', 'issue', 'list'],
        path: '/api/admin/space/issue-list',
        overrideInheritedPort: true,
      },
      { args: ['space', 'goal', 'list'], path: '/api/admin/space/goal-list' },
      { args: ['space', 'assignee', 'list'], path: '/api/admin/space/assignee-list' },
      { args: ['space', 'whoami'], path: '/api/admin/space/whoami' },
      {
        args: ['space', 'issue', 'claim', 'iss_523', '--deliveryId', 'delivery_1'],
        path: '/api/admin/space/issue-claim',
        body: { issueId: 'iss_523', deliveryId: 'delivery_1' },
      },
      {
        args: ['space', 'issue', 'attachment', 'add', 'iss_523', '--file', attachment],
        path: '/api/admin/space/attachment-add',
        body: { issueId: 'iss_523', filePaths: [attachment] },
      },
      {
        args: ['space', 'issue', 'complete', 'iss_523'],
        path: '/api/admin/space/issue-complete',
        body: { issueId: 'iss_523' },
      },
    ];

    for (const contract of cases) {
      const before = requests.length;
      await execFileAsync(process.execPath, [
        outfile,
        ...contract.args,
        '--space',
        'official',
        '--workspacePath',
        scratch,
        '--json',
        ...(contract.overrideInheritedPort ? ['--port', String(address.port)] : []),
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          VITEST: '',
          MYAGENTS_PORT: contract.overrideInheritedPort ? '1' : String(address.port),
        },
      });
      assert.equal(requests.length, before + 1);
      const observed = requests.at(-1);
      assert.equal(observed.url, contract.path);
      assert.equal(observed.body.spaceSlug, 'official');
      if (contract.body) {
        for (const [key, value] of Object.entries(contract.body)) {
          assert.deepEqual(observed.body[key], value);
        }
      }
      assert.doesNotMatch(observed.url, /^\/api\/admin\/space\/(issue|goal|assignee|attachment)$/);
    }

    const beforeHelp = requests.length;
    const help = await execFileAsync(process.execPath, [outfile, '--help'], {
      cwd: repoRoot,
      env: { ...process.env, VITEST: '', MYAGENTS_PORT: '' },
    });
    assert.match(help.stdout, /Usage: myagents/);
    assert.equal(requests.length, beforeHelp, 'top-level help must remain local');

    for (const contract of [
      { args: ['version'], path: '/api/admin/version' },
      { args: ['status'], path: '/api/admin/status' },
      { args: ['mcp', 'list'], path: '/api/admin/mcp/list' },
      { args: ['task', 'list'], path: '/api/admin/task/list' },
      { args: ['goal', 'list'], path: '/api/admin/goal/get' },
      { args: ['space', 'list'], path: '/api/admin/space/list' },
    ]) {
      const before = requests.length;
      await execFileAsync(process.execPath, [outfile, ...contract.args, '--json'], {
        cwd: repoRoot,
        env: { ...process.env, VITEST: '', MYAGENTS_PORT: String(address.port) },
      });
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).url, contract.path);
    }
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
});
