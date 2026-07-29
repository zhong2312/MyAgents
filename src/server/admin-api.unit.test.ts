import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentSessionMocks = vi.hoisted(() => ({
  agentDir: undefined as string | undefined,
  setMcpServers: vi.fn(),
  setAgents: vi.fn(),
  getMcpServers: vi.fn(() => []),
  getSidecarPort: vi.fn(() => 0),
  getQueueStatus: vi.fn(() => []),
  forceReloadActiveSession: vi.fn(),
}));

const managementApiMocks = vi.hoisted(() => ({
  managementApi: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, taskUpdated: 0, cronUpdated: 0 })),
}));

const adminConfigBehavior = vi.hoisted(() => ({
  failProjectWrite: false,
  failNextConfigWrite: false,
  delayNextIntent: false,
  intentGate: undefined as Promise<void> | undefined,
  onIntentBlocked: undefined as (() => void) | undefined,
}));

vi.mock('./utils/admin-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/admin-config')>();
  return {
    ...actual,
    atomicModifyConfig: async (...args: Parameters<typeof actual.atomicModifyConfig>) => {
      if (adminConfigBehavior.failNextConfigWrite) {
        adminConfigBehavior.failNextConfigWrite = false;
        throw new Error('injected config.json write failure');
      }
      return actual.atomicModifyConfig(...args);
    },
    withAgentConfigIntentLock: async <T>(fn: () => Promise<T>) => {
      if (adminConfigBehavior.delayNextIntent) {
        adminConfigBehavior.delayNextIntent = false;
        adminConfigBehavior.onIntentBlocked?.();
        await adminConfigBehavior.intentGate;
      }
      return actual.withAgentConfigIntentLock(fn);
    },
    atomicModifyProjects: async (...args: Parameters<typeof actual.atomicModifyProjects>) => {
      if (adminConfigBehavior.failProjectWrite) {
        throw new Error('injected projects.json write failure');
      }
      return actual.atomicModifyProjects(...args);
    },
  };
});

const sessionEngineMocks = vi.hoisted(() => {
  const state = {
    context: { sessionId: null as string | null, workspacePath: null as string | null },
    turnIdentity: null as { queueId: string; owner: { kind: 'goal' | 'task'; id: string } } | null,
    origins: new Map<string, unknown>(),
  };
  return {
    state,
    getCurrentSessionContext: vi.fn(() => state.context),
    getCurrentTurnIdentity: vi.fn(() => state.turnIdentity),
    getSessionOrigin: vi.fn((sessionId: string) => state.origins.get(sessionId)),
  };
});

vi.mock('./agent-session', () => ({
  SDK_RESERVED_MCP_NAMES: new Set<string>(),
  getAgentState: () => ({ agentDir: agentSessionMocks.agentDir }),
  setMcpServers: agentSessionMocks.setMcpServers,
  setAgents: agentSessionMocks.setAgents,
  getMcpServers: agentSessionMocks.getMcpServers,
  getSidecarPort: agentSessionMocks.getSidecarPort,
  getQueueStatus: agentSessionMocks.getQueueStatus,
  forceReloadActiveSession: agentSessionMocks.forceReloadActiveSession,
}));

vi.mock('./sse', () => ({
  broadcast: vi.fn(),
}));

vi.mock('./utils/management-api-client', () => ({
  ADMIN_LOOPBACK_TIMEOUT_MS: 10_000,
  managementApi: managementApiMocks.managementApi,
}));

