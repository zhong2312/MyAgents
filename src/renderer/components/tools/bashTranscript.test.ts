import { describe, expect, it } from 'vitest';

import type { ToolUseSimple } from '@/types/chat';

import {
  detectBashStreamFormat,
  formatBashDuration,
  formatShellCommandForDisplay,
  resolveBashTranscriptModel,
} from './bashTranscript';

function tool(overrides: Partial<ToolUseSimple> = {}): ToolUseSimple {
  return {
    id: 'bash-call',
    name: 'Bash',
    input: {},
    streamIndex: 0,
    ...overrides,
  };
}

describe('formatShellCommandForDisplay', () => {
  it('breaks only after safe top-level operators', () => {
    expect(formatShellCommandForDisplay('echo "a && b" && pwd | sed -n \'1;2p\' || true')).toEqual([
      'echo "a && b" &&',
      'pwd |',
      "sed -n '1;2p' ||",
      'true',
    ]);
  });

  it('does not split escaped operators, substitutions, heredocs, or unbalanced input', () => {
    expect(formatShellCommandForDisplay('printf foo\\|bar && echo $(pwd | sed s/x/y/)')).toEqual([
      'printf foo\\|bar &&',
      'echo $(pwd | sed s/x/y/)',
    ]);
    const heredoc = "cat <<'EOF'\na && b\nEOF\necho done";
    expect(formatShellCommandForDisplay(heredoc)).toEqual([heredoc]);
    const compactHeredoc = 'cat<<EOF\na | b\nEOF\necho done';
    expect(formatShellCommandForDisplay(compactHeredoc)).toEqual([compactHeredoc]);
    expect(formatShellCommandForDisplay('echo "unfinished && pwd')).toEqual(['echo "unfinished && pwd']);
  });

  it('fails closed for nested substitution quote grammars inside double quotes', () => {
    const commandSubstitution = 'echo "$(printf "%s && x" foo)" && pwd';
    const parameterSubstitution = 'echo "${value:-"a && b"}" && pwd';

    expect(formatShellCommandForDisplay(commandSubstitution)).toEqual([commandSubstitution]);
    expect(formatShellCommandForDisplay(parameterSubstitution)).toEqual([parameterSubstitution]);
  });

  it('fails closed for comments inside nested shell grammar', () => {
    const nestedComment = 'echo $(printf x # ) && hidden (\n) && pwd';

    expect(formatShellCommandForDisplay(nestedComment)).toEqual([nestedComment]);
  });

  it('preserves comments and compound Bash operators without visually rewriting them', () => {
    expect(formatShellCommandForDisplay('printf ok |& tee out')).toEqual([
      'printf ok |&',
      'tee out',
    ]);
    expect(formatShellCommandForDisplay('echo ok # comment && rm -rf /')).toEqual([
      'echo ok # comment && rm -rf /',
    ]);
    expect(formatShellCommandForDisplay('case x in x) echo ok ;;& esac')).toEqual([
      'case x in x) echo ok ;;& esac',
    ]);
    expect(formatShellCommandForDisplay('echo hi >| out')).toEqual(['echo hi >| out']);
  });
});

