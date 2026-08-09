import { describe, expect, it } from 'vitest';

import { SubagentLivelockGuard } from './subagent-livelock-guard';

function record(
  guard: SubagentLivelockGuard,
  index: number,
  path: string,
  content = 'Wasted call - file unchanged since last read.',
  now = index * 1000,
) {
  const toolUseId = `tool-${index}`;
  guard.recordToolUse({
    parentToolUseId: 'parent-1',
    toolUseId,
    toolName: 'Read',
    toolInput: { file_path: path },
  });
  return guard.recordToolResult(toolUseId, content, now);
}

describe('SubagentLivelockGuard', () => {
  it('trips after the same wasted tool call repeats six times', () => {
    const guard = new SubagentLivelockGuard();
    for (let index = 1; index < 6; index += 1) {
      expect(record(guard, index, '/same.md')).toBeNull();
    }
    expect(record(guard, 6, '/same.md')).toMatchObject({
      parentToolUseId: 'parent-1',
      repeatedCallCount: 6,
      wastedCallCount: 6,
    });
  });

  it('trips on twelve varied wasted calls and only reports once', () => {
    const guard = new SubagentLivelockGuard();
    const paths = ['/a.md', '/b.md', '/c.md'];
    for (let index = 1; index < 12; index += 1) {
      expect(record(guard, index, paths[index % paths.length])).toBeNull();
    }
    expect(record(guard, 12, paths[12 % paths.length])).toMatchObject({
      wastedCallCount: 12,
    });
    expect(record(guard, 13, '/a.md')).toBeNull();
  });

  it('trips on the eleventh call when two wasted calls alternate', () => {
    const guard = new SubagentLivelockGuard();
    for (let index = 1; index < 11; index += 1) {
      expect(record(guard, index, index % 2 ? '/a.md' : '/b.md')).toBeNull();
    }
    expect(record(guard, 11, '/a.md')).toMatchObject({
      repeatedCallCount: 6,
      wastedCallCount: 11,
    });
  });

  it('resets wasted history when a tool call makes progress', () => {
    const guard = new SubagentLivelockGuard();
    for (let index = 1; index <= 5; index += 1) record(guard, index, '/same.md');
    expect(record(guard, 6, '/same.md', 'actual file contents')).toBeNull();
    for (let index = 7; index <= 11; index += 1) {
      expect(record(guard, index, '/same.md')).toBeNull();
    }
  });

  it('expires old wasted calls outside the detection window', () => {
    const guard = new SubagentLivelockGuard({ windowMs: 5_000 });
    for (let index = 1; index <= 5; index += 1) record(guard, index, '/same.md');
    expect(record(guard, 6, '/same.md', undefined, 20_000)).toBeNull();
  });
});
