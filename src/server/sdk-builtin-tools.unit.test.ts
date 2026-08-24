import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SDK_BUILTIN_TOOLS, SDK_EXCLUDED_BUILTIN_TOOLS } from './sdk-builtin-tools';

describe('Claude Agent SDK builtin catalog', () => {
  it('keeps the product-owned 26-tool catalog exact and duplicate-free', () => {
    expect(SDK_BUILTIN_TOOLS).toEqual([
      'Read',
      'Write',
      'Edit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'Skill',
      'Task',
      'TaskStop',
      'SendMessage',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Monitor',
      'ReportFindings',
      'Workflow',
      'ScheduleWakeup',
      'EnterWorktree',
      'ExitWorktree',
    ]);
    expect(new Set(SDK_BUILTIN_TOOLS).size).toBe(26);
    expect(SDK_BUILTIN_TOOLS).not.toContain('TaskOutput');
  });

  it('does not expose any product-excluded builtin', () => {
    expect(SDK_EXCLUDED_BUILTIN_TOOLS).toHaveLength(5);
    for (const tool of SDK_EXCLUDED_BUILTIN_TOOLS) {
      expect(SDK_BUILTIN_TOOLS).not.toContain(tool);
    }
  });

  it('keeps control-plane SDK queries tool-free while product sessions use the catalog', () => {
    for (const relativePath of [
      'provider-verify.ts',
      'subscription-auth.ts',
      'title-generator.ts',
      'official-tools/vision.ts',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      const queryCount = source.match(/\bquery\(\{/g)?.length ?? 0;
      const disabledToolCount = source.match(/\btools:\s*\[\]/g)?.length ?? 0;
      expect(queryCount, `${relativePath} should contain a production SDK query`).toBeGreaterThan(0);
      expect(disabledToolCount, `${relativePath} must disable tools on every control query`).toBeGreaterThanOrEqual(queryCount);
    }

    const sessionSource = readFileSync(new URL('agent-session.ts', import.meta.url), 'utf8');
    expect(sessionSource).toContain('tools: [...SDK_BUILTIN_TOOLS]');
  });
});