vi.mock('./session-engine', () => ({
  getSessionEngine: () => ({
    getCurrentSessionContext: sessionEngineMocks.getCurrentSessionContext,
    getCurrentTurnIdentity: sessionEngineMocks.getCurrentTurnIdentity,
    getSessionOrigin: sessionEngineMocks.getSessionOrigin,
  }),
}));

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scratch, '.myagents', 'config.json'), 'utf-8')) as Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>[];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-api-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  vi.resetModules();
  agentSessionMocks.agentDir = undefined;
  agentSessionMocks.setMcpServers.mockClear();
  managementApiMocks.managementApi.mockClear();
  managementApiMocks.managementApi.mockResolvedValue({ ok: true, taskUpdated: 0, cronUpdated: 0 });
  adminConfigBehavior.failProjectWrite = false;
  adminConfigBehavior.failNextConfigWrite = false;
  adminConfigBehavior.delayNextIntent = false;
  adminConfigBehavior.intentGate = undefined;
  adminConfigBehavior.onIntentBlocked = undefined;
  sessionEngineMocks.state.context = { sessionId: null, workspacePath: null };
  sessionEngineMocks.state.turnIdentity = null;
  sessionEngineMocks.state.origins.clear();
  sessionEngineMocks.getCurrentSessionContext.mockClear();
  sessionEngineMocks.getCurrentTurnIdentity.mockClear();
  sessionEngineMocks.getSessionOrigin.mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('admin-api help registry', () => {
  it('keeps im send-media leaf help aligned with the executable file flag contract', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['im', 'send-media'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('send-media --file <path> [--caption <text>]');
    expect(text).not.toContain('send-media <path>');
  });

  it('documents the official vision command group for myagents vision --help', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['vision'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents vision');
    expect(text).toContain('analyze');
    expect(text).not.toContain('Unknown command group');
  });

  it('documents Goal Mode for myagents goal --help', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['goal'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents goal');
    expect(text).toContain('Goal Mode');
    expect(text).toContain('create --objective');
    expect(text).toContain('--deadline <ISO-8601-with-offset>');
    expect(text).toContain('--max-executions <positive-integer>');
    expect(text).toContain('--ai-can-exit <true|false>');
    expect(text).toContain('outside the current');
    expect(text).toContain('not a delayed start');
    expect(text).toContain('update --status complete');
    expect(text).toContain('Do not infer Goal Mode');
    expect(text).not.toContain('Unknown command group');
  });

  it('does not advertise loop schedule creation from ordinary cron help', async () => {
    const { handleHelp } = await import('./admin-api');

    const shortHelp = handleHelp({ path: ['cron'] });
    const readme = handleHelp({ path: ['cron', 'readme'] });
    const shortText = (shortHelp.data as { text?: string } | undefined)?.text ?? '';
    const readmeText = (readme.data as { text?: string } | undefined)?.text ?? '';

    expect(shortHelp.success).toBe(true);
    expect(readme.success).toBe(true);
    expect(shortText).not.toContain('{"kind":"loop"}');
    expect(readmeText).not.toContain('{"kind":"loop"}');
    expect(shortText).toContain('--prompt-file is supported');
    expect(handleHelp({ path: ['goal'] }).success).toBe(true);
  });

  it('includes vision in the derived command group list', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['definitely-not-a-command'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('Unknown command group "definitely-not-a-command"');
    expect(text).toContain('vision');
  });

  it('does not expose the legacy issue alias as a help command group', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['issue'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('Unknown command group "issue"');
    expect(text).toContain('space');
    expect(text).not.toContain('Legacy read-only alias');
  });

  it('uses the longest Space command path so leaf help is an executable Agent contract', async () => {
    const { handleHelp } = await import('./admin-api');

    const result = handleHelp({ path: ['space', 'issue', 'attachment', 'add'] });
    const text = (result.data as { text?: string } | undefined)?.text ?? '';

    expect(result.success).toBe(true);
    expect(text).toContain('myagents space issue attachment add');
    expect(text).toContain('WHEN TO CALL');
    expect(text).toContain('ACTOR AND PERMISSIONS');
    expect(text).toContain('FILE SAFETY');
    expect(text).toContain('--space <slug>');
    expect(text).not.toContain('myagents space — Work with');
  });

  it('provides an independent Agent contract for every Space Issue leaf', async () => {
    const { handleHelp } = await import('./admin-api');
    const leaves = [
      ['space', 'issue', 'list'],
      ['space', 'issue', 'view'],
      ['space', 'issue', 'comments'],
      ['space', 'issue', 'status'],
      ['space', 'issue', 'claim'],
      ['space', 'issue', 'close'],
      ['space', 'issue', 'cancel-claim'],
    ];
    for (const path of leaves) {
      const result = handleHelp({ path });
      const text = (result.data as { text?: string } | undefined)?.text ?? '';
      expect(text, path.join(' ')).toContain('WHEN TO CALL');
      expect(text, path.join(' ')).toContain('RECOVERY');
      expect(text, path.join(' ')).not.toContain('myagents space — Work with');
    }
  });

  it('provides exact nine-section contracts for Goal discovery and Issue metadata update', async () => {
    const { handleHelp } = await import('./admin-api');
    const sections = [
      'WHEN TO CALL',
      'EFFECT',
      'REQUIRED CONTEXT',
      'OPTIONS',
      'ACTOR AND PERMISSIONS',
      'FILE SAFETY',
      'OUTPUT',
      'EXAMPLES',
      'RECOVERY',
    ];

    const goalText = String((handleHelp({ path: ['space', 'goal', 'list'] }).data as { text?: string })?.text ?? '');
    const updateText = String((handleHelp({ path: ['space', 'issue', 'update'] }).data as { text?: string })?.text ?? '');
    for (const section of sections) {
      expect(goalText).toContain(section);
      expect(updateText).toContain(section);
    }
    expect(goalText).toContain('data.items[].id');
    expect(goalText).toContain('archived IDs cannot be assigned');
    expect(goalText).toContain('Session Goal Mode');
    expect(updateText).toContain('--clear-goal');
    expect(updateText).toContain('does not change workflow state, assignee, claim');
    expect(updateText).toContain('does not support --dry-run');
    expect(goalText).not.toContain('myagents space — Discover');
    expect(updateText).not.toContain('myagents space — Discover');
  });

  it('keeps Space group and related Issue help aligned on discovery, Inbox, and Goal output', async () => {
    const { handleHelp } = await import('./admin-api');
    const spaceText = String((handleHelp({ path: ['space'] }).data as { text?: string })?.text ?? '');
    const issueText = String((handleHelp({ path: ['space', 'issue'] }).data as { text?: string })?.text ?? '');
    const createText = String((handleHelp({ path: ['space', 'issue', 'create'] }).data as { text?: string })?.text ?? '');
    const listText = String((handleHelp({ path: ['space', 'issue', 'list'] }).data as { text?: string })?.text ?? '');
    const viewText = String((handleHelp({ path: ['space', 'issue', 'view'] }).data as { text?: string })?.text ?? '');

    expect(spaceText).toContain('DISCOVERY FLOW FOR AGENTS');
    expect(spaceText).toContain('GOAL NAMESPACES');
    expect(issueText).toContain('update <issueId>');
    expect(createText).toContain('Without --goal it enters Inbox');
    expect(createText).toContain('goalId, goalPathLabel');
    expect(listText).toContain('--goal <goalId>|inbox');
    expect(listText).toContain('--include-subtree <true|false>');
    expect(viewText).toContain('issue.goalId');
    expect(viewText).toContain('issue.goalPathLabel');
  });
});

