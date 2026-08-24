import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from '../utils/subprocess';

const realScript = fileURLToPath(
  new URL(
    '../../../bundled-agents/myagents_helper/.claude/skills/support/scripts/redact-log-output.mjs',
    import.meta.url,
  ),
);
const realSupportDir = dirname(dirname(realScript));

interface RedactorResult {
  error?: Error;
  status: number;
  stderr: string;
  stdout: string;
}

async function runRedactor(scriptPath: string): Promise<RedactorResult> {
  const processHandle = spawn([process.execPath, scriptPath], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = processHandle.stdout
    ? new Response(processHandle.stdout).text()
    : Promise.resolve('');
  const stderrPromise = processHandle.stderr
    ? new Response(processHandle.stderr).text()
    : Promise.resolve('');

  await processHandle.stdin?.write(
    'token=example-secret-value\n/Users/alice/project/log.txt\n',
  );
  await processHandle.stdin?.end();

  const [status, stdout, stderr] = await Promise.all([
    processHandle.exited,
    stdoutPromise,
    stderrPromise,
  ]);

  return {
    error: processHandle.error,
    status,
    stderr,
    stdout,
  };
}

function expectSuccessfulRedaction(result: RedactorResult) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('token=<redacted>');
  expect(result.stdout).toContain('<HOME>/project/log.txt');
  expect(result.stdout).not.toContain('example-secret-value');
  expect(result.stdout).not.toContain('/Users/alice');
}

describe('support log redactor CLI', () => {
  let scratchDir: string;
  let linkedScript: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'myagents-support-redactor-'));
    const linkedSupportDir = join(scratchDir, 'support');
    symlinkSync(
      realSupportDir,
      linkedSupportDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    linkedScript = join(linkedSupportDir, 'scripts', 'redact-log-output.mjs');
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('redacts stdin when launched through the bundled real path', async () => {
    expectSuccessfulRedaction(await runRedactor(realScript));
  });

  it('redacts stdin when the support skill is exposed through a directory link', async () => {
    expectSuccessfulRedaction(await runRedactor(linkedScript));
  });
});
