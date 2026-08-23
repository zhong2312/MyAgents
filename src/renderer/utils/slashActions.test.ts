import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '../../shared/slashCommands';
import {
  CLIENT_ACTION_SLASH_COMMANDS,
  MANAGED_CODEX_COMPACT_SLASH_COMMAND,
  isClientActionCommand,
  resolveClientActionName,
  withClientActionCommands,
} from './slashActions';
import { i18n } from '@/i18n';

const cmd = (name: string, source: SlashCommand['source']): SlashCommand => ({
  name,
  description: name,
  source,
});

describe('isClientActionCommand', () => {
  it('is true only for renderer client-action commands', () => {
    expect(isClientActionCommand(cmd('goal', 'client'))).toBe(true);
    expect(isClientActionCommand(cmd('compact', 'client'))).toBe(true);
  });

  it('is false for a non-builtin source with the same name (no hijack of a user skill)', () => {
    expect(isClientActionCommand(cmd('goal', 'skill'))).toBe(false);
    expect(isClientActionCommand(cmd('loop', 'skill'))).toBe(false);
    expect(isClientActionCommand(cmd('loop', 'custom'))).toBe(false);
    expect(isClientActionCommand(cmd('loop', 'sdk'))).toBe(false);
    expect(isClientActionCommand(cmd('goal', 'builtin'))).toBe(false);
  });

  it('is false for ordinary builtins like /compact', () => {
    expect(isClientActionCommand(cmd('compact', 'builtin'))).toBe(false);
  });
});

describe('resolveClientActionName', () => {
  it('resolves /loop as a compatibility alias for /goal', () => {
    expect(resolveClientActionName('/goal')).toBe('goal');
    expect(resolveClientActionName('/loop')).toBe('goal');
  });

  it('returns null for ordinary commands', () => {
    expect(resolveClientActionName('/compact')).toBeNull();
  });

  it('resolves runtime-specific actions only when that capability is enabled', () => {
    const enabled = [...CLIENT_ACTION_SLASH_COMMANDS, MANAGED_CODEX_COMPACT_SLASH_COMMAND];
    expect(resolveClientActionName('/compact', enabled)).toBe('compact');
  });
});

describe('withClientActionCommands', () => {
  const base = [cmd('alpha', 'skill'), cmd('compact', 'builtin')];

  it('returns the list untouched when disabled (no handler wired)', () => {
    const result = withClientActionCommands(base, false);
    expect(result).toBe(base); // same reference — no allocation
    expect(result.some((c) => c.name === 'goal')).toBe(false);
    expect(result.some((c) => c.name === 'loop')).toBe(false);
  });

  it('appends client-action commands when enabled', () => {
    const result = withClientActionCommands(base, true);
    expect(result.filter((c) => c.name === 'goal')).toHaveLength(1);
    expect(result.filter((c) => c.name === 'loop')).toHaveLength(0);
    expect(result.find((c) => c.name === 'goal')?.source).toBe('client');
    expect(result.find((c) => c.name === 'goal')?.aliases).toContain('loop');
  });

  it('uses the localized /goal description', async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage('zh-CN');

    try {
      const result = withClientActionCommands(base, true);
      expect(result.find((c) => c.name === 'goal')?.description)
        .toBe('目标模式：持续执行直到目标全部达成');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('reserves client-action names: the product command preempts a same-named user skill', () => {
    const withUserCommands = [...base, cmd('goal', 'skill'), cmd('loop', 'skill')];
    const result = withClientActionCommands(withUserCommands, true);
    // /goal is visible; /loop is reserved as a hidden alias, so a user skill
    // cannot shadow the old command name.
    expect(result.filter((c) => c.name === 'goal')).toHaveLength(1);
    expect(result.filter((c) => c.name === 'loop')).toHaveLength(0);
    expect(result.find((c) => c.name === 'goal')?.source).toBe('client');
    expect(isClientActionCommand(result.find((c) => c.name === 'goal')!)).toBe(true);
  });

  it('every client-action command is itself a client action', () => {
    for (const c of CLIENT_ACTION_SLASH_COMMANDS) {
      expect(isClientActionCommand(c)).toBe(true);
    }
  });

  it('injects Managed Codex compact as a client action without duplicating the builtin name', () => {
    const result = withClientActionCommands(base, true, [MANAGED_CODEX_COMPACT_SLASH_COMMAND]);
    expect(result.filter((c) => c.name === 'compact')).toHaveLength(1);
    expect(result.find((c) => c.name === 'compact')?.source).toBe('client');
    expect(isClientActionCommand(result.find((c) => c.name === 'compact')!)).toBe(true);
  });
});