describe('admin-api Space workspace identity', () => {
  it('forwards Goal discovery and Issue update through the existing Space management bridge', async () => {
    managementApiMocks.managementApi
      .mockResolvedValueOnce({ ok: true, data: { items: [] } })
      .mockResolvedValueOnce({ ok: true, data: { issue: { id: 'iss_1' } } });
    const { handleSpaceGoalList, handleSpaceIssueUpdate } = await import('./admin-api');

    const goalResult = await handleSpaceGoalList({ spaceSlug: 'official', includeArchived: true });
    const updateResult = await handleSpaceIssueUpdate({
      spaceSlug: 'official',
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });

    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(1, '/api/space/goal-list', 'POST', {
      spaceSlug: 'official',
      includeArchived: true,
    });
    expect(managementApiMocks.managementApi).toHaveBeenNthCalledWith(2, '/api/space/issue-update', 'POST', {
      spaceSlug: 'official',
      issueId: 'iss_1',
      goalUpdate: { action: 'clear' },
    });
    expect(goalResult).toMatchObject({ success: true, hint: expect.stringContaining('data.items[].id') });
    expect(updateResult).toMatchObject({ success: true, hint: expect.stringContaining('Re-read') });
  });

  it('enriches Space commands with the stable project id for the requested workspace', async () => {
    const workspace = join(scratch, 'workspace');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-stable-id',
      name: 'Workspace',
      path: workspace,
    }]);
    agentSessionMocks.agentDir = workspace;
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({ spaceSlug: 'official', workspacePath: workspace });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-stable-id',
    });
  });

  it('preserves an explicit workspace id so identity mismatches fail closed downstream', async () => {
    const workspace = join(scratch, 'workspace-explicit');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-stable-id',
      name: 'Workspace',
      path: workspace,
    }]);
    agentSessionMocks.agentDir = workspace;
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'explicit-mismatching-id',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'explicit-mismatching-id',
    });
  });

  it('forwards only the exact persisted Registered Agent Session origin as actor authority', async () => {
    const workspace = join(scratch, 'workspace-origin');
    mkdirSync(workspace);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-origin',
      name: 'Origin Workspace',
      path: workspace,
    }]);
    sessionEngineMocks.state.origins.set('session-agent-a', {
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: { spaceId: 'space-a', registeredAgentId: 'agent-a' },
    });
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, data: { actor: {} } });
    const { handleSpaceWhoami } = await import('./admin-api');

    await handleSpaceWhoami({
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-origin',
      sessionId: 'session-agent-a',
    });

    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/space/whoami', 'POST', {
      spaceSlug: 'official',
      workspacePath: workspace,
      workspaceId: 'project-origin',
      sessionId: 'session-agent-a',
      sessionOrigin: { spaceId: 'space-a', registeredAgentId: 'agent-a' },
    });
  });
});

