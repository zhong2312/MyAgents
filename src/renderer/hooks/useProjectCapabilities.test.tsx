import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useProjectCapabilities } from './useProjectCapabilities';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useProjectCapabilities', () => {
  it('does not let an older invalidation response overwrite a newer snapshot', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const apiGet = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useProjectCapabilities(apiGet));

    let olderLoad!: Promise<void>;
    let newerLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.loadSkillsAndCommands();
      newerLoad = result.current.loadSkillsAndCommands();
    });

    newer.resolve({
      success: true,
      skills: [],
      commands: [{
        name: '新 展示名',
        invocationName: '新-指令',
        description: '',
        scope: 'user',
        fileName: '新-指令',
        enabled: true,
      }],
    });
    await act(async () => newerLoad);
    expect(result.current.enabledCommands).toEqual([
      expect.objectContaining({ name: '新 展示名', invocationName: '新-指令' }),
    ]);

    older.resolve({
      success: true,
      skills: [],
      commands: [{
        name: '旧 展示名',
        invocationName: '旧-指令',
        description: '',
        scope: 'user',
        fileName: '旧-指令',
        enabled: true,
      }],
    });
    await act(async () => olderLoad);

    expect(result.current.enabledCommands).toEqual([
      expect.objectContaining({ name: '新 展示名', invocationName: '新-指令' }),
    ]);
  });
});
