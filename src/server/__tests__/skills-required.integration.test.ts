import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_SYSTEM_SKILLS } from '../../shared/systemSkills';
import type { SkillItem, SkillsListResponse } from '../../shared/skillsTypes';

const OPTIONAL_SYSTEM_SKILL = 'prompt-writer';

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve test port');
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return address.port;
}

async function waitForReady(baseUrl: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Sidecar has not bound yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for skills test sidecar:\n${output()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;

  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise(resolveExit => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    // Close the race between the caller's exitCode check and listener setup.
    if (child.exitCode !== null) finish(true);
  });

  child.kill('SIGTERM');
  if (await waitForExit(3_000)) return;
  child.kill('SIGKILL');
  if (!await waitForExit(3_000)) {
    throw new Error(`Skills test sidecar did not exit after SIGKILL (pid=${child.pid ?? 'unknown'})`);
  }
}

function writeSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

function byFolder(skills: SkillItem[], folderName: string): SkillItem {
  const skill = skills.find(candidate => candidate.folderName === folderName);
  if (!skill) throw new Error(`Missing skill ${folderName}`);
  return skill;
}

describe('required system skill API contract', () => {
  it('projects ownership/required state, rejects required disables, and normalizes legacy config', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-required-skills-'));
    const home = join(scratch, 'home');
    const workspace = join(scratch, 'workspace');
    const userSkills = join(home, '.myagents', 'skills');
    const projectSkills = join(workspace, '.claude', 'skills');
    const configPath = join(home, '.myagents', 'skills-config.json');
    mkdirSync(userSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });
    mkdirSync(join(scratch, 'tmp'), { recursive: true });

    for (const name of [...REQUIRED_SYSTEM_SKILLS, OPTIONAL_SYSTEM_SKILL, 'user-skill']) {
      writeSkill(userSkills, name);
    }
    // Same folder name at project scope is user-owned and must not inherit the
    // global system lifecycle flags.
    writeSkill(projectSkills, 'myagents-cli');
    writeFileSync(configPath, JSON.stringify({
      seeded: [],
      disabled: [...REQUIRED_SYSTEM_SKILLS, OPTIONAL_SYSTEM_SKILL, 'user-skill'],
      generation: 0,
    }, null, 2));

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    let output = '';
    const child = spawn(process.execPath, [
      '--import',
      'tsx/esm',
      resolve('src/server/index.ts'),
      '--agent-dir', workspace,
      '--port', String(port),
      '--no-pre-warm',
      '--sidecar-role', 'global',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: join(scratch, 'tmp'),
        TEMP: join(scratch, 'tmp'),
        TMP: join(scratch, 'tmp'),
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });

    try {
      await waitForReady(baseUrl, () => output);

      const userResponse = await fetch(`${baseUrl}/api/skills?scope=user`);
      expect(userResponse.ok).toBe(true);
      const userBody = await userResponse.json() as SkillsListResponse;
      expect(userBody.success).toBe(true);
      for (const name of REQUIRED_SYSTEM_SKILLS) {
        expect(byFolder(userBody.skills, name)).toMatchObject({
          scope: 'user',
          systemOwned: true,
          required: true,
          enabled: true,
        });
      }
      expect(byFolder(userBody.skills, OPTIONAL_SYSTEM_SKILL)).toMatchObject({
        systemOwned: true,
        required: false,
        enabled: false,
      });
      expect(byFolder(userBody.skills, 'user-skill')).toMatchObject({
        systemOwned: false,
        required: false,
        enabled: false,
      });

      const projectResponse = await fetch(`${baseUrl}/api/skills?scope=project`);
      const projectBody = await projectResponse.json() as SkillsListResponse;
      expect(byFolder(projectBody.skills, 'myagents-cli')).toMatchObject({
        scope: 'project',
        systemOwned: false,
        required: false,
        enabled: true,
      });

      const baselineConfig = readFileSync(configPath, 'utf8');
      for (const folderName of REQUIRED_SYSTEM_SKILLS) {
        const response = await fetch(`${baseUrl}/api/skill/toggle-enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName, enabled: false }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ success: false });
        expect(readFileSync(configPath, 'utf8')).toBe(baselineConfig);
      }

      // Reintroduce stale required entries and prove the next ordinary write
      // canonicalizes only those entries while preserving optional disables.
      const current = JSON.parse(readFileSync(configPath, 'utf8')) as {
        seeded: string[];
        disabled: string[];
        generation: number;
      };
      writeFileSync(configPath, JSON.stringify({
        ...current,
        disabled: [...REQUIRED_SYSTEM_SKILLS, OPTIONAL_SYSTEM_SKILL],
      }, null, 2));
      const optionalResponse = await fetch(`${baseUrl}/api/skill/toggle-enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName: 'user-skill', enabled: false }),
      });
      expect(optionalResponse.ok).toBe(true);
      const normalized = JSON.parse(readFileSync(configPath, 'utf8')) as { disabled: string[] };
      expect(normalized.disabled).toEqual([OPTIONAL_SYSTEM_SKILL, 'user-skill']);
    } finally {
      await stopChild(child);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 45_000);
});