describe('admin-api goal', () => {
  it('creates a current-session Goal without Cron delivery ownership', async () => {
    const { setImCronContext, clearImCronContext } = await import('./tools/im-cron-tool');
    const { handleGoalCreate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-im-goal',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    setImCronContext({
      botId: 'bot-feishu',
      chatId: 'chat-123',
      platform: 'feishu',
      workspacePath: '/tmp/myagents-goal-workspace',
    });
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      goal: { id: 'goal_1', objective: 'Ship it', status: 'active' },
    });

    const result = await handleGoalCreate({ objective: 'Ship it' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/create', 'POST', {
      sessionId: 'session-im-goal',
      workspacePath: '/tmp/myagents-goal-workspace',
      objective: 'Ship it',
    });
    clearImCronContext();
  });

  it('forwards existing Goal end conditions to the Rust authority', async () => {
    const { handleGoalCreate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-goal-with-limits',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: true,
      goal: { id: 'goal_limited', objective: 'Ship it', status: 'active' },
    });

    const endConditions = {
      deadline: '2026-07-22T01:00:00.000Z',
      maxExecutions: 5,
      aiCanExit: false,
    };
    const result = await handleGoalCreate({ objective: 'Ship it', endConditions });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/create', 'POST', {
      sessionId: 'session-goal-with-limits',
      workspacePath: '/tmp/myagents-goal-workspace',
      objective: 'Ship it',
      endConditions,
    });
  });

  it('forwards the active queue turn when the model terminalizes a Goal', async () => {
    const { handleGoalUpdate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
    };
    sessionEngineMocks.state.turnIdentity = {
      queueId: 'queue-current',
      owner: { kind: 'goal', id: 'goal-1' },
    };
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, goal: { id: 'goal-1' } });

    const result = await handleGoalUpdate({ status: 'complete', reason: 'done' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/goal/update', 'POST', {
      sessionId: 'session-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
      goalId: 'goal-1',
      queueId: 'queue-current',
      status: 'complete',
      reason: 'done',
    });
  });

  it('rejects a terminal update without a current Goal-owned queue turn', async () => {
    const { handleGoalUpdate } = await import('./admin-api');
    sessionEngineMocks.state.context = {
      sessionId: 'session-stale-goal-turn',
      workspacePath: '/tmp/myagents-goal-workspace',
    };

    const result = await handleGoalUpdate({ status: 'complete', reason: 'stale completion' });

    expect(result).toEqual({
      success: false,
      error: 'Goal terminal update requires the active Goal turn authority',
    });
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api cron create', () => {
  it('leaves execution routing unset when the caller did not request a Task override', async () => {
    const workspacePath = '/tmp/myagents-managed-codex-workspace';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      defaultProviderId: 'anthropic-sub',
      agents: [{
        id: 'agent-managed-codex',
        name: 'Managed Codex',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
      }],
    });
    const { handleCronCreate } = await import('./admin-api');

    const result = await handleCronCreate({
      name: 'follow-agent',
      message: 'Do work',
      workspacePath,
      intervalMinutes: 5,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.preview).toMatchObject({
      name: 'follow-agent',
      message: 'Do work',
      workspacePath,
      intervalMinutes: 5,
    });
    expect(result.preview).not.toHaveProperty('providerId');
    expect(result.preview).not.toHaveProperty('model');
    expect(result.preview).not.toHaveProperty('runtime');
    expect(result.preview).not.toHaveProperty('runtimeConfig');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects loop schedules before ordinary cron creation reaches Rust', async () => {
    const { handleCronCreate } = await import('./admin-api');

    const result = await handleCronCreate({
      prompt: 'Keep going',
      schedule: { kind: 'loop' },
      workspacePath: '/tmp/myagents-goal-workspace',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Use myagents goal create');
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });
});

describe('admin-api agent set configuration intent', () => {
  it('normalizes managed Codex permission vocabulary without changing provider or model', async () => {
    const workspacePath = '/tmp/myagents-agent-set-managed-codex';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-codex',
        name: 'Managed Codex',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-codex',
      name: 'Managed Codex',
      path: workspacePath,
      agentId: 'agent-managed-codex',
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-managed-codex',
      key: 'permissionMode',
      value: 'no-restrictions',
    });

    expect(result.success).toBe(true);
    const agent = (readConfig().agents as Record<string, unknown>[])[0];
    expect(agent).toMatchObject({
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      runtime: 'builtin',
      permissionMode: 'fullAgency',
    });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'fullAgency',
    });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      { agentId: 'agent-managed-codex', patch: { permissionMode: 'fullAgency' } },
    );
  });

  it('rejects an invalid permission mode without mutating either config store', async () => {
    const workspacePath = '/tmp/myagents-agent-set-invalid';
    const config = {
      agents: [{
        id: 'agent-invalid',
        name: 'Invalid Guard',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-opus-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-invalid',
      name: 'Invalid Guard',
      path: workspacePath,
      agentId: 'agent-invalid',
      providerId: 'anthropic-sub',
      model: 'claude-opus-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-invalid',
      key: 'permissionMode',
      value: 'unlimited-magic',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Valid');
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('rejects managed Codex full-auto instead of escalating it to no-restrictions', async () => {
    const workspacePath = '/tmp/myagents-agent-set-full-auto';
    const config = {
      agents: [{
        id: 'agent-full-auto',
        name: 'Full Auto Guard',
        workspacePath,
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        permissionMode: 'auto',
      }],
    };
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-full-auto',
      name: 'Full Auto Guard',
      path: workspacePath,
      agentId: 'agent-full-auto',
      providerId: 'codex-sub',
      model: 'gpt-5.6-sol',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-full-auto',
      key: 'permissionMode',
      value: 'full-auto',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be stored losslessly');
    expect(readConfig()).toEqual(config);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it.each([
    ['providerId', 'provider-that-does-not-exist', 'Unknown providerId'],
    ['model', 'claude-typo-does-not-exist', 'is not registered'],
  ])('rejects invalid %s before either store or live state changes', async (key, value, errorText) => {
    const workspacePath = '/tmp/myagents-agent-set-invalid-provider-model';
    const config = {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-invalid-route',
        name: 'Invalid Route Guard',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-invalid-route',
      name: 'Invalid Route Guard',
      path: workspacePath,
      agentId: 'agent-invalid-route',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-invalid-route', key, value });

    expect(result.success).toBe(false);
    expect(result.error).toContain(errorText);
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it.each([
    ['custom-added-model', ['claude-opus-4-6'], true],
    ['claude-opus-4-6', ['claude-opus-4-6'], false],
  ])('validates model %s against preset additions/removals shared with the product catalog', async (
    value,
    removedModels,
    addCustomModel,
  ) => {
    const workspacePath = `/tmp/myagents-agent-effective-model-${value}`;
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      presetCustomModels: addCustomModel
        ? {
            'anthropic-sub': [{
              model: 'custom-added-model',
              modelName: 'Custom Added Model',
              modelSeries: 'claude',
              source: 'manual',
            }],
          }
        : undefined,
      presetRemovedModels: { 'anthropic-sub': removedModels },
      agents: [{
        id: 'agent-effective-model',
        name: 'Effective Model',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-effective-model',
      name: 'Effective Model',
      path: workspacePath,
      agentId: 'agent-effective-model',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-effective-model', key: 'model', value });

    expect(result.success).toBe(addCustomModel);
    if (addCustomModel) {
      expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({ model: value });
      expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ model: value });
    } else {
      expect(result.error).toContain('not registered');
    }
  });

  it('rolls back the Agent write when the Project mirror cannot be saved', async () => {
    const workspacePath = '/tmp/myagents-agent-set-project-failure';
    const config = {
      agents: [{
        id: 'agent-project-failure',
        name: 'Project Failure',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-failure',
      name: 'Project Failure',
      path: workspacePath,
      agentId: 'agent-project-failure',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');
    adminConfigBehavior.failProjectWrite = true;

    const result = await handleAgentSet({
      id: 'agent-project-failure',
      key: 'permissionMode',
      value: 'plan',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Project mirror could not be saved');
    expect((readConfig().agents as Record<string, unknown>[])[0]).toEqual(config.agents[0]);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('serializes concurrent Agent intents so Agent and Project end on the same value', async () => {
    const workspacePath = '/tmp/myagents-agent-set-concurrent';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-concurrent',
        name: 'Concurrent',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-concurrent',
      name: 'Concurrent',
      path: workspacePath,
      agentId: 'agent-concurrent',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const results = await Promise.all([
      handleAgentSet({ id: 'agent-concurrent', key: 'model', value: 'claude-opus-4-6' }),
      handleAgentSet({ id: 'agent-concurrent', key: 'model', value: 'claude-haiku-4-5' }),
    ]);

    expect(results.every(result => result.success)).toBe(true);
    const agentModel = ((readConfig().agents as Record<string, unknown>[])[0]).model;
    const projectModel = readJson(join(scratch, '.myagents', 'projects.json'))[0].model;
    expect(projectModel).toBe(agentModel);
    expect(['claude-opus-4-6', 'claude-haiku-4-5']).toContain(agentModel);
  });

  it('validates a delayed model intent against the provider committed before its lock turn', async () => {
    const workspacePath = '/tmp/myagents-agent-set-validation-lock';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
        'xai-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-validation-lock',
        name: 'Validation Lock',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-validation-lock',
      name: 'Validation Lock',
      path: workspacePath,
      agentId: 'agent-validation-lock',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');
    let releaseIntent!: () => void;
    let markIntentBlocked!: () => void;
    adminConfigBehavior.intentGate = new Promise<void>(resolve => { releaseIntent = resolve; });
    const intentBlocked = new Promise<void>(resolve => { markIntentBlocked = resolve; });
    adminConfigBehavior.onIntentBlocked = markIntentBlocked;
    adminConfigBehavior.delayNextIntent = true;

    const delayedModel = handleAgentSet({
      id: 'agent-validation-lock',
      key: 'model',
      value: 'claude-haiku-4-5',
    });
    await intentBlocked;
    const providerResult = await handleAgentSet({
      id: 'agent-validation-lock',
      key: 'providerId',
      value: 'xai-sub',
    });
    releaseIntent();
    const modelResult = await delayedModel;

    expect(providerResult.success).toBe(true);
    expect(modelResult.success).toBe(false);
    expect(modelResult.error).toContain("not registered for provider 'xai-sub'");
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({
      providerId: 'xai-sub',
      model: 'claude-sonnet-4-6',
    });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({
      providerId: 'xai-sub',
      model: 'claude-sonnet-4-6',
    });
  });

  it.each([
    ['providerId', 'anthropic-sub'],
    ['model', 'claude-opus-4-6'],
  ])('mirrors %s to the Project compatibility store and reloads the live Agent', async (key, value) => {
    const workspacePath = '/tmp/myagents-agent-set-mirror';
    const initialProviderId = key === 'model' ? 'anthropic-sub' : 'codex-sub';
    const initialModel = key === 'model' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      providerVerifyStatus: {
        'anthropic-sub': { status: 'valid', verifiedAt: '2026-07-21T00:00:00.000Z' },
      },
      agents: [{
        id: 'agent-mirror',
        name: 'Mirror',
        workspacePath,
        providerId: initialProviderId,
        model: initialModel,
        permissionMode: 'fullAgency',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-mirror',
      name: 'Mirror',
      path: workspacePath,
      agentId: 'agent-mirror',
      providerId: initialProviderId,
      model: initialModel,
      permissionMode: 'fullAgency',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-mirror', key, value });

    expect(result.success).toBe(true);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ [key]: value });
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/reload-config',
      'POST',
      {
        agentId: 'agent-mirror',
        patch: {
          [key]: value,
          ...(key === 'providerId' ? { providerEnvJson: null } : {}),
        },
      },
    );
  });

  it.each([
    ['providerId', 'codex-sub'],
    ['model', 'gpt-5.6-sol'],
  ])('accepts managed Codex %s changes through the product provider catalog', async (key, value) => {
    const workspacePath = `/tmp/myagents-agent-managed-${key}`;
    const settingProvider = key === 'providerId';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      managedCodexProviderDevGate: true,
      managedCodexRuntimeInstall: { status: 'installed', usable: true },
      managedCodexAuth: { status: 'valid', authMethod: 'chatgpt' },
      agents: [{
        id: 'agent-managed-set',
        name: 'Managed Set',
        workspacePath,
        providerId: settingProvider ? 'anthropic-sub' : 'codex-sub',
        model: settingProvider ? 'claude-sonnet-4-6' : 'gpt-5.4-codex',
        permissionMode: 'auto',
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-managed-set',
      name: 'Managed Set',
      path: workspacePath,
      agentId: 'agent-managed-set',
      providerId: settingProvider ? 'anthropic-sub' : 'codex-sub',
      model: settingProvider ? 'claude-sonnet-4-6' : 'gpt-5.4-codex',
      permissionMode: 'auto',
    }]);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({ id: 'agent-managed-set', key, value });

    expect(result.success).toBe(true);
    expect((readConfig().agents as Record<string, unknown>[])[0]).toMatchObject({ [key]: value });
    expect(readJson(join(scratch, '.myagents', 'projects.json'))[0]).toMatchObject({ [key]: value });
  });

  it('rejects an unverified subscription provider before mutating either store', async () => {
    const workspacePath = '/tmp/myagents-agent-unverified-subscription';
    const config = {
      agents: [{
        id: 'agent-unverified-subscription',
        name: 'Unverified Subscription',
        workspacePath,
        providerId: 'anthropic-sub',
        model: 'claude-sonnet-4-6',
        permissionMode: 'auto',
      }],
    };
    const projects = [{
      id: 'project-unverified-subscription',
      name: 'Unverified Subscription',
      path: workspacePath,
      agentId: 'agent-unverified-subscription',
      providerId: 'anthropic-sub',
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    }];
    writeJson(join(scratch, '.myagents', 'config.json'), config);
    writeJson(join(scratch, '.myagents', 'projects.json'), projects);
    const { handleAgentSet } = await import('./admin-api');

    const result = await handleAgentSet({
      id: 'agent-unverified-subscription',
      key: 'providerId',
      value: 'xai-sub',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not verified');
    expect(readConfig()).toEqual(config);
    expect(readJson(join(scratch, '.myagents', 'projects.json'))).toEqual(projects);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('shows managed Codex as its effective runtime instead of the stored builtin carrier', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-managed-show',
        name: 'Managed Show',
        workspacePath: '/tmp/myagents-agent-managed-show',
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        runtime: 'builtin',
        permissionMode: 'fullAgency',
      }],
    });
    const { handleAgentShow } = await import('./admin-api');

    const result = handleAgentShow({ id: 'agent-managed-show' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      effectiveDefaults: {
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        providerId: 'codex-sub',
        model: 'gpt-5.6-sol',
        permissionMode: 'no-restrictions',
      },
    });
  });
});

describe('admin-api model add', () => {
  it('expands custom provider models from repeated and comma-separated CLI inputs', async () => {
    const { handleModelAdd } = await import('./admin-api');

    const result = await handleModelAdd({
      dryRun: true,
      provider: {
        id: 'sensenova',
        name: 'SensNova',
        baseUrl: 'https://token.sensenova.cn/v1',
        apiProtocol: 'openai',
        authType: 'api_key',
        models: ['sensenova-6.7-flash-lite, deepseek-v4-flash', 'glm-5.2', 'deepseek-v4-flash'],
        modelNames: ['Flash Lite', 'DeepSeek Flash', 'GLM 5.2', 'Duplicate Name'],
        primaryModel: 'deepseek-v4-flash',
      },
    });

    expect(result.success).toBe(true);
    const preview = result.preview as { models: Array<{ model: string; modelName: string }>; primaryModel: string };
    expect(preview.primaryModel).toBe('deepseek-v4-flash');
    expect(preview.models).toEqual([
      { model: 'sensenova-6.7-flash-lite', modelName: 'Flash Lite', modelSeries: 'sensenova' },
      { model: 'deepseek-v4-flash', modelName: 'DeepSeek Flash', modelSeries: 'sensenova' },
      { model: 'glm-5.2', modelName: 'GLM 5.2', modelSeries: 'sensenova' },
    ]);
  });

  it('keeps GUI invalidation, CLI model detail, and IM provider projection aligned', async () => {
    const {
      handleModelAdd,
      handleModelList,
      handleModelSetKey,
      handleModelRemove,
    } = await import('./admin-api');

    const added = await handleModelAdd({
      provider: {
        id: 'snapshot-provider',
        name: 'Snapshot Provider',
        baseUrl: 'https://provider.example/v1',
        apiProtocol: 'openai',
        authType: 'api_key',
        models: ['model-primary', 'model-secondary'],
        modelNames: ['Primary', 'Secondary'],
        primaryModel: 'model-secondary',
      },
    });
    expect(added.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenLastCalledWith(
      '/api/app/config-changed',
      'POST',
      {},
      { timeoutMs: 2_000 },
    );

    const keyed = await handleModelSetKey({ id: 'snapshot-provider', apiKey: 'secret-key' });
    expect(keyed.success).toBe(true);
    const projection = JSON.parse(String(readConfig().availableProvidersJson)) as Array<Record<string, unknown>>;
    expect(projection).toContainEqual(expect.objectContaining({
      id: 'snapshot-provider',
      primaryModel: 'model-secondary',
      apiKey: 'secret-key',
      models: [
        { model: 'model-primary', modelName: 'Primary' },
        { model: 'model-secondary', modelName: 'Secondary' },
      ],
    }));

    const listed = handleModelList();
    expect(listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'snapshot-provider',
        primaryModel: 'model-secondary',
        models: [
          { model: 'model-primary', modelName: 'Primary' },
          { model: 'model-secondary', modelName: 'Secondary' },
        ],
      }),
    ]));

    const removed = await handleModelRemove({ id: 'snapshot-provider' });
    expect(removed.success).toBe(true);
    const projectionAfterRemove = readConfig().availableProvidersJson;
    const remaining = typeof projectionAfterRemove === 'string'
      ? JSON.parse(projectionAfterRemove) as Array<Record<string, unknown>>
      : [];
    expect(remaining.some(provider => provider.id === 'snapshot-provider')).toBe(false);
    expect(managementApiMocks.managementApi).toHaveBeenCalledTimes(3);
  });

  it('does not report mutation success when app-wide invalidation fails', async () => {
    const { handleModelSetDefault } = await import('./admin-api');
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: false, error: 'management offline' });

    await expect(handleModelSetDefault({ id: 'provider-a' })).rejects.toThrow(
      "Model configuration was saved, but app-wide refresh failed",
    );
    expect(readConfig().defaultProviderId).toBe('provider-a');
  });

  it('keeps the provider definition when remove config cleanup fails', async () => {
    const { handleModelAdd, handleModelRemove } = await import('./admin-api');
    const providerPath = join(scratch, '.myagents', 'providers', 'transaction-provider.json');
    const providerPayload = {
      id: 'transaction-provider',
      name: 'Transaction Provider',
      baseUrl: 'https://provider.example/v1',
      models: ['model-a'],
    };

    expect((await handleModelAdd({ provider: providerPayload })).success).toBe(true);
    expect(existsSync(providerPath)).toBe(true);

    adminConfigBehavior.failNextConfigWrite = true;
    await expect(handleModelRemove({ id: 'transaction-provider' })).rejects.toThrow(
      'injected config.json write failure',
    );
    expect(existsSync(providerPath)).toBe(true);
    expect(JSON.parse(readFileSync(providerPath, 'utf-8'))).toMatchObject({ id: 'transaction-provider' });
  });
});

describe('admin-api MCP project scope', () => {
  it('fails project-only enable when the current workspace is not registered', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'project' });

    expect(result.success).toBe(false);
    expect(readConfig().mcpEnabledServers).toEqual([]);
    expect(agentSessionMocks.setMcpServers).not.toHaveBeenCalled();
  });

  it('keeps global enable effective when project scope is skipped for an unregistered workspace', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'both' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'win-custom', projectScope: 'project-not-found' });
    expect(readConfig().mcpEnabledServers).toEqual(['win-custom']);
    expect(agentSessionMocks.setMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'win-custom' }),
    ]);
  });
});

