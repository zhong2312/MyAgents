import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '../../shared/slashCommands';
import {
  filterAndSortCommands,
  mergeLocalSlashCommands,
  mergeSdkSlashCommands,
} from './SlashCommandMenu';

const cmd = (name: string, source: SlashCommand['source']): SlashCommand => ({
  name,
  description: `${name} description`,
  source,
});

describe('filterAndSortCommands', () => {
  it('ranks /goal first, then other builtins, then user skills/commands', () => {
    const input = [
      cmd('apple-notes', 'skill'),
      cmd('compact', 'builtin'),
      cmd('bird', 'custom'),
      cmd('goal', 'client'),
    ];
    const out = filterAndSortCommands(input, '');
    expect(out.map((c) => c.name)).toEqual(['goal', 'compact', 'apple-notes', 'bird']);
  });

  it('surfaces the builtin /goal when the user types its /loop alias', () => {
    const input = [
      cmd('local-skill', 'skill'),
      { ...cmd('goal', 'builtin'), aliases: ['loop'] },
    ];
    const out = filterAndSortCommands(input, 'lo');
    expect(out[0].name).toBe('goal');
  });

  it('keeps prefix-match-first ordering within the builtin tier', () => {
    // 'cost' has 'co' as a prefix; 'compact' too — both prefix. 'context' also.
    // A builtin whose name only contains the query as a substring ranks after
    // prefix matches within the same tier.
    const input = [
      cmd('zzco', 'builtin'), // substring match only
      cmd('context', 'builtin'), // prefix match
    ];
    const out = filterAndSortCommands(input, 'co');
    expect(out.map((c) => c.name)).toEqual(['context', 'zzco']);
  });

  it('filters out non-matching commands', () => {
    const input = [{ ...cmd('goal', 'builtin'), aliases: ['loop'] }, cmd('apple', 'skill')];
    const out = filterAndSortCommands(input, 'loop');
    expect(out.map((c) => c.name)).toEqual(['goal']);
  });

  it('matches on description too, but builtins still rank first', () => {
    const input = [
      cmd('skill-x', 'skill'), // name no match
      { name: 'review', description: '审查 xyzmatch 代码', source: 'builtin' as const },
    ];
    // give skill-x a matching description
    input[0] = { name: 'skill-x', description: 'has xyzmatch token', source: 'skill' };
    const out = filterAndSortCommands(input, 'xyzmatch');
    expect(out.map((c) => c.name)).toEqual(['review', 'skill-x']);
  });
});

describe('slash command source merging', () => {
  it('preserves project Skill and Command provenance behind product builtins', () => {
    const product = [cmd('compact', 'builtin')];
    const local = [cmd('apple-notes', 'skill'), cmd('ship-it', 'custom')];
    const out = mergeLocalSlashCommands(product, local);

    expect(out.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'compact', source: 'builtin' },
      { name: 'apple-notes', source: 'skill' },
      { name: 'ship-it', source: 'custom' },
    ]);
  });

  it('appends SDK-only plugin commands after workspace commands', () => {
    const workspace = [cmd('compact', 'builtin')];
    const sdk = [cmd('my-plugin:deploy', 'sdk')];
    const out = mergeSdkSlashCommands(workspace, sdk);

    expect(out.map((c) => c.name)).toEqual(['compact', 'my-plugin:deploy']);
    expect(out[1].source).toBe('sdk');
  });

  it('keeps the workspace command on name collisions', () => {
    const workspace = [cmd('compact', 'builtin')];
    const sdk = [{ ...cmd('/compact', 'sdk'), description: 'SDK compact' }];
    const out = mergeSdkSlashCommands(workspace, sdk);

    expect(out).toBe(workspace);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('compact description');
  });

  it('normalizes leading slashes from SDK command names', () => {
    const out = mergeSdkSlashCommands([], [cmd('/plugin:skill', 'sdk')]);

    expect(out.map((c) => c.name)).toEqual(['plugin:skill']);
  });

  it('deduplicates by invocation identity without replacing the display label', () => {
    const local = [{
      ...cmd('中文 总结', 'custom'),
      invocationName: '中文-总结',
    }];
    const sdk = [cmd('中文-总结', 'sdk')];
    const out = mergeSdkSlashCommands(local, sdk);

    expect(out).toBe(local);
    expect(out).toEqual([expect.objectContaining({
      name: '中文 总结',
      invocationName: '中文-总结',
    })]);
  });
});
