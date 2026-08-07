/**
 * Transcript cursor projection invariant.
 *
 * The runtime maps only rows after SessionStore's issued durable count. A live
 * projection shorter than that count cannot reset the count or rewrite disk;
 * it must rehydrate from the durable source. Destructive changes advance only
 * through an explicit store mutation result.
 */

import { describe, expect, it, vi } from 'vitest';

interface Msg { id: string; content: string }

function createPersister(initialCount = 0) {
  let persistedMessageCount = initialCount;
  const mapMsg = vi.fn((message: Msg) => ({ ...message, mapped: true }));
  const appendTail = vi.fn((tail: unknown[]) => tail.length);

  function persist(messages: Msg[]) {
    if (messages.length < persistedMessageCount) {
      throw new Error('rehydrate-required');
    }
    const tail = messages.slice(persistedMessageCount).map(mapMsg);
    appendTail(tail);
    persistedMessageCount += tail.length;
  }

  function commitDestructiveMutation(targetCount: number) {
    if (targetCount >= persistedMessageCount) throw new Error('not-destructive');
    persistedMessageCount = targetCount;
  }

  return {
    persist,
    commitDestructiveMutation,
    mapMsg,
    appendTail,
    get persistedMessageCount() { return persistedMessageCount; },
  };
}

describe('transcript cursor projection invariant', () => {
  it('maps one new row per turn regardless of history size', () => {
    const persister = createPersister();
    const messages: Msg[] = [];
    for (let turn = 0; turn < 20; turn += 1) {
      messages.push({ id: String(turn), content: `m${turn}` });
      persister.persist(messages);
      expect(persister.mapMsg).toHaveBeenCalledTimes(turn + 1);
    }
    expect(persister.persistedMessageCount).toBe(20);
  });

  it('passes only a multi-row tail to append', () => {
    const persister = createPersister(1);
    const messages = [
      { id: '0', content: 'durable' },
      { id: '1', content: 'user' },
      { id: '2', content: 'assistant' },
    ];
    persister.persist(messages);
    expect(persister.appendTail).toHaveBeenCalledWith([
      expect.objectContaining({ id: '1' }),
      expect.objectContaining({ id: '2' }),
    ]);
  });

  it('requires rehydration when the live projection is shorter than the cursor', () => {
    const persister = createPersister(22);
    expect(() => persister.persist([{ id: 'partial', content: 'partial' }]))
      .toThrow('rehydrate-required');
    expect(persister.appendTail).not.toHaveBeenCalled();
    expect(persister.persistedMessageCount).toBe(22);
  });

  it('changes durable count only after an explicit destructive commit', () => {
    const persister = createPersister(5);
    persister.commitDestructiveMutation(2);
    expect(persister.persistedMessageCount).toBe(2);
  });
});

describe('per-Session persist serialization', () => {
  it('serializes overlapping appends for the same Session', async () => {
    const chains = new Map<string, Promise<void>>();
    const trace: string[] = [];
    const schedule = (sessionId: string, label: string, holdMs: number) => {
      const previous = chains.get(sessionId) ?? Promise.resolve();
      const next = previous.then(async () => {
        trace.push(`${label}-enter`);
        await new Promise(resolve => setTimeout(resolve, holdMs));
        trace.push(`${label}-exit`);
      });
      chains.set(sessionId, next);
      return next;
    };

    await Promise.all([schedule('session', 'A', 20), schedule('session', 'B', 1)]);
    expect(trace).toEqual(['A-enter', 'A-exit', 'B-enter', 'B-exit']);
  });
});