describe('admin-api MCP remove/disable legacy HTTP servers', () => {
  const remoteHttp = {
    id: 'yuandian-law',
    name: 'YuanDian Law',
    type: 'http',
    url: 'https://mcp.example.com/yuandian-law',
    headers: { Authorization: 'Bearer token' },
    isBuiltin: false,
  };

  it('removes HTTP MCP definitions from global config and Agent legacy payloads', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'] },
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(config.mcpServerEnv).toEqual({});
    expect(config.mcpServerArgs).toEqual({});
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('removes Agent-only legacy HTTP MCP servers after Admin API load-boundary promotion', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('cascades custom MCP remove across config, projects, sessions, legacy Bot payloads, and Rust stores', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law', 'keep'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'] },
      launcherLastUsed: { mcpEnabledServers: ['yuandian-law', 'keep'] },
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
      imBotConfigs: [{
        id: 'bot-1',
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [{
      id: 'session-1',
      agentDir: '/tmp/workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mcpEnabledServers: ['yuandian-law'],
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, taskUpdated: 1, cronUpdated: 2 });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];
    const session = readJson(join(scratch, '.myagents', 'sessions.json'))[0];
    const agent = (config.agents as Array<Record<string, unknown>>)[0];
    const bot = (config.imBotConfigs as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ taskUpdated: 1, cronUpdated: 2, projectUpdated: 1, sessionUpdated: 1 });
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual(['keep']);
    expect(config.mcpServerEnv).toEqual({});
    expect(config.mcpServerArgs).toEqual({});
    expect((config.launcherLastUsed as Record<string, unknown>).mcpEnabledServers).toEqual(['keep']);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
    expect(bot.mcpEnabledServers).toEqual([]);
    expect(bot.mcpServersJson).toBeUndefined();
    expect(project.mcpEnabledServers).toEqual([]);
    expect(session.mcpEnabledServers).toEqual([]);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith('/api/mcp/remove-references', 'POST', { serverId: 'yuandian-law' });
  });

  it('keeps AppConfig definition when Rust Task/Cron cleanup fails', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({
      ok: false,
      error: 'Task store unavailable',
      recoveryHint: { recoveryCommand: 'myagents status', message: 'retry later' },
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect(result.recoveryHint).toEqual({ recoveryCommand: 'myagents status', message: 'retry later' });
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
  });

  it('keeps AppConfig definition when session snapshot cleanup cannot be written', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), [{
      id: 'session-1',
      agentDir: '/tmp/workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mcpEnabledServers: ['yuandian-law'],
    }]);
    mkdirSync(join(scratch, '.myagents', 'sessions.json.tmp'));

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(managementApiMocks.managementApi).not.toHaveBeenCalled();
  });

  it('does not delete a new same-id definition added during cleanup-only remove', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: ['yuandian-law'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Project',
      path: '/tmp/workspace',
      mcpEnabledServers: ['yuandian-law'],
    }]);
    writeJson(join(scratch, '.myagents', 'sessions.json'), []);
    managementApiMocks.managementApi.mockImplementationOnce(async () => {
      writeJson(join(scratch, '.myagents', 'config.json'), {
        mcpServers: [remoteHttp],
        mcpEnabledServers: ['yuandian-law'],
      });
      return { ok: true, taskUpdated: 0, cronUpdated: 0 };
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const project = readJson(join(scratch, '.myagents', 'projects.json'))[0];

    expect(result.success).toBe(false);
    expect(result.error).toContain('re-added during cleanup-only remove');
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual(['yuandian-law']);
    expect(project.mcpEnabledServers).toEqual(['yuandian-law']);
  });

  it('disables Agent-only legacy HTTP MCP servers without letting promotion re-enable them', async () => {
    const { handleMcpDisable } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpDisable({ id: 'yuandian-law', scope: 'both' });
    const config = readConfig();

    expect(result.success).toBe(true);
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual([]);
  });
});

