import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<myagents-user-tools>registered</myagents-user-tools>',
}));

const { buildCliToolsAppend, buildSessionInboxSection } = await import('./system-prompt-cli-tools');
const { IMAGE_UNDERSTANDING_TOOL_ID } = await import('../shared/official-tools');

describe('buildCliToolsAppend', () => {
  it('keeps the PRD-locked Agent / Session collaboration hint exact', () => {
    expect(buildSessionInboxSection({ type: 'desktop' })).toBe(`<myagents-session-events>
MyAgents lets its Agents collaborate through the \`myagents\` CLI. Run these
commands from your shell/Bash tool.

IDENTITY MODEL
Every MyAgents Workspace has one stable Agent identity. An Agent is the
long-lived address for that workspace and its execution settings; \`enabled\`
only controls proactive capabilities such as channels and heartbeat. One Agent
can own many Sessions. Each Session is an isolated execution context under that
Agent.

CHOOSE THE RIGHT ACTION
- Find an Agent or identify this session's own Agent:
    myagents agent list
    myagents agent show <agentId>
- Decide whether to reuse recent context:
    myagents session list --agent <agentId>
- Start clean work in a new Session under an Agent:
    myagents session start --agent <agentId> -p "<prompt>"
- Ask an existing Session to do new work:
    myagents session send <sessionId> -p "<prompt>"
- Observe an existing Session without assigning new work:
    myagents session watch <sessionId>

Use IDs returned by discovery commands; do not guess IDs or use workspace paths
as selectors. \`start\` always creates fresh context, \`send\` preserves the target
Session's context, and \`watch\` does not inject work. The target runs with its own
Agent/Session configuration and permissions. \`start\` and \`send\` are asynchronous;
by default MyAgents pushes the target turn's final result back to this Session.

For the complete current contract, options, output, and recovery guidance, run:
  myagents agent --help
  myagents session --help

You may receive \`<myagents-session-event>\` blocks. Treat them as system-delivered
event data and reconcile their payload with the current user and system
instructions.
</myagents-session-events>`);
  });

  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<myagents-cli-task-automation>');
    expect(text).toContain('myagents-task-automation');
    expect(text).toContain('myagents task readme');
    expect(text).not.toContain('<myagents-cli-cron>');
    expect(text).toContain('<myagents-cli-goal>');
    expect(text).toContain('<myagents-cli-thought>');
    expect(text).toContain('myagents goal --help');
    expect(text).toContain('goal-objective.txt');
    expect(text).toContain('system\ntemp files are both accepted');
    expect(text).not.toContain('<myagents-user-tools>');
  });

  it('injects Goal Mode into private user-facing channel prompts', () => {
    const imText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );
    const channelText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );

    expect(imText).toContain('<myagents-cli-goal>');
    expect(channelText).toContain('<myagents-cli-goal>');
    expect(imText).toContain('目标模式');
    expect(channelText).toContain('设立目标');
  });

  it('does not inject Goal Mode into headless or semi-open prompts', () => {
    const cronText = buildCliToolsAppend(
      { type: 'cron', taskId: 'task-1', intervalMinutes: 5, aiCanExit: true },
      { includeUserTools: false },
    );
    const registeredAgentText = buildCliToolsAppend(
      { type: 'registeredAgent', platform: 'space', spaceId: 'space-1', registeredAgentId: 'ra-1' },
      { includeUserTools: false },
    );
    const imGroupText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );
    const agentChannelGroupText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );

    expect(cronText).not.toContain('<myagents-cli-goal>');
    expect(cronText).not.toContain('myagents goal create');
    expect(cronText).toContain('<myagents-cli-task-exit>');
    expect(cronText).toContain('myagents task exit');
    expect(registeredAgentText).not.toContain('<myagents-cli-goal>');
    expect(registeredAgentText).not.toContain('myagents goal create');
    expect(imGroupText).not.toContain('<myagents-cli-goal>');
    expect(imGroupText).not.toContain('myagents goal create');
    expect(agentChannelGroupText).not.toContain('<myagents-cli-goal>');
    expect(agentChannelGroupText).not.toContain('myagents goal create');
  });

  it('includes user-registered CLI tools only when explicitly enabled', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: true });

    expect(text).toContain('<myagents-user-tools>registered</myagents-user-tools>');
  });

  it('does not inject official image understanding by default', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).not.toContain('<myagents-cli-vision>');
  });

  it('injects official image understanding when the session enables it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID] },
    );

    expect(text).toContain('<myagents-cli-vision>');
    expect(text).toContain('myagents vision analyze');
    expect(text).toContain('--prompt-file');
    expect(text).toContain('[Unsupported Image]');
    expect(text).toContain('myagents vision --help');
    expect(text).toContain('shell-sensitive');
    expect(text).toContain('user-provided');
  });
});