describe('Bash transcript model', () => {
  it('prefers ordered Codex commandActions while retaining the raw wrapper', () => {
    const model = resolveBashTranscriptModel(tool({
      input: {
        command: '/bin/zsh -lc "rg -n foo src && sed -n 1,20p file"',
        cwd: '/project',
        commandActions: [
          { type: 'search', command: 'rg -n foo src', query: 'foo', path: 'src' },
          { type: 'read', command: 'sed -n 1,20p file', path: 'file' },
          { type: 'unknown' },
        ],
      },
      result: 'done',
      resultMeta: { status: 'completed', cwd: '/project', exitCode: 0 },
    }));

    expect(model.shell).toBe('/bin/zsh');
    expect(model.command).toEqual({
      raw: '/bin/zsh -lc "rg -n foo src && sed -n 1,20p file"',
      displayLines: ['rg -n foo src', 'sed -n 1,20p file'],
      source: 'command-actions',
    });
    expect(model.hasHiddenCommandContent).toBe(false);
    expect(model.status).toBe('completed');
    expect(model.meta).toMatchObject({ cwd: '/project', exitCode: 0 });
  });

  it('uses complete inputJson as restored-history authority over stale parsed input', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'stale input' },
      inputJson: JSON.stringify({
        command: '/bin/bash -lc "pwd"',
        cwd: '/from-json',
        commandActions: [{ command: 'pwd' }],
      }),
      parsedInput: { command: 'stale parsed input' } as ToolUseSimple['parsedInput'],
      result: '',
      resultMeta: { status: 'completed' },
    }));

    expect(model.command?.displayLines).toEqual(['pwd']);
    expect(model.meta.cwd).toBe('/from-json');
    expect(model.command?.raw).toBe('/bin/bash -lc "pwd"');
  });

  it('does not render partial JSON protocol fragments as a raw command', () => {
    const loading = resolveBashTranscriptModel(tool({
      inputJson: '{"command":"unfinished',
      isLoading: true,
    }));
    const restored = resolveBashTranscriptModel(tool({
      inputJson: '{"command":"unfinished',
    }));

    expect(loading.command).toBeNull();
    expect(loading.status).toBe('initializing');
    expect(restored.command).toBeNull();
    expect(restored.status).toBe('initializing');
  });

  it('recognizes partial Bash input JSON when a non-command SDK field arrives first', () => {
    const model = resolveBashTranscriptModel(tool({
      inputJson: '{"description":"list files","command":"pwd',
      isLoading: true,
    }));

    expect(model.command).toBeNull();
    expect(model.status).toBe('initializing');
  });

  it('does not parse or expose oversized JSON input before its display budget', () => {
    const inputJson = JSON.stringify({ command: `echo ${'x'.repeat(600_000)}` });
    const withoutStructuredFallback = resolveBashTranscriptModel(tool({ inputJson, isLoading: true }));
    const withStructuredFallback = resolveBashTranscriptModel(tool({
      inputJson,
      parsedInput: { command: 'echo bounded' },
      isLoading: true,
    }));

    expect(withoutStructuredFallback.command).toBeNull();
    expect(withoutStructuredFallback.status).toBe('initializing');
    expect(withStructuredFallback.command?.raw).toBe('echo bounded');
  });

  it('bounds shell-wrapper detection while retaining a large raw command', () => {
    const raw = `plain-command-${'x'.repeat(600_000)}`;
    const wrapped = `/bin/zsh -lc "${'x'.repeat(600_000)}"`;

    expect(resolveBashTranscriptModel(tool({ input: { command: raw } })).shell).toBeUndefined();
    expect(resolveBashTranscriptModel(tool({ input: { command: raw } })).command?.raw).toBe(raw);
    expect(resolveBashTranscriptModel(tool({ input: { command: wrapped } })).shell).toBe('/bin/zsh');
  });

  it('does not treat the bounded shell prefix as a synthetic end of input', () => {
    const wrapper = '/bin/zsh -lc';
    const padding = ' '.repeat((4 * 1024) - wrapper.length);
    const invalid = `${padding}${wrapper}x echo hi`;
    const valid = `${padding}${wrapper} echo hi`;

    expect(resolveBashTranscriptModel(tool({ input: { command: invalid } })).shell).toBeUndefined();
    expect(resolveBashTranscriptModel(tool({ input: { command: valid } })).shell).toBe('/bin/zsh');
  });

  it('selects structured Bash fields without enumerating unrelated object keys', () => {
    const parsedInput = new Proxy({ command: 'pwd' }, {
      ownKeys() {
        throw new Error('structured input must not be fully enumerated');
      },
    });

    expect(resolveBashTranscriptModel(tool({ parsedInput })).command?.raw).toBe('pwd');
  });

  it('projects commandActions under the shared hard cap and reports hidden content', () => {
    const commandActions = Array.from({ length: 6_000 }, (_, index) => ({
      command: `printf action-${index}`,
    }));
    const model = resolveBashTranscriptModel(tool({
      input: { command: '/bin/zsh -lc "batch"', commandActions },
    }));

    expect(model.command?.source).toBe('command-actions');
    expect(model.command?.displayLines).toHaveLength(5_000);
    expect(model.hasHiddenCommandContent).toBe(true);
    expect(model.command?.raw.length).toBeLessThanOrEqual(512 * 1024);
  });

  it('bounds safe-format segments without mutating the raw command', () => {
    const command = 'x;'.repeat(200_000);
    const model = resolveBashTranscriptModel(tool({ input: { command } }));

    expect(model.command?.raw).toBe(command);
    expect(model.command?.displayLines).toHaveLength(5_000);
    expect(model.hasHiddenCommandContent).toBe(true);
  });

  it('retains hidden command authority when no action was materialized', () => {
    const commandActions = [
      ...Array.from({ length: 5_000 }, () => ({ type: 'unknown' })),
      { command: 'echo late' },
    ];
    const model = resolveBashTranscriptModel(tool({ input: { commandActions }, isLoading: true }));

    expect(model.command).toBeNull();
    expect(model.hasHiddenCommandContent).toBe(true);
    expect(model.status).toBe('running');
  });

  it('does not materialize proven whitespace-only commandActions', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { commandActions: [{ command: ' '.repeat(200) }] },
      isLoading: true,
    }));

    expect(model.command).toBeNull();
    expect(model.hasHiddenCommandContent).toBe(false);
    expect(model.status).toBe('initializing');
  });

  it('does not render a whitespace-only streaming command as an empty prompt', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: '   \t' },
      isLoading: true,
    }));

    expect(model.command).toBeNull();
    expect(model.status).toBe('initializing');
  });

  it('preserves unambiguous restored bare shell commands', () => {
    expect(resolveBashTranscriptModel(tool({ inputJson: '[ -f package.json ] && npm test' })).command?.raw)
      .toBe('[ -f package.json ] && npm test');
  });

  it('fails closed for ambiguous object-like legacy raw input but keeps structured brace commands', () => {
    const command = '{ echo ready; }';
    const largeCommand = `{${' '.repeat(4_095)}echo ready; }`;

    expect(resolveBashTranscriptModel(tool({ inputJson: command })).command).toBeNull();
    expect(resolveBashTranscriptModel(tool({ inputJson: largeCommand })).command).toBeNull();
    expect(resolveBashTranscriptModel(tool({ input: { command } })).command?.raw).toBe(command);
  });

  it('retains potential raw content beyond an all-whitespace prefix', () => {
    const command = `${' '.repeat(4 * 1024)}echo ready`;

    expect(resolveBashTranscriptModel(tool({ inputJson: command })).command?.raw).toBe(command);
  });

  it('keeps oversized whitespace as hidden authority without rendering an empty prompt', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: ' '.repeat(600_000) },
      isLoading: true,
    }));

    expect(model.command).toBeNull();
    expect(model.hasHiddenCommandContent).toBe(true);
    expect(model.status).toBe('running');
  });

  it('separates SDK stdout and stderr and preserves each raw stream', () => {
    const result = JSON.stringify({
      stdout: '{"ok":true}',
      stderr: 'warning: plain',
      interrupted: false,
    });
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'run' },
      result,
      resultMeta: { durationMs: 327, processId: '38910', exitCode: 0 },
    }));

    expect(model.streams).toEqual([
      {
        kind: 'stdout',
        format: 'json',
        text: '{"ok":true}',
        displayText: '{\n  "ok": true\n}',
      },
      {
        kind: 'stderr',
        format: 'plain',
        text: 'warning: plain',
        displayText: 'warning: plain',
      },
    ]);
    expect(model.meta).toMatchObject({ durationMs: 327, processId: '38910', exitCode: 0 });
  });

  it('keeps incomplete SDK lookalikes as combined plain output', () => {
    const result = '{"interrupted":false}';
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'run' },
      result,
      resultMeta: { status: 'completed' },
    }));

    expect(model.streams).toEqual([{
      kind: 'combined',
      format: 'json',
      text: result,
      displayText: '{\n  "interrupted": false\n}',
    }]);
  });

  it('does not discard unknown fields from SDK-shaped external JSON', () => {
    const result = '{"stdout":"business","stderr":"","interrupted":false,"extra":"keep me"}';
    const model = resolveBashTranscriptModel(tool({ input: { command: 'run' }, result }));

    expect(model.streams).toEqual([{
      kind: 'combined',
      format: 'json',
      text: result,
      displayText: '{\n  "stdout": "business",\n  "stderr": "",\n  "interrupted": false,\n  "extra": "keep me"\n}',
    }]);
  });

  it('derives background state from complete SDK metadata', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'serve' },
      result: JSON.stringify({
        stdout: '',
        stderr: '',
        interrupted: false,
        backgroundTaskId: 'task-1',
      }),
    }));

    expect(model.status).toBe('background');
  });

  it('keeps SDK timeout-to-background metadata structured and does not report a failure', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'serve' },
      result: JSON.stringify({
        stdout: 'listening',
        stderr: '',
        interrupted: false,
        timedOutAfterMs: 120_000,
        backgroundCwdHint: 'Session cwd remains unchanged.',
      }),
    }));

    expect(model.status).toBe('background');
    expect(model.streams[0].text).toBe('listening');
    expect(model.meta).toMatchObject({
      timedOutAfterMs: 120_000,
      backgroundCwdHint: 'Session cwd remains unchanged.',
    });
  });

  it('keeps oversized wrappers inert until the bounded transcript window projects them', () => {
    const result = JSON.stringify({
      stdout: 'x'.repeat(600_000),
      stderr: '',
      interrupted: false,
    });
    const model = resolveBashTranscriptModel(tool({ input: { command: 'run' }, result }));

    expect(model.streams).toEqual([{
      kind: 'combined',
      format: 'plain',
      text: result,
      displayText: result,
    }]);
  });

  it('uses authoritative result metadata for an oversized interrupted SDK result', () => {
    const result = JSON.stringify({
      stdout: 'x'.repeat(600_000),
      stderr: '',
      interrupted: true,
      structuredContent: [{ text: 'y'.repeat(70_000) }],
    });
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'sleep 10' },
      result,
      resultMeta: { status: 'interrupted' },
    }));

    expect(model.status).toBe('interrupted');
    expect(model.streams).toEqual([{
      kind: 'combined',
      format: 'plain',
      text: result,
      displayText: result,
    }]);
  });

  it('does not treat oversized external business fields as execution status', () => {
    const interruptedBusinessResult = JSON.stringify({
      payload: 'x'.repeat(600_000),
      interrupted: true,
    });
    const backgroundBusinessResult = JSON.stringify({
      payload: 'x'.repeat(600_000),
      backgroundTaskId: 'business-record-1',
    });

    expect(resolveBashTranscriptModel(tool({ input: { command: 'run' }, result: interruptedBusinessResult })).status)
      .toBe('completed');
    expect(resolveBashTranscriptModel(tool({ input: { command: 'run' }, result: backgroundBusinessResult })).status)
      .toBe('completed');
  });

  it('uses a distinct interrupted state from the SDK result', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'sleep 10' },
      result: JSON.stringify({ stdout: 'started', stderr: '', interrupted: true }),
    }));

    expect(model.status).toBe('interrupted');
    expect(model.streams[0].text).toBe('started');
  });

  it.each([
    [{ isLoading: true }, 'initializing'],
    [{ input: { command: 'pwd' }, isLoading: true }, 'running'],
    [{ input: { command: 'pwd' }, result: '', resultMeta: { exitCode: 0 } }, 'completed'],
    [{ input: { command: 'false' }, result: 'bad', resultMeta: { exitCode: 1 } }, 'failed'],
    [{ input: { command: 'sleep 1' }, isStopped: true }, 'stopped'],
    [{ input: { command: 'sleep 1' }, resultMeta: { status: 'timeout' } }, 'timeout'],
    [{ input: { command: 'serve', run_in_background: true } }, 'background'],
  ] as const)('derives %s as %s', (overrides, expected) => {
    expect(resolveBashTranscriptModel(tool(overrides as Partial<ToolUseSimple>)).status).toBe(expected);
  });

  it('keeps external failure output intact without inventing stderr provenance', () => {
    const model = resolveBashTranscriptModel(tool({
      inputJson: 'npm test',
      result: 'tests failed\n  expected 1',
      isError: true,
      resultMeta: { status: 'failed' },
    }));

    expect(model.command?.raw).toBe('npm test');
    expect(model.streams).toEqual([{
      kind: 'combined',
      format: 'plain',
      text: 'tests failed\n  expected 1',
      displayText: 'tests failed\n  expected 1',
    }]);
  });

  it('lets terminal failure override an input-only background hint', () => {
    const model = resolveBashTranscriptModel(tool({
      input: { command: 'serve', run_in_background: true },
      result: 'spawn failed',
      isError: true,
      resultMeta: { status: 'failed', exitCode: 1 },
    }));

    expect(model.status).toBe('failed');
  });
});