describe('admin-api Agent runtime lifecycle convergence', () => {
  it('removes the durable channel before stopping that exact Rust runtime', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-remove',
        name: 'Channel Remove',
        enabled: true,
        channels: [
          { id: 'channel-remove', type: 'openclaw:weixin', enabled: true },
          { id: 'channel-keep', type: 'telegram', enabled: true },
        ],
      }],
    });
    let persistedChannelsAtStop: unknown;
    managementApiMocks.managementApi.mockImplementation(async () => {
      const agent = (readConfig().agents as Record<string, unknown>[])[0];
      persistedChannelsAtStop = agent.channels;
      return { ok: true, stopped: true };
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-remove',
      channelId: 'channel-remove',
    });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channel',
      'POST',
      { agentId: 'agent-channel-remove', channelId: 'channel-remove' },
      expect.any(Object),
    );
    expect(persistedChannelsAtStop).toEqual([
      { id: 'channel-keep', type: 'telegram', enabled: true },
    ]);
  });

  it('retries exact runtime cleanup after the durable channel is already absent', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-retry',
        name: 'Channel Retry',
        enabled: true,
        channels: [],
      }],
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-retry',
      channelId: 'historically-deleted-channel',
    });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channel',
      'POST',
      {
        agentId: 'agent-channel-retry',
        channelId: 'historically-deleted-channel',
      },
      expect.any(Object),
    );
  });

  it('reports a truthful partial failure when config deletion lands but runtime stop fails', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-channel-stop-fails',
        name: 'Channel Stop Fails',
        enabled: true,
        channels: [{ id: 'channel-stop-fails', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    managementApiMocks.managementApi.mockResolvedValue({
      ok: false,
      error: 'injected Rust lifecycle failure',
    });
    const { handleAgentChannelRemove } = await import('./admin-api');

    const result = await handleAgentChannelRemove({
      agentId: 'agent-channel-stop-fails',
      channelId: 'channel-stop-fails',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('was removed');
    expect(result.error).toContain('injected Rust lifecycle failure');
    const agent = (readConfig().agents as Record<string, unknown>[])[0];
    expect(agent.channels).toEqual([]);
  });

  it.each([
    ['agent disable', async (api: typeof import('./admin-api')) => api.handleAgentDisable({ id: 'agent-disable' })],
    ['agent set enabled=false', async (api: typeof import('./admin-api')) => api.handleAgentSet({
      id: 'agent-disable',
      key: 'enabled',
      value: false,
    })],
  ])('%s persists disabled before stopping all Rust channel runtimes', async (_label, run) => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-disable',
        name: 'Disable',
        enabled: true,
        channels: [{ id: 'channel-1', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    let persistedEnabledAtStop: unknown;
    managementApiMocks.managementApi.mockImplementation(async () => {
      const agent = (readConfig().agents as Record<string, unknown>[])[0];
      persistedEnabledAtStop = agent.enabled;
      return { ok: true, stoppedChannels: 1 };
    });
    const api = await import('./admin-api');

    const result = await run(api);

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      'POST',
      { agentId: 'agent-disable' },
      expect.any(Object),
    );
    expect(persistedEnabledAtStop).toBe(false);
  });

  it('still converges runtime state when archiving an already-disabled Agent', async () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-archive-disabled',
        name: 'Archive Disabled',
        enabled: false,
        workspacePath: '/tmp/archive-disabled',
        channels: [{ id: 'channel-1', type: 'openclaw:weixin', enabled: true }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-archive-disabled',
      name: 'Archive Disabled',
      path: '/tmp/archive-disabled',
      agentId: 'agent-archive-disabled',
    }]);
    managementApiMocks.managementApi.mockResolvedValue({ ok: true, stoppedChannels: 1 });
    const { handleAgentArchive } = await import('./admin-api');

    const result = await handleAgentArchive({ id: 'agent-archive-disabled' });

    expect(result.success).toBe(true);
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      'POST',
      { agentId: 'agent-archive-disabled' },
      expect.any(Object),
    );
  });
});

