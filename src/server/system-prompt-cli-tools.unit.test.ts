import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<myagents-user-tools>registered</myagents-user-tools>',
}));

const { buildCliToolsAppend } = await import('./system-prompt-cli-tools');
const { IMAGE_UNDERSTANDING_TOOL_ID } = await import('../shared/official-tools');

describe('buildCliToolsAppend', () => {
  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<myagents-cli-cron>');
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
