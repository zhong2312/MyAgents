import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./UnifiedLogger', () => ({
  appendUnifiedLog: vi.fn(),
}));

const nativeConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.debug,
};

afterEach(() => {
  console.log = nativeConsole.log;
  console.error = nativeConsole.error;
  console.warn = nativeConsole.warn;
  console.debug = nativeConsole.debug;
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Node unified logger stdio ownership', () => {
  it('persists patched WARN/ERROR once without mirroring them to raw stderr', async () => {
    const rawLog = vi.fn();
    const rawWarn = vi.fn();
    const rawError = vi.fn();
    const rawDebug = vi.fn();
    console.log = rawLog;
    console.warn = rawWarn;
    console.error = rawError;
    console.debug = rawDebug;

    const logger = await import('./logger');
    const { appendUnifiedLog } = await import('./UnifiedLogger');
    logger.initLogger(() => []);

    console.warn('one warning');
    console.error('one error');
    logger.sendLog('error', 'manual error');

    expect(rawWarn).not.toHaveBeenCalled();
    expect(rawError).not.toHaveBeenCalled();
    expect(vi.mocked(appendUnifiedLog)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(appendUnifiedLog).mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ level: 'warn', message: 'one warning' }),
      expect.objectContaining({ level: 'error', message: 'one error' }),
      expect.objectContaining({ level: 'error', message: 'manual error' }),
    ]);

    logger.restoreConsole();
  });
});