describe('admin-api Agent workspace archive', () => {
  it('archives a linked agent workspace and pauses proactive agent state', async () => {
    const { handleAgentArchive, handleAgentList } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: true,
        workspacePath: '/tmp/workspace',
        channels: [{ id: 'channel-1', type: 'telegram', enabled: true }],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      pinnedAt: '2026-07-01T00:00:00.000Z',
    }]);
    managementApiMocks.managementApi.mockResolvedValueOnce({ ok: true, stoppedChannels: 1 });

    const result = await handleAgentArchive({ id: 'agent-1' });

    expect(result.success).toBe(true);
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(false);
    const projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0].archivedAt).toEqual(expect.any(String));
    expect(projects[0].archivedAgentEnabledBeforeArchive).toBe(true);
    expect(projects[0]).not.toHaveProperty('pinnedAt');
    expect(managementApiMocks.managementApi).toHaveBeenCalledWith(
      '/api/agent/stop-channels',
      'POST',
      { agentId: 'agent-1' },
      expect.any(Object),
    );

    const archivedList = handleAgentList({ lifecycle: 'archived' });
    expect((archivedList.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'agent-1',
      archived: true,
      projectId: 'project-1',
    });
  });

  it('keeps restore intent when archive is called repeatedly', async () => {
    const { handleAgentArchive, handleAgentUnarchive } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: true,
        workspacePath: '/tmp/workspace',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
    }]);

    expect((await handleAgentArchive({ id: 'agent-1' })).success).toBe(true);
    expect((await handleAgentArchive({ id: 'agent-1' })).success).toBe(true);
    let projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0].archivedAgentEnabledBeforeArchive).toBe(true);

    expect((await handleAgentUnarchive({ id: 'agent-1' })).success).toBe(true);
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(true);
    projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0]).not.toHaveProperty('archivedAt');
  });

  it('rejects plain enable for archived agent workspaces', async () => {
    const { handleAgentEnable } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: false,
        workspacePath: '/tmp/workspace',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    }]);

    const result = await handleAgentEnable({ id: 'agent-1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('archived workspace');
    expect(result.recoveryHint).toMatchObject({
      recoveryCommand: 'myagents agent unarchive agent-1',
    });
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(false);
  });

  it('unarchives a workspace and restores proactive state only when recorded', async () => {
    const { handleAgentUnarchive } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Workspace',
        enabled: false,
        workspacePath: '/tmp/workspace',
        channels: [],
      }],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Workspace',
      path: '/tmp/workspace',
      agentId: 'agent-1',
      archivedAt: '2026-07-03T00:00:00.000Z',
      archivedAgentEnabledBeforeArchive: true,
    }]);

    const result = await handleAgentUnarchive({ id: 'agent-1' });

    expect(result.success).toBe(true);
    const config = readConfig();
    expect((config.agents as Array<Record<string, unknown>>)[0].enabled).toBe(true);
    const projects = readJson(join(scratch, '.myagents', 'projects.json'));
    expect(projects[0]).not.toHaveProperty('archivedAt');
    expect(projects[0]).not.toHaveProperty('archivedAgentEnabledBeforeArchive');
  });
});
