import { afterEach, describe, expect, it, vi } from 'vitest';

import { requireCurrentBuiltinSkill } from '../agent-session';
import { setQuerySession, setSdkControlReady } from '../builtin-session/lifecycle';

afterEach(() => {
  setQuerySession(null);
  setSdkControlReady(false);
});

describe('required builtin Skill readiness', () => {
  it('waits for cold Query initialization before checking the native Skill registry', async () => {
    let finishInitialization!: () => void;
    const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
    const query = {
      initializationResult: vi.fn(() => initialization),
      reloadSkills: vi.fn(async () => ({ skills: [{ name: 'task-alignment' }] })),
    };
    setQuerySession(query as never);

    const readiness = requireCurrentBuiltinSkill('task-alignment');
    await Promise.resolve();
    expect(query.reloadSkills).not.toHaveBeenCalled();

    finishInitialization();
    await expect(readiness).resolves.toBeUndefined();
    expect(query.reloadSkills).toHaveBeenCalledOnce();
  });

  it('rejects only the dependent operation when the native registry omits the Skill', async () => {
    const query = {
      initializationResult: vi.fn(async () => ({})),
      reloadSkills: vi.fn(async () => ({ skills: [] })),
    };
    setQuerySession(query as never);
    setSdkControlReady(true);

    await expect(requireCurrentBuiltinSkill('task-alignment')).rejects.toThrow(
      'builtin Runtime did not load required system skill task-alignment',
    );
  });
});