describe('Bash stream detection', () => {
  it('pretty prints only complete object or array JSON', () => {
    expect(detectBashStreamFormat('[{"id":1}]')).toEqual({
      format: 'json',
      displayText: '[\n  {\n    "id": 1\n  }\n]',
    });
    expect(detectBashStreamFormat('{"id":1}\nlog')).toEqual({
      format: 'plain',
      displayText: '{"id":1}\nlog',
    });
    expect(detectBashStreamFormat('42').format).toBe('plain');
  });

  it('keeps JSON text exact when native parsing would alter its truth', () => {
    const unsafeInteger = '{"id":9007199254740993}';
    const negativeZero = '{"value":-0}';
    const duplicateKeys = '{"id":1,"id":2}';
    expect(detectBashStreamFormat(unsafeInteger)).toEqual({ format: 'json', displayText: unsafeInteger });
    expect(detectBashStreamFormat(negativeZero)).toEqual({ format: 'json', displayText: negativeZero });
    expect(detectBashStreamFormat(duplicateKeys)).toEqual({ format: 'json', displayText: duplicateKeys });
  });

  it('requires a real hunk and changed line before claiming diff', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new';
    expect(detectBashStreamFormat(diff).format).toBe('diff');
    expect(detectBashStreamFormat('--- source inventory ---\n+ not actually a patch').format).toBe('plain');
  });

  it('keeps ANSI and HTML-like content as inert plain text', () => {
    const output = '\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007<script>alert(1)</script>';
    expect(detectBashStreamFormat(output)).toEqual({ format: 'plain', displayText: output });
  });

  it('skips format parsing above the renderer detection budget', () => {
    const largeJson = `{"payload":"${'x'.repeat(600_000)}"}`;
    expect(detectBashStreamFormat(largeJson)).toEqual({
      format: 'plain',
      displayText: largeJson,
    });
  });
});

describe('formatBashDuration', () => {
  it('formats milliseconds, seconds, and minutes', () => {
    expect(formatBashDuration(327)).toBe('327ms');
    expect(formatBashDuration(1_250)).toBe('1.3s');
    expect(formatBashDuration(65_000)).toBe('1m 5s');
    expect(formatBashDuration(0)).toBe('0ms');
  });
});
