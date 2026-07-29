/**
 * myagents — Self-Configuration CLI for MyAgents
 *
 * A thin wrapper that parses CLI arguments and forwards them as HTTP requests
 * to the Sidecar's Admin API. All business logic lives in the Sidecar.
 *
 * Environment:
 *   MYAGENTS_PORT — Sidecar port (injected by buildClaudeSessionEnv)
 *   MYAGENTS_SESSION_ID — current MyAgents session id for attached-session tasks
 *
 * No shebang here. `npm run build:cli` (esbuild) injects `#!/usr/bin/env node`
 * through `--banner:js` so the *built* `myagents.js` artifact is what carries
 * the shebang. A leftover `#!/usr/bin/env bun` on this source file used to
 * stack with the banner and produced a TWO-shebang artifact (issue #107):
 * bun parses the first line as shebang, the second line `#!/usr/bin/env node`
 * is then read as JS and rejected as a syntax error. Same outcome under node.
 */

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

// Port is resolved after arg parsing (--port flag can override env)
let PORT = process.env.MYAGENTS_PORT ?? '';
let BASE = '';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

function isSpaceJsonInvocation(): boolean {
  return (rawArgs[0] === 'space' || rawArgs[0] === 'issue')
    && rawArgs.some(arg => arg === '--json' || arg.startsWith('--json='));
}

/** Parse CLI arguments into structured flags and positional args */
export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names', 'image', 'file', 'attachment']);

  // PRD 0.2.18 cross-review fix (Codex): added short-flag → long-flag mapping
  // so `myagents session send <sid> -p "..."` works as documented in PRD §3.1
  // and SKILL.md. Only specific aliases are mapped; bare `-` prefixed positional
  // args remain valid (none of the current commands actually use bare-`-`
  // positional, but the explicit allow-list keeps the door open if needed).
  const shortFlagAliases: Record<string, string> = {
    'p': 'prompt',
    // Add more here if PRD documents additional short flags.
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      // Support both `--key value` and `--key=value` forms. The equals form
      // is ubiquitous in GNU-style CLIs; without it, callers (especially AI
      // agents) get silently-dropped values + confusing "missing flag" errors
      // downstream.
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
      if (key === 'human-only') {
        const nextValue = args[i + 1];
        if (inlineValue !== undefined) {
          flags.humanOnly = inlineValue;
        } else if (nextValue === 'true' || nextValue === 'false') {
          flags.humanOnly = nextValue;
          i++;
        } else {
          // Preserve the historical bare form as true. Keep (but do not
          // consume) an invalid adjacent value so Space validators can emit
          // BOOLEAN_VALUE_INVALID instead of silently treating it as true.
          flags.humanOnly = true;
          if (nextValue !== undefined && !nextValue.startsWith('-')) {
            flags.humanOnlyInvalidValue = nextValue;
          }
        }
        i++;
        continue;
      }
      // Boolean flags (no value follows). Missing entries trigger the
      // generic key-value branch below — which consumes the NEXT token as
      // value when it doesn't start with `--`. That silently eats short
      // flags like `-p` (cross-review CC BLOCKER #2: `session send <sid>
      // --no-reply -p "..."` parsed `noReply='-p'` and dropped the prompt).
      // Add any new presence-only flag here.
      if (
        key === 'help' ||
        key === 'json' ||
        key === 'dry-run' ||
        key === 'disable-nonessential' ||
        key === 'full' ||
        key === 'no-reply' ||
        key === 'clear-provider-override' ||
        key === 'clear-runtime-override' ||
        key === 'purge' ||
        key === 'stdin' ||
        key === 'active' ||
        key === 'archived' ||
        key === 'include-archived' ||
        key === 'clear-goal' ||
        key === 'create-attached' ||
        key === 'rollback'
      ) {
        flags[camelCase(key)] = key === 'create-attached'
          ? parseInlineBooleanFlag(key, inlineValue)
          : true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        if (inlineValue !== undefined) {
          arr.push(inlineValue);
          flags[cKey] = arr;
          i++;
          continue;
        }
        const value = args[i + 1];
        const requiresOrdinaryPathValue = key === 'file' || key === 'attachment';
        if (value === undefined || (requiresOrdinaryPathValue && value.startsWith('--'))) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          if (!flags[cKey]) flags[cKey] = [];
          if (requiresOrdinaryPathValue) flags[`${cKey}ValueMissing`] = true;
          i++;
          continue;
        }
        arr.push(value);
        let j = i + 2;
        while (j < args.length && !args[j].startsWith('--')) {
          arr.push(args[j]);
          j++;
        }
        flags[cKey] = arr;
        i = j;
        continue;
      }
      // Key-value flags (non-repeatable)
      if (inlineValue !== undefined) {
        flags[camelCase(key)] = inlineValue;
        i++;
        continue;
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      flags[camelCase(key)] = value;
      i += 2;
    } else if (arg.length === 2 && arg.startsWith('-') && shortFlagAliases[arg.slice(1)]) {
      // Short flag (e.g. -p) maps to long flag (--prompt). Always consumes the
      // next token as value (or treats as boolean if next is missing/another flag).
      const longKey = shortFlagAliases[arg.slice(1)]!;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        flags[camelCase(longKey)] = true;
        i++;
      } else {
        flags[camelCase(longKey)] = value;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

/**
 * Reject flags that arrived without a value (parser fell back to `true`
 * when the next token was another `--flag`). Surfaces a clear, exit-1
 * CLI error BEFORE any HTTP call — prevents the downstream handler from
 * seeing a bool where it expected a string and returning an opaque
 * "transport/parse failed" error to the AI caller.
 */
function assertStringFlag(value: unknown, flagName: string): asserts value is string | undefined {
  if (value === true) {
    console.error(`Error: --${flagName} requires a value (e.g. --${flagName} foo or --${flagName}=foo)`);
    process.exit(2);
  }
}

function parseGoalDeadlineFlag(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    console.error('Error: --deadline requires an ISO-8601 timestamp with an explicit timezone offset or Z.');
    process.exit(2);
  }
  const value = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([zZ]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    console.error(`Error: --deadline "${raw}" must include an explicit timezone offset or Z (e.g. 2026-07-22T09:00:00+08:00).`);
    process.exit(2);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const offsetHour = Number(offsetHourText ?? '0');
  const offsetMinute = Number(offsetMinuteText ?? '0');
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const calendarIsValid = month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && (offset.toLowerCase() === 'z' || (offsetHour <= 23 && offsetMinute <= 59));
  const timestamp = Date.parse(value);
  if (!calendarIsValid || Number.isNaN(timestamp)) {
    console.error(`Error: --deadline "${raw}" is not a valid ISO-8601 timestamp.`);
    process.exit(2);
  }
  return new Date(timestamp).toISOString();
}

function parseGoalMaxExecutionsFlag(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xFFFF_FFFF) {
    console.error('Error: --max-executions must be a positive integer between 1 and 4294967295.');
    process.exit(2);
  }
  return value;
}

function parseGoalAiCanExitFlag(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  console.error('Error: --ai-can-exit must be true or false.');
  process.exit(2);
}

function parseInlineBooleanFlag(key: string, inlineValue: string | undefined): boolean {
  if (inlineValue === undefined) return true;
  const normalized = inlineValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  console.error(`Error: --${key} expects a boolean value when using --${key}=...`);
  process.exit(2);
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Demand a positional argument BEFORE issuing an API call. Issue #149: on
 * Windows some commands' positional args were getting silently dropped
 * before reaching the server, surfacing as a server-side "Missing required
 * argument" or "missing field" — which makes the AI think the CLI itself
 * is at fault. This shortcut exits at the CLI boundary with a concrete
 * usage hint so the AI's recovery path is clearer than parsing a server
 * 422.
 *
 * If `value` is non-empty, returns it (narrowed to `string`). If empty,
 * exits 1 with a `myagents <command>` usage line for the AI to follow.
 *
 * `flagAlternative` documents the `--<flag>` form a caller can use as a
 * workaround when shell quoting drops a positional.
 */
function requirePositional(
  value: string | undefined,
  argName: string,
  command: string,
  flagAlternative?: string,
): string {
  const v = (value ?? '').trim();
  if (v) return v;
  console.error(`Error: ${command} requires <${argName}>.`);
  console.error(`  Usage: myagents ${command} <${argName}>${flagAlternative ? ` (or --${flagAlternative} <${argName}>)` : ''}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const TOP_HELP = `myagents — MyAgents Self-Configuration CLI

Usage: myagents <command> [options]

Commands:
  mcp       Manage MCP tool servers
  vision    Official image-understanding CLI tool
  tool      Manage registered CLI tools (Lab-gated; enable in Settings first)
  model     Manage model providers
  agent     Manage agents & channels (+ 'agent show <id>' for effective defaults)
  runtime   Inspect Agent Runtimes (list installed + describe models/modes)
  skill     Manage skills (install from URL, list, enable/disable, sync)
  cron      Manage scheduled tasks (list/add/runs/exit ...)
  goal      Manage the current session Goal (get/create/update)
  task      Manage Task Center tasks (list/get/update-status/run/rerun ...)
  thought   Manage Task Center thoughts (list/create)
  space     Discover Cloud Goals and manage Space Issues/attachments
  im        IM runtime actions for current chat (send-media)
  session   Session-to-session messaging (send prompts, watch completion/result events)
  widget    Generative UI widget design guidelines (readme)
  plugin    Manage OpenClaw channel plugins (IM npm-packaged adapters)
  cc-plugin Manage Claude plugins (PRD 0.2.17 — Anthropic plugin protocol)
  config    Read/write application config
  status    Show app running state
  version   Show app version
  reload    Hot-reload configuration
  diagnose  Diagnose external runtime state (auth, features, MCP, apps, env)

Global flags:
  --help      Show help for any command
  --json      Output as JSON
  --dry-run   Preview only commands whose exact leaf help documents support;
              unsupported mutations fail without applying changes
  --port NUM  Override Sidecar port (default: $MYAGENTS_PORT)

Examples:
  myagents mcp list
  myagents mcp show playwright
  myagents mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest
  myagents mcp enable playwright --scope both
  myagents mcp oauth discover notion-mcp
  myagents mcp oauth start notion-mcp
  myagents vision readme
  myagents vision analyze --image myagents_files/screenshot.png --prompt "Summarize the UI state"
  myagents model list
  myagents model set-key deepseek sk-xxx
  myagents skill list
  myagents skill add vercel-labs/skills --skill react-best-practices
  myagents skill add https://github.com/anthropics/skills --plugin document-skills
  myagents skill add "npx skills add foo/bar --skill baz" --force
  myagents skill remove my-skill
  myagents skill sync
  myagents cron list
  myagents goal get
  myagents goal create --objective-file goal-objective.txt --max-executions 12
  myagents goal update --status complete
  myagents runtime list                       # see installed runtimes + install hints
  myagents runtime describe codex             # models + permission modes
  myagents runtime diagnose codex             # auth / features / MCP / apps / env snapshot (issue #194)
  myagents diagnose runtime codex             # alias for runtime diagnose
  myagents agent list --archived              # archived Agent workspaces
  myagents agent show <agent-id>              # effective defaults for a workspace
  myagents agent archive <agent-id>
  myagents agent unarchive <agent-id>
  myagents task list
  myagents task get <taskId>            # returns metadata + docs paths
                                        # (task.md / verify.md / progress.md /
                                        #  alignment.md — read/edit them with
                                        #  standard Read/Edit/Write tools)
  myagents task update-status <taskId> running --message "starting work"
  myagents task update-status <taskId> verifying
  myagents task update-status <taskId> done --message "bundle size dropped 40%"
  myagents task append-session <taskId> <sessionId>
  myagents task run <taskId>
  myagents task rerun <taskId>
  myagents task create-direct --name "review PR" \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --taskMdContent "Review this PR and file findings in progress.md" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
    # Per-task runtime/model/permissionMode overrides — consult
    #   myagents runtime list  +  myagents runtime describe <runtime>
    # before choosing values. Omit any flag to inherit the agent workspace default.
  myagents task create-from-alignment <alignmentSessionId> --name "新任务"
    # Backend auto-inherits workspaceId / workspacePath / sourceThoughtId
    # from the alignment session's metadata (set when 「AI 讨论」 launched).
    # Pass --run to dispatch immediately in the same call.
    # Pass --json for machine-readable output (task_id + docs_path).
    # Same per-task override flags as create-direct apply here.
  myagents task create-attached --name "Space Issue #123" \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --taskMdContent-file task.md --source space-issue --sourceIssueId iss_123
  myagents space list --json
  myagents space --help
  myagents space whoami --space <slug> --json
  myagents space goal list --space <slug> --json
  myagents space issue list --space <slug> --goal <goalId> --state todo --limit 30
  myagents space issue view <issueId> --space <slug> --comments --json
  myagents space issue claim <issueId> --space <slug> --deliveryId <deliveryId>
  myagents space issue claim <issueId> --space <slug> --deliveryId <deliveryId> --create-attached \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --name "Space Issue #123" --taskMdContent-file task.md
  myagents space issue comment <issueId> --space <slug> --body-file result.md --attachment report.pdf
  myagents space issue comment get <issueId> <commentId> --space <slug> --json
  myagents space issue complete <issueId> --space <slug> --taskId <taskId> --body-file result.md \\
      --message "completed Space issue"
  myagents space issue attachment add <issueId> --space <slug> --file report.pdf
  myagents space issue close <issueId> --space <slug>
  myagents space attachment download <attachmentId> --space <slug> --output myagents_files/space/file.bin
  myagents thought list
  myagents plugin list
  myagents cc-plugin list
  myagents cc-plugin install anthropics/example-plugin
  myagents cc-plugin install file:///path/to/dev-plugin
  myagents cc-plugin enable my-plugin
  myagents version
  myagents reload

Run 'myagents <command> --help' for details on a specific command.`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Non-JSON error bodies (e.g. axum 4xx returns plain text like
    // "Failed to deserialize query string: missing field `doc`") would
    // crash `resp.json()` with a SyntaxError — translate to an
    // AdminResponse-shaped error so the caller can surface it cleanly.
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      return {
        success: false,
        error: text.trim() || `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    return await resp.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      if (isSpaceJsonInvocation()) {
        console.log(JSON.stringify({
          success: false,
          code: 'MYAGENTS_UNAVAILABLE',
          error: 'Cannot connect to the MyAgents app.',
          suggestion: 'Start MyAgents and retry the same Space command.',
        }, null, 2));
        process.exit(3);
      }
      console.error('Error: Cannot connect to MyAgents. Is the app running?');
      if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
        console.error('  This command appears to be running inside the Codex sandbox.');
        console.error('  If MyAgents is running on localhost, switch Codex to no-restrictions or run the command from your normal terminal.');
      }
      process.exit(3);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function printResult(
  group: string,
  action: string,
  result: Record<string, unknown>,
  jsonMode: boolean,
  flags: Record<string, unknown> = {},
  rest: string[] = [],
): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    const hasSuggestion = typeof result.suggestion === 'string' && result.suggestion.trim();
    if (hasSuggestion) {
      console.error(`Suggestion: ${result.suggestion}`);
    }
    if (typeof result.suggestedCommand === 'string' && result.suggestedCommand.trim()) {
      console.error(`  \u2192 Run: ${result.suggestedCommand}`);
      return;
    }
    if (hasSuggestion) {
      return;
    }
    // Structured recovery hint (v0.1.69+): print `→ Run: <command>   <message>`
    // below the error line in human mode so a downstream AI reader has a
    // concrete next step, not just a rejection. JSON mode preserves the full
    // shape via the `JSON.stringify` branch above.
    const hint = result.recoveryHint as { recoveryCommand?: string; message?: string } | undefined;
    if (hint && typeof hint === 'object') {
      if (hint.recoveryCommand) {
        const suffix = hint.message ? `   ${hint.message}` : '';
        console.error(`  \u2192 Run: ${hint.recoveryCommand}${suffix}`);
      } else if (hint.message) {
        console.error(`  ${hint.message}`);
      }
    }
    return;
  }

  // Dry-run
  if (result.dryRun) {
    console.log('[DRY RUN] Would apply:');
    console.log(formatObject(result.preview as Record<string, unknown>));
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Group-specific formatting
  if (group === 'mcp' && action === 'list') {
    printMcpList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'mcp' && action === 'show') {
    printMcpShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'test') {
    printMcpTest(result.data as Record<string, unknown>, result.hint);
    return;
  }
  if (group === 'tool' && action === 'list') {
    const data = result.data as { tools?: Array<Record<string, unknown>> } | undefined;
    printToolList(data?.tools ?? []);
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'tool' && action === 'env') {
    const data = (result.data as Record<string, unknown>) ?? {};
    const env = (data.env as Record<string, unknown>) ?? {};
    if (Object.keys(env).length > 0) {
      console.log(formatObject(env));
    } else {
      console.log('(no env vars set)');
    }
    const missing = data.missingKeys as string[] | undefined;
    if (missing && missing.length > 0) {
      console.log(`\nDeclared but unconfigured: ${missing.join(', ')}`);
      console.log(`  → Run: myagents tool env ${String(data.name)} set ${missing[0]}=<value>`);
    }
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'model' && action === 'list') {
    printModelList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'agent' && action === 'list') {
    printAgentList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'list') {
    printCronList(result.data as Array<Record<string, unknown>>);
    // Surface the workspace-scope note so an empty list isn't misread as
    // "no cron tasks anywhere" (#320 secondary). --json carries it inline.
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'cron' && action === 'runs') {
    printCronRuns(result.data as Array<Record<string, unknown>>, !!flags.full);
    return;
  }
  if (group === 'cron' && action === 'run-now') {
    const data = result.data as Record<string, unknown> | undefined;
    if (!data) {
      console.log('✓ Triggered.');
      return;
    }
    console.log(`✓ Triggered ${data.taskId ?? '(unknown)'}`);
    if (data.sessionId) console.log(`  session: ${data.sessionId}`);
    if (data.dispatchedAt) {
      console.log(`  dispatched: ${formatCronInstantWithUtc(data.dispatchedAt, resolveLocalTimezone())}`);
    }
    console.log(`  runs:    myagents cron runs ${data.taskId ?? '<id>'} --limit 1`);
    return;
  }
  if (group === 'cron' && action === 'stop') {
    const data = result.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId ?? '(unknown)';
    const status = data?.status ?? 'unknown';
    console.log(`✓ Task ${taskId} is not running`);
    console.log(`  status: ${status}`);
    if (status === 'blocked') {
      console.log(`  restart: myagents cron start ${taskId}`);
    }
    return;
  }
  if (group === 'cron' && action === 'update') {
    // Issue #115 — echo the computed next fire time + tz so users see
    // exactly when their schedule edit will fire next. Avoids the
    // strict-after-now confusion ("I changed to minute 33, why does
    // list show 33 next hour") by anchoring the display at update time.
    const task = result.data as Record<string, unknown> | null;
    const taskId = task?.id ?? '<id>';
    console.log(`✓ Updated ${taskId}`);
    if (task) {
      const tz = cronDisplayTimezone(task.schedule);
      console.log(`  schedule: ${formatCronTaskScheduleForDisplay(task, 'long')}`);
      const nextRaw = task.nextExecutionAt as string | undefined;
      if (nextRaw) {
        const nextMs = parseInstantMs(nextRaw);
        if (nextMs !== null) {
          const local = formatCronInstantForDisplay(nextMs, tz.timezone, 'long');
          const diffMs = nextMs - Date.now();
          const diffStr = diffMs > 0
            ? ` (in ${formatRelativeMs(diffMs)})`
            : ' (in the past)';
          console.log(`  next fire: ${local}${diffStr}`);
        }
      }
    }
    return;
  }
  if (group === 'cron' && action === 'status') {
    printCronStatus(result.data as Record<string, unknown>);
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'goal') {
    printGoalResult(action, result.data as Record<string, unknown> | undefined);
    return;
  }
  if (group === 'space' && action === 'goal' && (rest[0] || 'list') === 'list') {
    printSpaceGoalList(result.data as Record<string, unknown>, flags);
    return;
  }
  if (group === 'space' && action === 'issue' && rest[0] === 'update') {
    printSpaceIssueUpdate(result.data as Record<string, unknown>, flags);
    return;
  }
  if (group === 'plugin' && action === 'list') {
    printPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cc-plugin' && action === 'list') {
    printCcPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'list') {
    printTaskList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'get') {
    printTaskDetail(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'thought' && action === 'list') {
    printThoughtList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'list') {
    printSkillList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'info') {
    printSkillInfo(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'skill' && action === 'add') {
    printSkillAdd(result as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'oauth') {
    printMcpOAuth(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'version') {
    console.log((result.data as { version: string })?.version ?? 'Unknown');
    return;
  }
  if (group === 'agent' && action === 'runtime-status') {
    printAgentRuntimeStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'agent' && action === 'channel') {
    // `agent channel list/add/remove` — list returns an array of channel
    // descriptors; add/remove return small ack objects. Issue #149.
    const subAction = (typeof flags.action === 'string' ? flags.action : undefined)
      ?? (Array.isArray(result.data) ? 'list' : undefined);
    if (Array.isArray(result.data) || subAction === 'list') {
      printChannelList(result.data as Array<Record<string, unknown>>);
      return;
    }
    // add/remove fallthrough to generic ✓ formatter below
  }
  if (group === 'config' && action === 'get') {
    // Issue #149: was falling through to `✓ get` (id-only generic
    // formatter). Now show the actual key + (possibly redacted) value.
    const data = (result.data as Record<string, unknown>) ?? {};
    const key = data.key ?? '';
    const value = data.value;
    if (typeof value === 'object' && value !== null) {
      console.log(`${key}:`);
      console.log(formatObject(value as Record<string, unknown>));
    } else {
      console.log(`${key}: ${value === undefined ? '(unset)' : String(value)}`);
    }
    return;
  }
  if (group === 'mcp' && action === 'env') {
    // `mcp env get/set/delete` — generic ✓ formatter swallowed values for
    // get. Render env map for any sub-action (issue #149).
    const data = (result.data as Record<string, unknown>) ?? {};
    const env = (data.env as Record<string, unknown>) ?? data;
    if (env && typeof env === 'object' && Object.keys(env).length > 0) {
      console.log(formatObject(env as Record<string, unknown>));
    } else {
      console.log('(no env vars set)');
    }
    if (result.hint) console.log(`\n${result.hint}`);
    return;
  }
  if (group === 'agent' && action === 'show') {
    printAgentShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'runtime' && action === 'list') {
    printRuntimeList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'runtime' && action === 'describe') {
    printRuntimeDescribe(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'runtime' && action === 'diagnose') {
    printRuntimeDiagnose(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'vision' && action === 'analyze') {
    const data = result.data as Record<string, unknown> | undefined;
    const text = typeof data?.text === 'string' ? data.text : '';
    if (text.trim()) {
      console.log(text);
    } else {
      console.log('\u2713 vision analyze completed');
    }
    return;
  }
  if (group === 'diagnose') {
    // `myagents diagnose runtime <type>` — sugar for `runtime diagnose`.
    printRuntimeDiagnose(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'status') {
    printStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'session' && action === 'send') {
    const messageId = result.messageId ? ` ${result.messageId}` : '';
    console.log(`\u2713 session send delivered${messageId}`);
    if (result.replyBack === false) {
      console.log('  notification: one-way; MyAgents will not push the target turn result back here.');
    } else {
      console.log('  notification: MyAgents will push the target turn result back as a <myagents-session-event type="send.result"> block.');
    }
    return;
  }
  if (group === 'session' && action === 'watch') {
    if (typeof result.eventPrompt === 'string' && result.eventPrompt.trim()) {
      console.log(result.eventPrompt);
      return;
    }
    console.log(`\u2713 session watch registered ${result.watchId ?? ''}`.trim());
    console.log(`  target: ${result.targetSessionId ?? '(unknown)'}`);
    console.log(`  state:  ${result.targetStateAtRegistration ?? 'unknown'}`);
    console.log('  result: MyAgents will push a <myagents-session-event type="watch.completed"> block when the target finishes.');
    return;
  }
  if (group === 'help') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Tool readmes: `cron readme` / `im readme` / any `widget ...` form all
  // return a raw text body in result.data.text. Print it as-is — no padding,
  // no status line, no ticks — so AI can consume it directly as context.
  if (action === 'readme' || group === 'widget') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Task create-* — AI-facing flow: print task_id + docs path + next-step
  // hint + any override echo so the caller doesn't have to guess the id via
  // `ls -lt ~/.myagents/tasks/`. JSON mode above returns the full payload.
  // All create-* forms go through the same enriched server-side response.
  // `enrichTaskCreateResponse` server-side, so one printer covers both.
  if (group === 'task' && (action === 'create-direct' || action === 'create-from-alignment' || action === 'create-attached')) {
    printTaskCreateResult(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'space' && action === 'issue' && shouldCreateAttachedTaskForClaim(flags)) {
    printSpaceClaimAttachedResult(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'space' && action === 'issue' && objectValue(result.data)?.issueComplete !== undefined) {
    printSpaceIssueCompleteResult(result.data as Record<string, unknown>);
    return;
  }

  // Task run — print the engine/model the task will execute on, plus the
  // task_id echo so the caller has observability on what was dispatched.
  if (group === 'task' && (action === 'run' || action === 'rerun')) {
    printTaskDispatchResult(action, result.data as Record<string, unknown>);
    return;
  }

  // Generic success output
  const symbol = '\u2713'; // ✓
  const hint = result.hint ? ` ${result.hint}` : '';
  const id = (result.data as Record<string, unknown>)?.id ?? '';
  console.log(`${symbol} ${action} ${id}${hint}`);
}

/**
 * Format output for task create-* commands.
 *
 * AI scripts need at minimum the `task_id` of the newly minted task so they
 * can either dispatch it (`create-direct` / `create-from-alignment`) or keep
 * working in the current session (`create-attached`). Also surfaces
 * `docs_path` because the AI often wants to tell the human "I wrote the task
 * docs to X" and having that string in the CLI output saves a re-lookup.
 *
 * Plaintext shape deliberately mirrors what `--json` produces so readers
 * can mentally switch between the two without re-learning fields:
 *
 *   ✓ Task created
 *     task_id:   <uuid>
 *     name:      <string>
 *     docs_path: ~/.myagents/tasks/<uuid>/
 *     next:      myagents task run <uuid>          # non-attached tasks
 *     complete:  myagents task update-status ...   # attached tasks
 */
function printTaskCreateResult(data: Record<string, unknown>): void {
  // Handler returns { task, dispatched?, runResult? } — `task` is the full
  // Task record; `dispatched/runResult` appear when the caller passed --run.
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const name = String(task?.name ?? '');
  const home = process.env.HOME ?? '';
  const absDocs = `${home}/.myagents/tasks/${id}/`;
  const displayDocs = home && absDocs.startsWith(home)
    ? `~${absDocs.slice(home.length)}`
    : absDocs;

  console.log('\u2713 Task created');
  if (id) console.log(`  task_id:   ${id}`);
  if (name) console.log(`  name:      ${name}`);
  console.log(`  docs_path: ${displayDocs}`);

  // Surface which runtime/model/permission overrides actually landed on the
  // persisted task (read from the server-returned Task record, not echoed
  // from the request). Visible here — not buried in --json — because the AI
  // needs to confirm "the override I specified stuck" before dispatching.
  // A mismatch between `overridesRequested` and `overridden` indicates the
  // server silently dropped a field, which the AI should flag to the user.
  const overridden = (data?.overridden as string[] | undefined) ?? [];
  const overridesRequested = (data?.overridesRequested as string[] | undefined) ?? [];
  const overrides = (data?.overrides as Record<string, unknown> | undefined) ?? {};
  if (overridden.length > 0) {
    console.log(`  overrides: ${overridden.join(', ')}`);
    for (const field of overridden) {
      const v = overrides[field];
      if (v !== null && v !== undefined && v !== '') {
        const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
        console.log(`    ${field.padEnd(14)} = ${display}`);
      }
    }
  } else {
    console.log('  overrides: (none — inherits workspace defaults)');
  }
  // Drift warning: requested override didn't reach the persisted task.
  const droppedFields = overridesRequested.filter(f => !overridden.includes(f));
  if (droppedFields.length > 0) {
    console.log('');
    console.log(`  \u26A0 warning: requested overrides were NOT persisted: ${droppedFields.join(', ')}`);
    console.log('    This likely indicates a server-side deserialization gap — please report.');
  }

  const nextSteps = data?.nextSteps as Record<string, string> | undefined;
  const isAttached = task?.dispatchOrigin === 'attached-session';
  const dispatch = nextSteps?.dispatch ?? (!isAttached && id ? `myagents task run ${id}` : '');
  if (dispatch) console.log(`  next:      ${dispatch}`);
  const inspect = nextSteps?.inspect;
  if (inspect && isAttached) console.log(`  inspect:   ${inspect}`);
  const complete = nextSteps?.complete;
  if (complete) console.log(`  complete:  ${complete}`);

  // If --run was bundled with create, the backend also dispatched; echo
  // the dispatch summary inline so the caller sees both in one output.
  const runResult = data?.runResult as Record<string, unknown> | undefined;
  if (runResult) {
    console.log('');
    printTaskDispatchResult('run', runResult);
  }
}

function printSpaceClaimAttachedResult(data: Record<string, unknown>): void {
  const claim = objectValue(data.claim) ?? {};
  const taskData = objectValue(data.taskCreate) ?? {};
  const task = objectValue(data.task) ?? objectValue(taskData.task) ?? {};
  const issueId = String(data.issueId ?? claim.issueId ?? '');
  const claimId = String(claim.id ?? claim.claimId ?? '');
  const taskId = String(task.id ?? task.taskId ?? '');
  const sessionId = String(data.localSessionId ?? task.currentSessionId ?? process.env.MYAGENTS_SESSION_ID ?? '');
  const workspacePath = typeof task.workspacePath === 'string' && task.workspacePath.trim()
    ? task.workspacePath.trim()
    : '';
  const workspaceArg = workspacePath ? ` --workspacePath ${shellQuoteArg(workspacePath)}` : '';
  const spaceArg = typeof data.spaceSlug === 'string' && data.spaceSlug.trim()
    ? ` --space ${shellQuoteArg(data.spaceSlug.trim())}`
    : '';

  console.log('\u2713 Issue claimed and attached task created');
  if (issueId) console.log(`  issue_id:  ${issueId}`);
  if (claimId) console.log(`  claim_id:  ${claimId}`);
  if (taskId) console.log(`  task_id:   ${taskId}`);
  if (sessionId) console.log(`  session:   ${sessionId}`);
  if (taskId) console.log(`  inspect:   myagents task get ${taskId}`);
  if (issueId && taskId) {
    console.log(`  finish:    myagents space issue complete ${shellQuoteArg(issueId)}${spaceArg}${workspaceArg} --taskId ${shellQuoteArg(taskId)} --body-file result.md --message "completed Space issue"`);
  } else if (issueId) {
    console.log(`  complete:  myagents space issue complete ${shellQuoteArg(issueId)}${spaceArg}${workspaceArg}`);
  }
}

function printSpaceIssueCompleteResult(data: Record<string, unknown>): void {
  const issueId = String(data.issueId ?? '');
  const issueComplete = objectValue(data.issueComplete) ?? {};
  const taskUpdate = objectValue(data.taskUpdate) ?? {};
  const task = objectValue(taskUpdate.task) ?? taskUpdate;
  const taskId = String(data.taskId ?? task.id ?? '');
  const taskStatus = String(data.taskStatus ?? task.status ?? '');
  const comment = data.comment ? 'yes' : 'no';

  console.log('\u2713 Issue completion recorded');
  if (issueId) console.log(`  issue_id:  ${issueId}`);
  if (issueComplete.state || issueComplete.status) {
    console.log(`  issue:     ${String(issueComplete.state ?? issueComplete.status)}`);
  }
  console.log(`  comment:   ${comment}`);
  if (taskId) console.log(`  task_id:   ${taskId}`);
  if (taskStatus) console.log(`  task:      ${taskStatus}`);
}

function printSpaceGoalList(data: Record<string, unknown>, flags: Record<string, unknown>): void {
  const items = Array.isArray(data?.items) ? data.items as Array<Record<string, unknown>> : [];
  const slug = typeof flags.space === 'string' ? flags.space : '';
  const includeArchived = flags.includeArchived === true;
  if (items.length === 0) {
    console.log(`No ${includeArchived ? '' : 'active '}Goals in Space "${slug}".`);
    console.log('Create the Issue without --goal to place it in Inbox.');
    return;
  }

  console.log(`Goals in Space "${slug}"`);
  console.log('');
  console.log(includeArchived ? 'GOAL ID                 STATUS      PATH' : 'GOAL ID                 PATH');
  for (const goal of items) {
    const id = String(goal.id ?? '');
    const depth = typeof goal.depth === 'number' ? Math.max(0, goal.depth) : 0;
    const path = `${'  '.repeat(depth)}${String(goal.goalPathLabel ?? goal.title ?? '')}`;
    if (includeArchived) {
      const status = goal.archivedAt ? 'archived' : 'active';
      console.log(`${id.padEnd(24)}${status.padEnd(12)}${path}`);
    } else {
      console.log(`${id.padEnd(24)}${path}`);
    }
  }
  console.log('');
  console.log('Use an active GOAL ID exactly as returned:');
  console.log(`  create: myagents space issue create --space ${shellQuoteArg(slug)} ... --goal <goalId>`);
  console.log(`  move:   myagents space issue update <issueId> --space ${shellQuoteArg(slug)} --goal <goalId>`);
  console.log(`  inbox:  myagents space issue update <issueId> --space ${shellQuoteArg(slug)} --clear-goal`);
}

function printSpaceIssueUpdate(data: Record<string, unknown>, flags: Record<string, unknown>): void {
  const issue = objectValue(data?.issue) ?? data;
  const issueId = String(issue.id ?? '');
  const state = String(issue.state ?? issue.status ?? '');
  const goalId = typeof issue.goalId === 'string' && issue.goalId.trim() ? issue.goalId.trim() : '';
  const goalPathLabel = typeof issue.goalPathLabel === 'string' && issue.goalPathLabel.trim()
    ? issue.goalPathLabel.trim()
    : '';
  const slug = typeof flags.space === 'string' ? flags.space : '';

  console.log('\u2713 Issue updated');
  if (issueId) console.log(`  issue_id: ${issueId}`);
  console.log(`  goal: ${goalId ? `${goalPathLabel || '(unnamed Goal)'} (${goalId})` : 'Inbox'}`);
  if (state) console.log(`  state: ${state}`);
  if (issueId && slug) {
    console.log(`  inspect: myagents space issue view ${shellQuoteArg(issueId)} --space ${shellQuoteArg(slug)} --json`);
  }
}

/**
 * Format `myagents runtime list` output.
 *
 * Structure each row as `runtime  installed  version  displayName`, with
 * non-installed rows following up on the next line with the install hint.
 * AI callers scan this to learn which `--runtime` values are safe to pass.
 */
function printRuntimeList(rows: Array<Record<string, unknown>>): void {
  if (!rows || rows.length === 0) {
    console.log('No runtimes found.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('RUNTIME', 14) + pad('INSTALLED', 11) + pad('VERSION', 18) + 'NAME');
  for (const row of rows) {
    const rt = String(row.runtime ?? '');
    const installed = row.installed ? 'yes' : 'no';
    const version = String(row.version ?? '').split('\n')[0].slice(0, 16) || '-';
    console.log(pad(rt, 14) + pad(installed, 11) + pad(version, 18) + String(row.displayName ?? ''));
    const hint = row.notInstalledHint;
    if (hint) console.log(`    \u2192 ${String(hint)}`);
  }
  console.log('');
  console.log('Describe a runtime:  myagents runtime describe <runtime>');
}

/**
 * Format `myagents runtime describe <runtime>` output.
 *
 * Show the four things an AI needs before choosing override values:
 *   - install state (version string when installed, install hint otherwise)
 *   - available models  (`--model` accepts any of these)
 *   - permission modes  (`--permissionMode` accepts any of these)
 *   - default permission mode (so the caller knows what "no override" means)
 */
function printRuntimeDescribe(data: Record<string, unknown>): void {
  const runtime = String(data.runtime ?? '');
  const name = String(data.displayName ?? runtime);
  const installed = data.installed ? 'yes' : 'no';
  const version = data.version ? ` (${String(data.version).split('\n')[0]})` : '';
  console.log(`${name}  [${runtime}]`);
  console.log(`  installed: ${installed}${version}`);
  const defaultMode = String(data.defaultPermissionMode ?? '');
  if (defaultMode) console.log(`  default permissionMode: ${defaultMode}`);

  const models = (data.models as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Models:');
  if (models.length === 0) {
    console.log('  (none reported — runtime may not be installed, or has no static model list)');
  } else {
    for (const m of models) {
      const value = String(m.value ?? '');
      const display = String(m.displayName ?? '');
      const mark = m.isDefault ? ' *' : '';
      console.log(`  ${value.padEnd(28) || '(default)'}  ${display}${mark}`);
    }
  }

  const modes = (data.permissionModes as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Permission modes:');
  if (modes.length === 0) {
    console.log('  (runtime uses the built-in PermissionMode enum; set via --permissionMode)');
  } else {
    for (const mode of modes) {
      const value = String(mode.value ?? '');
      const label = String(mode.label ?? '');
      const desc = String(mode.description ?? '');
      console.log(`  ${value.padEnd(22)} ${label}${desc ? '  —  ' + desc : ''}`);
    }
  }

  const note = data.note;
  if (note) {
    console.log('');
    console.log(`Note: ${String(note)}`);
  }
}

/**
 * Format `myagents diagnose runtime <type>` output.
 *
 * Five sections: header (runtime + version + installed state) + auth + features
 * + mcpServers + apps + effectiveEnv. Each section reports `unsupported` or an
 * `error` string when the underlying RPC didn't complete. Designed for paste-
 * to-issue triage of issue #194 / future runtime-divergence reports.
 */
function printRuntimeDiagnose(data: Record<string, unknown>): void {
  if (!data) {
    console.log('(no diagnostic data)');
    return;
  }
  const runtime = String(data.runtime ?? '');
  const version = String(data.version ?? '');
  console.log(`Runtime: ${runtime}${version ? `  (${version})` : ''}`);

  const diag = (data.diagnostics ?? {}) as Record<string, unknown>;
  const status = (diag.status ?? {}) as Record<string, unknown>;
  const issues = (diag.issues as Array<Record<string, unknown>>) ?? [];

  const renderStatus = (s: unknown): string => {
    if (s === 'ok') return 'ok';
    if (s === 'unsupported') return 'unsupported by this runtime';
    if (s && typeof s === 'object' && 'error' in (s as Record<string, unknown>)) {
      return `error: ${String((s as { error: unknown }).error)}`;
    }
    return '(not reported)';
  };

  // Auth
  console.log('');
  console.log(`Auth [${renderStatus(status.auth)}]`);
  const auth = diag.auth as Record<string, unknown> | undefined;
  if (auth) {
    console.log(`  method: ${auth.authMethod ?? '(null)'}`);
    if (auth.requiresLogin) console.log('  requiresLogin: true');
    if (auth.details) console.log(`  details: ${auth.details}`);
  }

  // Features
  console.log('');
  console.log(`Feature flags [${renderStatus(status.features)}]`);
  const features = (diag.features as Array<Record<string, unknown>>) ?? [];
  if (features.length === 0) {
    if (status.features === 'ok') console.log('  (none enabled / all at default)');
  } else {
    for (const f of features) {
      const name = String(f.name ?? '');
      const enabled = f.enabled ? 'on ' : 'off';
      const def = f.defaultEnabled ? 'default-on ' : 'default-off';
      const stage = f.stage ? ` (${String(f.stage)})` : '';
      console.log(`  ${enabled}  ${name.padEnd(38)}  ${def}${stage}`);
    }
  }

  // MCP servers
  console.log('');
  console.log(`MCP servers [${renderStatus(status.mcpServers)}]`);
  const mcp = (diag.mcpServers as Array<Record<string, unknown>>) ?? [];
  if (mcp.length === 0) {
    if (status.mcpServers === 'ok') console.log('  (none)');
  } else {
    for (const s of mcp) {
      const name = String(s.name ?? '');
      const tools = Number(s.toolCount ?? 0);
      const resources = Number(s.resourceCount ?? 0);
      const authStatus = s.authStatus ? ` auth=${String(s.authStatus)}` : '';
      console.log(`  ${name.padEnd(28)} tools=${tools} resources=${resources}${authStatus}`);
    }
  }

  // Apps — THE diagnostic for issue #194
  console.log('');
  console.log(`Apps [${renderStatus(status.apps)}]`);
  const apps = (diag.apps as Array<Record<string, unknown>>) ?? [];
  if (apps.length === 0) {
    if (status.apps === 'ok') console.log('  (none — app discovery returned an empty list)');
  } else {
    for (const a of apps) {
      const id = String(a.id ?? '');
      const enabled = a.isEnabled ? 'enabled ' : 'disabled';
      const accessible = a.isAccessible ? 'accessible' : 'NOT accessible';
      const needs = a.needsAuth ? ' needs-auth' : '';
      console.log(`  ${enabled}  ${accessible.padEnd(15)}  ${id}${needs}`);
    }
  }

  // Effective env
  console.log('');
  console.log('Effective env (sanitized):');
  const env = (diag.effectiveEnv ?? {}) as Record<string, unknown>;
  console.log(`  cwd: ${env.cwd ?? '(unknown)'}`);
  const proxy = (env.proxy ?? {}) as Record<string, unknown>;
  console.log(`  HTTP_PROXY:  ${proxy.http ?? '(unset)'}`);
  console.log(`  HTTPS_PROXY: ${proxy.https ?? '(unset)'}`);
  console.log(`  ALL_PROXY:   ${proxy.all ?? '(unset)'}`);
  console.log(`  NO_PROXY:    ${proxy.no ?? '(unset)'}`);
  console.log(`  proxyPolicy: ${env.proxyPolicy ?? 'myagents'}`);
  console.log(`  MYAGENTS_PROXY_INJECTED: ${env.myagentsProxyInjected ? 'yes' : 'no'}`);
  const sandbox = env.codexSandbox as Record<string, unknown> | undefined;
  if (sandbox) {
    console.log(`  Codex sandbox detected: ${sandbox.detected ? 'yes' : 'no'}`);
    if ('networkDisabled' in sandbox) {
      console.log(`  Codex sandbox network disabled: ${sandbox.networkDisabled ? 'yes' : 'no'}`);
    }
    const probe = sandbox.proxyProbe as Record<string, unknown> | undefined;
    if (probe) {
      console.log(`  Loopback proxy probe: ${probe.reachable ? 'reachable' : 'blocked'} (${probe.url ?? 'unknown'})${probe.error ? ` — ${probe.error}` : ''}`);
    }
  }
  const pathHead = (env.pathHead as string[]) ?? [];
  if (pathHead.length > 0) {
    console.log(`  PATH (first ${pathHead.length}): ${pathHead.join(' : ')}`);
  }
  console.log(`  has OPENAI_API_KEY:     ${env.hasOpenaiApiKey ? 'yes' : 'no'}`);
  console.log(`  has ANTHROPIC_API_KEY:  ${env.hasAnthropicApiKey ? 'yes' : 'no'}`);
  console.log(`  has CODEX_HOME:         ${env.hasCodexHome ? 'yes' : 'no'}`);
  console.log(`  has XDG_CONFIG_HOME:    ${env.hasXdgConfigHome ? 'yes' : 'no'}`);

  if (issues.length > 0) {
    console.log('');
    console.log('Issues:');
    for (const issue of issues) {
      const sev = String(issue.severity ?? 'warn').toUpperCase();
      console.log(`  [${sev}] ${issue.code ?? 'runtime_issue'}: ${issue.title ?? issue.message ?? ''}`);
      if (issue.message) console.log(`        ${issue.message}`);
      if (issue.hint) console.log(`        Hint: ${issue.hint}`);
    }
  }

  console.log('');
  console.log(`Collected at: ${diag.timestamp ?? '(unknown)'}`);
}

/**
 * Format `myagents agent show <id>` output.
 *
 * Exposes the resolved defaults an AI would need to decide whether a task
 * override is meaningful or a no-op. Keys are printed one-per-line with
 * `(inherits provider / workspace default)` for null/empty values so the
 * reader doesn't have to guess what an absent field means.
 */
function printAgentShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No agent data.');
    return;
  }
  console.log(`Agent:       ${String(data.name ?? '')}`);
  console.log(`  id:        ${String(data.id ?? '')}`);
  console.log(`  enabled:   ${data.enabled ? 'yes' : 'no'}`);
  if (data.workspacePath) console.log(`  workspace: ${String(data.workspacePath)}`);
  const channelCount = data.channelCount;
  if (typeof channelCount === 'number') console.log(`  channels:  ${channelCount}`);
  console.log('');
  console.log('Effective defaults:');
  const defaults = (data.effectiveDefaults as Record<string, unknown>) ?? {};
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '(inherits default)';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  console.log(`  runtime:        ${fmt(defaults.runtime)}`);
  console.log(`  model:          ${fmt(defaults.model)}`);
  console.log(`  permissionMode: ${fmt(defaults.permissionMode)}`);
  console.log(`  providerId:     ${fmt(defaults.providerId)}`);
  if (defaults.runtimeConfig) {
    console.log(`  runtimeConfig:  ${JSON.stringify(defaults.runtimeConfig)}`);
  }
  console.log('');
  console.log('Describe this runtime:  myagents runtime describe <runtime>');
}

/**
 * Format output for `task run` / `task rerun`.
 *
 * Answers the "what will this actually run on?" question so the AI caller
 * can relay engine/model back to the human in chat. `runtime` and `model`
 * are read from the updated Task record — both can be null/undefined
 * (meaning "use agent default" / "use provider default"); we explicitly
 * label that case rather than hiding it.
 */
function printTaskDispatchResult(
  action: string,
  data: Record<string, unknown>,
): void {
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const runtime = (task?.runtime as string) || 'builtin';
  const model = (task?.model as string) || '(agent default)';

  console.log(`\u2713 Task ${action === 'rerun' ? 'redispatched' : 'dispatched'}`);
  if (id) console.log(`  task_id:  ${id}`);
  console.log(`  runtime:  ${runtime}`);
  console.log(`  model:    ${model}`);
}

function printToolList(tools: Array<Record<string, unknown>>): void {
  if (!tools || tools.length === 0) {
    console.log('No CLI tools registered.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('NAME', 22) + pad('KIND', 8) + pad('STATUS', 10) + 'DESCRIPTION');
  for (const t of tools) {
    const status = t.enabled ? 'enabled' : 'disabled';
    const desc = String(t.description ?? '').replace(/\s+/g, ' ');
    const missing = (t.missingEnvKeys as string[] | undefined) ?? [];
    const warn = missing.length > 0 ? `  [missing env: ${missing.join(', ')}]` : '';
    console.log(pad(String(t.name), 22) + pad(String(t.kind ?? ''), 8) + pad(status, 10) + desc.slice(0, 80) + warn);
  }
  const enabled = tools.filter(t => t.enabled).length;
  console.log(`\n${tools.length} CLI tools (${enabled} in AI context)`);
}

function printMcpList(servers: Array<Record<string, unknown>>): void {
  if (!servers || servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');
  for (const s of servers) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const builtin = s.isBuiltin ? ' (built-in)' : '';
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter(s => s.enabled).length;
  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);
}

function printCuseDiagnostics(cuse: Record<string, unknown>, indent = '  '): void {
  const bundled = (cuse.bundled as Record<string, unknown> | undefined) ?? {};
  console.log(`${indent}path:       ${String(bundled.path ?? '(not resolved)')}`);
  console.log(`${indent}version:    ${String(bundled.rawVersion ?? bundled.version ?? '(unknown)')}`);
  if (bundled.error) console.log(`${indent}error:      ${String(bundled.error)}`);

  const marker = cuse.versionMarker as Record<string, unknown> | null | undefined;
  if (marker) {
    const markerState = marker.matchesBundled === false ? 'mismatch' : 'ok';
    console.log(`${indent}marker:     ${String(marker.rawVersion ?? marker.version ?? '(unknown)')} (${markerState})`);
    console.log(`${indent}markerPath: ${String(marker.path ?? '')}`);
  }

  const latest = cuse.r2Latest as Record<string, unknown> | null | undefined;
  if (latest) {
    const suffix = latest.error ? ` (${String(latest.error)})` : '';
    console.log(`${indent}r2Latest:   ${String(latest.version ?? '(unknown)')}${suffix}`);
  }

  const caches = (cuse.skillCaches as Array<Record<string, unknown>> | undefined) ?? [];
  if (caches.length > 0) {
    console.log(`${indent}skill caches:`);
    for (const cache of caches) {
      const status = cache.differsFromBundledHash === true
        ? 'fingerprint differs'
        : cache.differsFromBundledHash === false
          ? 'same fingerprint'
          : 'fingerprint unknown';
      const size = typeof cache.sizeBytes === 'number' ? `, ${cache.sizeBytes} bytes` : '';
      console.log(`${indent}  - ${String(cache.label ?? cache.source ?? 'skill')}: ${status}${size}`);
      console.log(`${indent}    ${String(cache.path ?? '')}`);
      if (cache.sha256) console.log(`${indent}    sha256: ${String(cache.sha256).slice(0, 12)}...`);
      if (cache.checkCommand) console.log(`${indent}    check: ${String(cache.checkCommand)}`);
      if (cache.error) console.log(`${indent}    note: ${String(cache.error)}`);
    }
  }

  const warnings = (cuse.warnings as string[] | undefined) ?? [];
  if (warnings.length > 0) {
    console.log(`${indent}warnings:`);
    for (const warning of warnings) {
      console.log(`${indent}  - ${warning}`);
    }
  }
}

/**
 * Format `myagents mcp show <id>` output.
 *
 * Parallels printAgentShow — prints the user-visible config + enable state
 * (global / per-project) for a single server. Env and headers are rendered
 * as `key = <redacted>` lines when values exist; AI callers can read the
 * structure without ever seeing a secret.
 */
function printMcpShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No MCP data.');
    return;
  }
  console.log(`MCP Server:   ${String(data.name ?? '')}`);
  console.log(`  id:         ${String(data.id ?? '')}`);
  console.log(`  type:       ${String(data.type ?? '')}`);
  if (data.description) console.log(`  description:${String(data.description)}`);
  console.log(`  built-in:   ${data.isBuiltin ? 'yes' : 'no'}`);

  const enabled = (data.enabled as { global?: boolean; project?: boolean | null }) ?? {};
  const globalState = enabled.global ? 'enabled' : 'disabled';
  const projectState = enabled.project === null || enabled.project === undefined
    ? '(no active workspace)'
    : enabled.project
      ? 'enabled'
      : 'disabled';
  console.log('');
  console.log('Enable state:');
  console.log(`  global:     ${globalState}`);
  console.log(`  project:    ${projectState}`);
  if (data.workspacePath) console.log(`  workspace:  ${String(data.workspacePath)}`);

  console.log('');
  console.log('Transport:');
  if (data.command) console.log(`  command:    ${String(data.command)}`);
  if (data.resolvedCommand) console.log(`  resolved:   ${String(data.resolvedCommand)}`);
  if (Array.isArray(data.args) && (data.args as unknown[]).length > 0) {
    console.log(`  args:       ${(data.args as unknown[]).map(String).join(' ')}`);
  }
  if (data.url) console.log(`  url:        ${String(data.url)}`);

  const diagnostics = data.diagnostics as Record<string, unknown> | undefined;
  const cuse = diagnostics?.cuse as Record<string, unknown> | undefined;
  if (cuse) {
    console.log('');
    console.log('Bundled cuse:');
    printCuseDiagnostics(cuse);
  }

  const env = data.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    console.log('');
    console.log('Env (values redacted):');
    for (const [k, v] of Object.entries(env)) {
      console.log(`  ${k} = ${v}`);
    }
  }
  const headers = data.headers as Record<string, string> | undefined;
  if (headers && Object.keys(headers).length > 0) {
    console.log('');
    console.log('Headers (values redacted):');
    for (const [k, v] of Object.entries(headers)) {
      console.log(`  ${k} = ${v}`);
    }
  }

  if (data.requiresConfig) {
    console.log('');
    console.log('Note: this server requires configuration before it can be enabled.');
    if (data.websiteUrl) console.log(`  See: ${String(data.websiteUrl)}`);
  }
}

function printMcpTest(data: Record<string, unknown>, hint?: unknown): void {
  const id = String(data?.id ?? 'unknown');
  console.log(`✓ MCP ${id} validated`);
  const cuse = data?.cuse as Record<string, unknown> | undefined;
  if (cuse) {
    console.log('');
    console.log('Bundled cuse:');
    printCuseDiagnostics(cuse);
    return;
  }
  if (hint) console.log(`\n${String(hint)}`);
}

export function printModelList(providers: Array<Record<string, unknown>>): void {
  if (!providers || providers.length === 0) {
    console.log('No model providers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');
  for (const p of providers) {
    // Disabled providers retain their verify status but the disabled label
    // overrides — they can't be used until re-enabled in Settings.
    const status = p.enabled === false ? 'disabled' : String(p.status);
    console.log(pad(String(p.id), 24) + pad(status, 12) + String(p.name));
    const models = Array.isArray(p.models)
      ? p.models.flatMap(model => {
        if (!model || typeof model !== 'object') return [];
        const record = model as Record<string, unknown>;
        const id = typeof record.model === 'string' ? record.model : '';
        if (!id) return [];
        const name = typeof record.modelName === 'string' && record.modelName !== id
          ? ` (${record.modelName})`
          : '';
        return [`${id}${name}`];
      })
      : [];
    console.log(`  Primary: ${String(p.primaryModel ?? 'not set')}`);
    console.log(`  Models:  ${models.length > 0 ? models.join(', ') : 'none'}`);
  }
}

function printAgentList(agents: Array<Record<string, unknown>>): void {
  if (!agents || agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Status', 11) + pad('Channels', 10) + 'Name');
  for (const a of agents) {
    const status = a.archived ? 'archived' : (a.enabled ? 'enabled' : 'disabled');
    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 11) + pad(String(a.channelCount), 10) + String(a.name));
  }
}

function printStatus(data: Record<string, unknown>): void {
  const mcp = data.mcpServers as Record<string, number>;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}

export function resolveLocalTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimezone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseInstantMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const raw = value.trim();
    const asNumber = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = new Date(raw).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timezoneOffset(ms: number, timezone: string, prefix: 'utc' | 'plain' = 'utc'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date(ms));
    const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (raw === 'GMT' || raw === 'UTC') return prefix === 'utc' ? 'UTC+00:00' : '+00:00';
    const match = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return prefix === 'utc' ? raw.replace(/^GMT/, 'UTC') : raw;
    const [, sign, hour, minute = '00'] = match;
    const normalized = `${sign}${hour.padStart(2, '0')}:${minute}`;
    return prefix === 'utc' ? `UTC${normalized}` : normalized;
  } catch {
    return prefix === 'utc' ? 'UTC?' : '?';
  }
}

function formatDateTimeInTimezone(ms: number, timezone: string, withSeconds = false): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatCronInstantForDisplay(
  value: unknown,
  timezone = resolveLocalTimezone(),
  style: 'long' | 'table' | 'tableSeconds' = 'long',
): string {
  const ms = parseInstantMs(value);
  if (ms === null) return '—';
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const local = formatDateTimeInTimezone(ms, tz, style === 'tableSeconds');
  if (style === 'table' || style === 'tableSeconds') {
    return `${local} ${timezoneOffset(ms, tz, 'plain')}`;
  }
  return `${local} ${tz} (${timezoneOffset(ms, tz, 'utc')})`;
}

function formatCronInstantWithUtc(value: unknown, timezone = resolveLocalTimezone()): string {
  const ms = parseInstantMs(value);
  if (ms === null) return '—';
  return `${formatCronInstantForDisplay(ms, timezone, 'long')} [UTC ${new Date(ms).toISOString()}]`;
}

function cronDisplayTimezone(schedule: unknown): { timezone: string; label: string } {
  if (schedule && typeof schedule === 'object') {
    const s = schedule as Record<string, unknown>;
    if (s.kind === 'cron') {
      const raw = typeof s.tz === 'string' ? s.tz.trim() : '';
      if (!raw) return { timezone: 'UTC', label: 'UTC(default)' };
      if (isValidTimezone(raw)) return { timezone: raw, label: raw };
      return { timezone: 'UTC', label: `${raw}(invalid; UTC shown)` };
    }
  }
  const local = resolveLocalTimezone();
  return { timezone: local, label: local };
}

export function formatCronTaskScheduleForDisplay(
  task: Record<string, unknown>,
  style: 'short' | 'long' = 'short',
): string {
  const schedule = task.schedule as Record<string, unknown> | undefined;
  if (schedule && typeof schedule === 'object') {
    switch (schedule.kind) {
      case 'cron': {
        const expr = String(schedule.expr ?? '').trim() || '<empty cron>';
        const tz = cronDisplayTimezone(schedule);
        return style === 'long' ? `${expr} @ ${tz.label}` : expr;
      }
      case 'every': {
        const minutes = Number(schedule.minutes);
        return Number.isFinite(minutes) ? `every ${minutes}m` : 'every ?m';
      }
      case 'at': {
        if (style === 'long') {
          const tz = cronDisplayTimezone(schedule);
          return `once @ ${formatCronInstantForDisplay(schedule.at, tz.timezone, 'long')}`;
        }
        return 'once';
      }
      case 'loop':
        return 'loop';
      default:
        return String(schedule.kind ?? 'unknown');
    }
  }
  const interval = Number(task.intervalMinutes);
  return Number.isFinite(interval) ? `every ${interval}m` : 'every ?m';
}

function clipCell(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function printCronList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('No cron tasks configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // R9: status carries the raw enum name (Running / Stopped) — the
  // scheduler-state vocabulary. The transient "currently executing" state
  // is a separate concept, surfaced via `t.currentlyExecuting` and
  // rendered as a `*` marker after the task ID. See `cron readme` for
  // the full vocabulary explanation.

  const fmtDuration = (ms: unknown): string => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  console.log(
    pad('ID', 24) +
    pad('Status', 10) +
    pad('Schedule', 22) +
    pad('TZ', 20) +
    pad('Next', 26) +
    pad('Last', 28) +
    pad('Dur', 9) +
    pad('Runs', 6) +
    'Name'
  );
  for (const t of tasks) {
    const schedule = formatCronTaskScheduleForDisplay(t, 'short');
    const tz = cronDisplayTimezone(t.schedule);
    const lastOk = t.lastRunOk;
    const lastMark = lastOk === true ? '✓ ' : lastOk === false ? '✗ ' : '  ';
    const lastTime = formatCronInstantForDisplay(t.lastExecutedAt, tz.timezone, 'table');
    const last = lastTime === '—' ? '—' : `${lastMark}${lastTime}`;
    // Asterisk marker = a tick is firing this very instant (scheduled or
    // run-now). Distinct from `Running` status — see `cron readme`.
    const idDisplay = `${String(t.id).slice(0, 22)}${t.currentlyExecuting ? '*' : ''}`;
    console.log(
      pad(idDisplay, 24) +
      pad(String(t.status), 10) +
      pad(clipCell(schedule, 20), 22) +
      pad(clipCell(tz.label, 18), 20) +
      pad(formatCronInstantForDisplay(t.nextExecutionAt, tz.timezone, 'table'), 26) +
      pad(clipCell(last, 26), 28) +
      pad(fmtDuration(t.lastRunDurationMs), 9) +
      pad(String(t.executionCount ?? 0), 6) +
      String(t.name ?? (t.prompt as string)?.slice(0, 40) ?? '')
    );
  }
  const running = tasks.filter(t => t.status === 'Running').length;
  const executing = tasks.filter(t => t.currentlyExecuting === true).length;
  const execNote = executing > 0 ? `, ${executing} executing now` : '';
  console.log(`\n${tasks.length} cron tasks (${running} running${execNote})`);
}

function printCronRuns(runs: Array<Record<string, unknown>>, full: boolean = false): void {
  if (!runs || runs.length === 0) {
    console.log('No execution records.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // PRD 0.2.5 R7 \u2014 collapse all whitespace runs (newlines included) so a
  // multi-line content cell doesn't break column alignment of the next row.
  // `full` mode keeps original content but renders one line per row anyway \u2014
  // user opts into that explicitly.
  const formatCell = (s: string, maxLen: number): string => {
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (full || collapsed.length <= maxLen) return collapsed;
    return collapsed.slice(0, maxLen - 1) + '\u2026';
  };

  const outputMaxLen = full ? Number.POSITIVE_INFINITY : 80;
  const localTz = resolveLocalTimezone();
  console.log(`Times shown in ${localTz} (${timezoneOffset(Date.now(), localTz, 'utc')}). Raw timestamps are available with --json.`);
  console.log(pad('Time', 31) + pad('Status', 8) + pad('Duration', 12) + 'Output');
  for (const r of runs) {
    const time = formatCronInstantForDisplay(r.ts, localTz, 'tableSeconds');
    const status = r.ok ? '\u2713' : '\u2717';
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '?';
    const raw = r.ok ? String(r.content ?? '') : String(r.error ?? '');
    const output = formatCell(raw, outputMaxLen);
    console.log(pad(time, 31) + pad(status, 8) + pad(dur, 12) + output);
  }
}

function printCronStatus(data: Record<string, unknown>): void {
  const localTz = resolveLocalTimezone();
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running:     ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) {
    console.log(`Last executed: ${formatCronInstantWithUtc(data.lastExecutedAt, localTz)}`);
  }
  if (data.nextExecutionAt) {
    console.log(`Next execution: ${formatCronInstantWithUtc(data.nextExecutionAt, localTz)}`);
  }
  if (data.lastExecutedAt || data.nextExecutionAt) {
    console.log(`Display timezone: ${localTz} (${timezoneOffset(Date.now(), localTz, 'utc')}); per-task cron tz is shown by 'myagents cron list'.`);
  }
}

export function printGoalResult(action: string, data?: Record<string, unknown>): void {
  const goal = (data?.goal as Record<string, unknown> | null | undefined) ?? null;
  if (!goal) {
    console.log('No active Goal in the current session.');
    return;
  }
  const prefix = action === 'create'
    ? '✓ Goal created'
    : action === 'update'
      ? '✓ Goal updated'
      : 'Goal';
  console.log(prefix);
  console.log(`  id:            ${goal.id ?? '(unknown)'}`);
  console.log(`  status:        ${goal.status ?? '(unknown)'}`);
  console.log(`  settled turns: ${goal.turnCount ?? 0}`);
  if (typeof goal.executionNumber === 'number') {
    console.log(`  current turn:  ${goal.executionNumber}${goal.isExecuting === true ? ' (executing)' : ''}`);
  }
  if (goal.updatedAt) console.log(`  updated: ${goal.updatedAt}`);
  if (goal.terminalReason) console.log(`  reason:  ${goal.terminalReason}`);
  const endConditions = goal.endConditions as Record<string, unknown> | undefined;
  if (endConditions && (
    endConditions.deadline !== undefined
    || endConditions.maxExecutions !== undefined
    || typeof endConditions.aiCanExit === 'boolean'
  )) {
    console.log('  end conditions:');
    if (endConditions.deadline !== undefined) {
      console.log(`    deadline:       ${formatCronInstantWithUtc(endConditions.deadline, resolveLocalTimezone())}`);
    }
    if (endConditions.maxExecutions !== undefined) {
      console.log(`    max executions: ${endConditions.maxExecutions}`);
    }
    if (typeof endConditions.aiCanExit === 'boolean') {
      console.log(`    AI can exit:    ${endConditions.aiCanExit ? 'yes' : 'no'}`);
    }
  }
  if (goal.objective) {
    const objective = String(goal.objective).replace(/\s+/g, ' ').trim();
    console.log(`  objective: ${objective.length > 180 ? `${objective.slice(0, 179)}…` : objective}`);
  }
}

function printChannelList(channels: Array<Record<string, unknown>>): void {
  if (!channels || channels.length === 0) {
    console.log('No channels configured for this agent.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Type', 26) + pad('Enabled', 10) + 'Name');
  for (const ch of channels) {
    const id = String(ch.id ?? '?').slice(0, 36);
    const type = String(ch.type ?? '?').slice(0, 24);
    const enabled = ch.enabled === false ? 'off' : 'on';
    const name = String(ch.name ?? '');
    console.log(pad(id, 38) + pad(type, 26) + pad(enabled, 10) + name);
  }
  console.log(`\n${channels.length} channel(s)`);
}

function printCcPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No Claude plugins installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('STATUS', 10) + pad('NAME', 24) + pad('VERSION', 12) + pad('SOURCE', 24) + 'DESCRIPTION');
  for (const p of plugins) {
    const enabled = p.enabled === true;
    const status = p.status as string;
    const statusLabel = status === 'ok'
      ? (enabled ? '✓ enabled' : '· disabled')
      : `! ${status}`;
    const name = String(p.name ?? '?').slice(0, 22);
    const version = String(p.version ?? '?').slice(0, 10);
    const source = String(p.sourceUrl ?? '').slice(0, 22);
    const desc = String(p.description ?? '');
    console.log(pad(statusLabel, 10) + pad(name, 24) + pad(version, 12) + pad(source, 24) + desc);
  }
  console.log(`\n${plugins.length} plugin(s) installed`);
}

function printPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  // Issue #149: Rust returns plugin objects with `pluginId / npmSpec /
  // packageVersion / manifest` fields, NOT `id / name / version /
  // description`. The previous formatter read the wrong fields and printed
  // `?` for every cell. The display name comes from the manifest's `name`
  // (a friendly label like "Feishu" or "WeChat"); the `pluginId` is a
  // slug-style internal id. Description lives at `manifest.description`.
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 28) + pad('Version', 14) + pad('Name', 22) + 'Description');
  for (const p of plugins) {
    const manifest = (p.manifest as Record<string, unknown> | undefined) ?? {};
    const id = String(p.pluginId ?? p.npmSpec ?? '?').slice(0, 26);
    const version = String(p.packageVersion ?? '?');
    const name = String(manifest.name ?? p.npmSpec ?? '').slice(0, 20);
    const desc = String(manifest.description ?? '');
    console.log(pad(id, 28) + pad(version, 14) + pad(name, 22) + desc);
  }
  console.log(`\n${plugins.length} plugin(s) installed`);
}

function printSkillList(skills: Array<Record<string, unknown>>): void {
  if (!skills || skills.length === 0) {
    console.log('No skills installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Folder', 28) + pad('Scope', 10) + pad('Enabled', 10) + 'Description');
  for (const s of skills) {
    const enabled = s.enabled === false ? 'off' : 'on';
    const desc = String(s.description ?? '').slice(0, 60);
    console.log(
      pad(String(s.folderName ?? s.name ?? '?').slice(0, 26), 28) +
      pad(String(s.scope ?? 'user'), 10) +
      pad(enabled, 10) +
      desc,
    );
  }
  console.log(`\n${skills.length} skill(s)`);
}

function printSkillInfo(data: Record<string, unknown>): void {
  if (!data) {
    console.log('Skill not found.');
    return;
  }
  const fm = (data.frontmatter as Record<string, unknown>) || {};
  console.log(`Name:        ${fm.name ?? data.name ?? '?'}`);
  console.log(`Folder:      ${data.folderName ?? '?'}`);
  console.log(`Scope:       ${data.scope ?? 'user'}`);
  console.log(`Description: ${fm.description ?? ''}`);
  if (fm.author) console.log(`Author:      ${fm.author}`);
  if (fm['allowed-tools']) console.log(`Allowed:     ${JSON.stringify(fm['allowed-tools'])}`);
  console.log(`Path:        ${data.path ?? ''}`);
}

function printSkillAdd(result: Record<string, unknown>): void {
  const installed = result.installed as Array<Record<string, unknown>> | undefined;
  if (installed && installed.length > 0) {
    console.log(`\u2713 Installed ${installed.length} skill(s):`);
    for (const s of installed) {
      console.log(`  - ${s.folderName} — ${s.description ?? ''}`);
    }
    if (result.sourceUrl) console.log(`\nSource: ${result.sourceUrl}`);
    return;
  }
  // Fall-through: preview / dry-run / error path already handled by generic branch
  console.log(`\u2713 ${result.hint ?? 'done'}`);
}

function printTaskList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  console.log(`Tasks (${tasks.length}):`);
  for (const t of tasks) {
    const status = String(t.status ?? '?');
    const mode = String(t.executionMode ?? 'once');
    const origin = String(t.dispatchOrigin ?? 'direct');
    console.log(`  ${t.id}  [${status}]  ${t.name}`);
    console.log(
      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${
        Array.isArray(t.sessionIds) ? (t.sessionIds as string[]).length : 0
      }`,
    );
  }
}

function printTaskDetail(task: Record<string, unknown>): void {
  if (!task) {
    console.log('(task not found)');
    return;
  }

  // Identity + top-line state
  console.log(`Task: ${task.name ?? '(unnamed)'}`);
  console.log(`  ID:             ${task.id}`);
  const statusLine = String(task.status ?? '?');
  const updatedAt = typeof task.updatedAt === 'number' ? new Date(task.updatedAt).toISOString() : undefined;
  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ''}`);
  console.log(`  Executor:       ${task.executor ?? '?'}`);
  console.log(`  Execution mode: ${task.executionMode ?? '?'}`);
  console.log(`  Dispatch:       ${task.dispatchOrigin ?? '?'}`);
  if (task.workspacePath || task.workspaceId) {
    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);
  }
  if (task.description) console.log(`  Description:    ${task.description}`);
  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);
  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);
  if (task.model) console.log(`  Model override: ${task.model}`);
  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);
  if (Array.isArray(task.tags) && (task.tags as string[]).length > 0) {
    console.log(`  Tags:           ${(task.tags as string[]).join(', ')}`);
  }

  // Docs paths — the highlight of `task get`. AI consumers read these
  // files with standard Read/Edit/Write tools; there are no separate
  // `show-doc` / `write-doc` CLIs (removed v0.1.69+).
  const docs = task.docs as Record<string, string | undefined> | undefined;
  if (docs) {
    console.log('\nDocs (read/edit/write these directly — they are YOUR workspace):');
    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);
    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);
    if (docs.verifyMd) console.log(`  verify.md:      ${docs.verifyMd}`);
    if (docs.progressMd) console.log(`  progress.md:    ${docs.progressMd}`);
    if (docs.alignmentMd) console.log(`  alignment.md:   ${docs.alignmentMd}`);
  }

  // Schedule — only for scheduled / recurring / loop tasks
  const mode = String(task.executionMode ?? 'once');
  if (mode !== 'once') {
    console.log('\nSchedule:');
    if (task.cronExpression) {
      const cronTz = typeof task.cronTimezone === 'string' && task.cronTimezone.trim()
        ? task.cronTimezone.trim()
        : 'UTC(default legacy)';
      console.log(
        `  Cron:           ${task.cronExpression} @ ${cronTz}`,
      );
    } else if (task.intervalMinutes) {
      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);
    } else if (task.dispatchAt) {
      console.log(`  Dispatch at:    ${formatCronInstantWithUtc(task.dispatchAt, resolveLocalTimezone())}`);
    }
    if (task.lastExecutedAt) {
      console.log(`  Last executed:  ${formatCronInstantWithUtc(task.lastExecutedAt, resolveLocalTimezone())}`);
    }
  }

  // End conditions — when present, they're decision-relevant
  const end = task.endConditions as Record<string, unknown> | undefined;
  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {
    console.log('\nEnd conditions:');
    if (end.deadline) {
      console.log(`  Deadline:       ${formatCronInstantWithUtc(end.deadline, resolveLocalTimezone())}`);
    }
    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);
    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);
  }

  // Notification — for unattended modes (recurring / scheduled / loop), the
  // absence of a bot channel is decision-relevant: the task runs to disk but
  // nothing reaches the user's IM. Surface this even when `notification` is
  // None so CLI users don't have to grep `management_api.rs` to learn the
  // mechanism exists (issue #205 gap #6).
  const notif = task.notification as Record<string, unknown> | undefined;
  const unattended = mode === 'recurring' || mode === 'scheduled' || mode === 'loop';
  if (notif) {
    console.log('\nNotification:');
    console.log(`  Desktop:        ${notif.desktop !== false ? 'on' : 'off'}`);
    if (notif.botChannelId) {
      console.log(`  Bot channel:    ${notif.botChannelId}`);
    } else if (unattended) {
      console.log('  Bot channel:    (not set — IM push disabled; set --notificationBotChannelId via `task update`)');
    }
    if (Array.isArray(notif.events) && (notif.events as string[]).length > 0) {
      console.log(`  Events:         ${(notif.events as string[]).join(', ')}`);
    }
  } else if (unattended) {
    console.log('\nNotification:');
    console.log('  Desktop:        on (default)');
    console.log('  Bot channel:    (not set — IM push disabled; set --notificationBotChannelId via `task update`)');
  }

  // Sessions + source thought
  const sessionIds = Array.isArray(task.sessionIds) ? (task.sessionIds as string[]) : [];
  if (sessionIds.length > 0) {
    console.log(`\nSessions:         ${sessionIds.join(', ')} (${sessionIds.length} total)`);
  }

  // Recent status changes — last 5, with counter
  const hist = task.statusHistory as Array<Record<string, unknown>> | undefined;
  if (hist && hist.length > 0) {
    const last5 = hist.slice(-5);
    console.log(`\nRecent changes (${last5.length} of ${hist.length}):`);
    for (const h of last5) {
      const at = typeof h.at === 'number' ? new Date(h.at).toISOString() : String(h.at ?? '');
      const actor = String(h.actor ?? '?');
      const source = h.source ? `/${h.source}` : '';
      const from = h.from ?? '—';
      const msg = h.message ? `   "${h.message}"` : '';
      console.log(`  ${at}  ${actor}${source}  ${from} → ${h.to}${msg}`);
    }
  }

  // Footer — next-step hints so the AI / user doesn't have to guess
  console.log('\nNext steps:');
  console.log('  myagents task update-status <id> <status> [--message ...]  # transition state machine');
  console.log('  myagents task run <id>                                     # dispatch immediately');
  console.log('  myagents task rerun <id>                                   # re-arm stopped/blocked task');
  console.log('  myagents task --help                                       # full Task CLI reference');
}

function printThoughtList(thoughts: Array<Record<string, unknown>>): void {
  if (!thoughts || thoughts.length === 0) {
    console.log('(no thoughts)');
    return;
  }
  console.log(`Thoughts (${thoughts.length}):`);
  for (const t of thoughts) {
    const content = String(t.content ?? '');
    const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    const convCount = Array.isArray(t.convertedTaskIds)
      ? (t.convertedTaskIds as string[]).length
      : 0;
    console.log(`  ${t.id}  ${preview}`);
    if (tags.length || convCount) {
      const bits: string[] = [];
      if (tags.length) bits.push(`tags=${tags.join(',')}`);
      if (convCount) bits.push(`tasks=${convCount}`);
      console.log(`     ${bits.join('  ')}`);
    }
  }
}

function printMcpOAuth(data: Record<string, unknown>): void {
  if (!data) return;
  const id = data.id ?? '';

  // discover result
  if (data.required !== undefined) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);
    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');
    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);
    return;
  }

  // status result
  if (data.status !== undefined) {
    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }

  // start result (authUrl present)
  if (data.authUrl) {
    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);
    return;
  }

  // Generic fallback (revoke, etc.)
  console.log(`\u2713 ${id}: done`);
}

function printAgentRuntimeStatus(data: Record<string, unknown>): void {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log('No agents running.');
    return;
  }
  for (const a of entries as Array<Record<string, unknown>>) {
    const enabled = a.enabled ? 'enabled' : 'disabled';
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = (a.channels as Array<Record<string, unknown>>) ?? [];
    if (channels.length === 0) {
      console.log('  No channels');
    } else {
      const pad = (s: string, n: number) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : '';
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : '';
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log('');
  }
}

/// Issue #115 — format a millisecond-precision delta into a coarse
/// "in X" string for `cron update` next-fire echoes. Reads naturally for
/// the cases users care about: a few seconds, a few minutes, an hour-ish,
/// a day-ish. Beyond a day we fall back to days+hours.
function formatRelativeMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;
      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;
      return `${indent}${k}: ${v}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;

  // Top-level help (no args, or bare --help)
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }

  if (!flags.help) rejectUnsupportedSpaceDryRun(positional, flags);

  // Resolve port: --port flag overrides env
  PORT = (flags.port as string) || PORT;
  if (!PORT) {
    if (groupIsSpaceCommand(positional[0]) && jsonMode) {
      return exitAgentCliError(flags, {
        code: 'MYAGENTS_PORT_REQUIRED',
        error: 'The MyAgents local API port is unavailable.',
        suggestion: 'Run this command from an active MyAgents Session or start the app and retry.',
      }, 3);
    }
    console.error('Error: MYAGENTS_PORT not set. This CLI runs within the MyAgents app.');
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;

  // Help flag for sub-commands
  if (flags.help) {
    const result = await callApi('help', { path: positional });
    printResult('help', 'help', result, jsonMode);
    return;
  }

  const group = positional[0];
  const action = positional[1] || 'list';

  // Simple commands (no subcommand)
  let result: Record<string, unknown>;
  if (group === 'status') {
    result = await callApi('status');
    printResult('status', 'status', result, jsonMode);
  } else if (group === 'reload') {
    result = await callApi('reload', { workspacePath: flags.workspacePath });
    printResult('reload', 'reload', result, jsonMode);
  } else if (group === 'version') {
    result = await callApi('version');
    printResult('version', 'version', result, jsonMode);
  } else {
    // Build request body based on group/action
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);

    // `task update` notification merge (issue #205 cross-review): Rust
    // `TaskStore::update` REPLACES `notification` wholesale when the field
    // is present, so a partial CLI patch like `--notificationDesktop false`
    // would clear an existing `botChannelId`. Read the current notification
    // and merge the user's flags on top so partial updates are non-
    // destructive. Limited to the `task update` path — `create-direct`
    // doesn't need merging since there's nothing to preserve. The fetch
    // round-trip is unconditional on this path (only fires when a
    // --notification* flag was actually passed) so it costs nothing in the
    // common "interval-only" patch case.
    if (
      group === 'task'
      && action === 'update'
      && body
      && (body as Record<string, unknown>).notification !== undefined
    ) {
      const idForFetch = (body as Record<string, unknown>).id as string | undefined;
      if (idForFetch) {
        const fetched = await callApi(`task/get`, { id: idForFetch });
        if (fetched.success && fetched.data) {
          const existing =
            ((fetched.data as Record<string, unknown>).task as Record<string, unknown> | undefined)
            ?? (fetched.data as Record<string, unknown>);
          const existingNotif = (existing.notification as Record<string, unknown> | undefined) ?? {};
          const userNotif = (body as Record<string, unknown>).notification as Record<string, unknown>;
          // Order matters: spread existing first so user values win.
          (body as Record<string, unknown>).notification = { ...existingNotif, ...userNotif };
        }
        // Best-effort: if the get fails (rare — task ids are local), fall
        // through with the partial. Rust will surface the real error on the
        // subsequent update call.
      }
    }

    if (
      group === 'space' &&
      action === 'issue' &&
      restArgs[0] === 'claim' &&
      shouldCreateAttachedTaskForClaim(flags)
    ) {
      result = await claimSpaceIssueWithAttachedTask(body, flags);
    } else if (
      group === 'space' &&
      action === 'issue' &&
      restArgs[0] === 'complete' &&
      shouldFinalizeSpaceIssue(flags)
    ) {
      result = await completeSpaceIssueWithLocalFollowup(body, flags);
    } else {
      result = await callApi(route, body);
    }

    // --run bundled with `task create-from-alignment`: chain immediately
    // into /task/run using the fresh task_id. Saves the caller one round
    // trip and removes the "which id did I just get?" parsing step.
    // Only fires on success and only when the response actually carries
    // a task.id (older backends without the enriched payload fall
    // through without the run — graceful degradation).
    if (
      group === 'task' &&
      action === 'create-from-alignment' &&
      flags.run &&
      result.success &&
      result.data
    ) {
      const data = result.data as Record<string, unknown>;
      const task = (data.task as Record<string, unknown>) ?? data;
      const newTaskId = task?.id as string | undefined;
      if (newTaskId) {
        const runResult = await callApi('task/run', { id: newTaskId });
        if (!runResult.success) {
          // Flag the failure in the top-level result so exit code reflects
          // it, but keep the successful create payload visible so the user
          // can manually `task run <id>` next. Stick the run error in a
          // distinct field to avoid clobbering the create data.
          result.success = false;
          result.error = `created ${newTaskId} but run failed: ${String(runResult.error ?? 'unknown error')}`;
        } else {
          // Bundle the run result alongside create so printTaskCreateResult
          // can show both sections (task_id + docs_path + runtime/model).
          (result.data as Record<string, unknown>).runResult = runResult.data;
        }
      }
    }

    printResult(group, action, result, jsonMode, flags, restArgs);
  }

  // PRD 0.2.18 session send — granular exit codes per --help contract:
  //   0 = delivered, 1 = sessionId not found, 2 = delivery failed/rejected,
  //   3 = arg error (already handled in buildRequestBody).
  // Cross-review CC flagged the generic exit(1) override loses CLI exit contract.
  if (result && !result.success && group === 'session' && (action === 'send' || action === 'watch')) {
    const errorBody = result.error ?? result;
    const code = typeof errorBody === 'object' && errorBody && 'code' in errorBody
      ? (errorBody as { code?: string }).code
      : (result as { code?: string }).code;
    if (code === 'session_not_found') process.exit(1);
    if (code === 'rejected' || code === 'delivery_failed' || code === 'watch_failed') process.exit(2);
    process.exit(1); // fallback
  }

  // Exit with proper code: 0 = success, 1 = business error
  if (result && !result.success) process.exit(1);
}

function groupIsSpaceCommand(group: string | undefined): boolean {
  return group === 'space' || group === 'issue';
}

export function rejectUnsupportedSpaceDryRun(
  positional: string[],
  flags: Record<string, unknown>,
): void {
  if (flags.dryRun !== true || positional[0] !== 'space') return;
  const area = positional[1] ?? '';
  const action = positional[2] ?? '';
  const nested = positional[3] ?? '';
  const issueMutation = area === 'issue' && (
    ['create', 'update', 'comment', 'status', 'claim', 'close', 'complete', 'cancel-claim'].includes(action)
    || (action === 'attachment' && nested === 'add')
  ) && !(action === 'comment' && nested === 'get');
  const otherWrite = (area === 'claim' && action === 'local-task')
    || (area === 'attachment' && ['add', 'download'].includes(action));
  if (!issueMutation && !otherWrite) return;
  const commandLength = area === 'issue' && action === 'attachment' ? 4 : 3;
  const command = positional.slice(0, commandLength).join(' ');

  if (area === 'issue' && action === 'update') {
    requireSpacePositional(
      flags,
      positional[3] ?? flags.issueId,
      'issueId',
      'space issue update',
      'issueId',
    );
    requireSpaceSlug(flags);
  }
  exitSpaceInputError(
    flags,
    'DRY_RUN_UNSUPPORTED',
    `myagents ${command} does not support --dry-run. No changes were applied.`,
    `Read myagents ${command} --help; remove --dry-run only when ready to apply the mutation.`,
  );
}

export function buildRoute(group: string, action: string, rest: string[]): string {
  // `diagnose runtime <type>` sugar maps to `runtime/diagnose` so handlers
  // and admin routes stay singular (issue #194).
  if (group === 'diagnose' && action === 'runtime') {
    return 'diagnose/runtime';
  }
  // Handle nested commands like "agent channel list/add/remove"
  if (group === 'agent' && action === 'channel') {
    const channelAction = rest[0] || 'list';
    return `agent/channel/${channelAction}`;
  }
  // Agent runtime status
  if (group === 'agent' && action === 'runtime-status') {
    return 'agent/runtime-status';
  }
  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke
  if (group === 'mcp' && action === 'oauth') {
    const oauthAction = rest[0] || 'status';
    return `mcp/oauth/${oauthAction}`;
  }
  // Tool readmes: `myagents cron readme`, `myagents im readme`, `myagents widget ...`,
  // `myagents thought readme`. `thought` is included so the AI's natural
  // generalization from cron/im/widget readme doesn't 404 — the server returns
  // a brief "no separate readme" message redirecting back to the prompt brief.
  if (action === 'readme' && (group === 'cron' || group === 'im' || group === 'widget' || group === 'thought')) {
    return `readme/${group}`;
  }
  if (group === 'goal') {
    if (action === 'get' || action === 'list') return 'goal/get';
    if (action === 'create') return 'goal/create';
    if (action === 'update') return 'goal/update';
  }
  // `widget` only exists for readme lookup — any form of invocation
  // (`myagents widget`, `myagents widget chart`, `myagents widget readme chart`)
  // routes to the same handler. The handler parses modules from the payload.
  if (group === 'widget') {
    return 'readme/widget';
  }
  // `task remove` is an alias for `task delete` — the cron CLI uses `remove`
  // for the same operation, so AI / users who generalize the verb hit a real
  // route instead of the previous opaque "Unknown admin route" 404 (issue
  // #205 gap #4). buildRequestBody already treats them as the same shape.
  if (group === 'task' && action === 'remove') {
    return 'task/delete';
  }
  if (group === 'issue') {
    return 'space/issue-get';
  }
  if (group === 'space' && action === 'issue') {
    const issueAction = rest[0] || 'get';
    if (issueAction === 'create') return 'space/issue-create';
    if (issueAction === 'update') return 'space/issue-update';
    if (issueAction === 'list') return 'space/issue-list';
    if (issueAction === 'get' || issueAction === 'view') return 'space/issue-get';
    if (issueAction === 'comments') return 'space/issue-comments';
    if (issueAction === 'comment' && rest[1] === 'get') return 'space/issue-comment-get';
    if (issueAction === 'comment') return 'space/issue-comment';
    if (issueAction === 'status') return 'space/issue-status';
    if (issueAction === 'claim') return 'space/issue-claim';
    if (issueAction === 'attachment' && rest[1] === 'add') return 'space/attachment-add';
    if (issueAction === 'close') return 'space/issue-close';
    if (issueAction === 'complete') return 'space/issue-complete';
    if (issueAction === 'cancel-claim') return 'space/issue-cancel-claim';
  }
  if (group === 'space' && action === 'list') return 'space/list';
  if (group === 'space' && action === 'whoami') return 'space/whoami';
  if (group === 'space' && action === 'goal' && (rest[0] || 'list') === 'list') {
    return 'space/goal-list';
  }
  if (group === 'space' && action === 'assignee' && (rest[0] || 'list') === 'list') {
    return 'space/assignee-list';
  }
  if (group === 'space' && action === 'claim') {
    const claimAction = rest[0] || '';
    if (claimAction === 'local-task') return 'space/claim-local-task';
  }
  if (group === 'space' && action === 'attachment') {
    const attachmentAction = rest[0] || 'download';
    if (attachmentAction === 'download') return 'space/attachment-download';
    if (attachmentAction === 'add') return 'space/attachment-add';
    if (attachmentAction === 'inspect') return 'space/attachment-inspect';
  }
  return `${group}/${action}`;
}

function resolveSpaceWorkspacePath(flags: Record<string, unknown>): string {
  const explicit = typeof flags.workspacePath === 'string'
    ? flags.workspacePath
    : typeof flags.workspace === 'string'
      ? flags.workspace
      : undefined;
  return explicit && explicit.trim() ? explicit : process.cwd();
}

type AgentCliError = {
  code: string;
  error: string;
  suggestion?: string;
  suggestedCommand?: string;
};

function exitAgentCliError(
  flags: Record<string, unknown>,
  error: AgentCliError,
  exitCode = 2,
): never {
  if (flags.json) {
    console.log(JSON.stringify({ success: false, ...error }, null, 2));
  } else {
    console.error(`Error: ${error.error}`);
    if (error.suggestion) console.error(`Suggestion: ${error.suggestion}`);
  }
  process.exit(exitCode);
}

function requireSpaceSlug(flags: Record<string, unknown>): string {
  const value = typeof flags.space === 'string' ? flags.space.trim() : '';
  if (value) return value;
  return exitAgentCliError(flags, {
    code: 'SPACE_REQUIRED',
    error: 'This command requires --space <slug>.',
    suggestion: 'Run `myagents space list --json`, then retry with one returned slug.',
    suggestedCommand: 'myagents space list --json',
  });
}

function requireSpacePositional(
  flags: Record<string, unknown>,
  value: unknown,
  argName: string,
  command: string,
  flagAlternative?: string,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return normalized;
  return exitAgentCliError(flags, {
    code: 'ARGUMENT_REQUIRED',
    error: `${command} requires <${argName}>.`,
    suggestion: `Run \`myagents ${command} --help\` and retry with <${argName}>${flagAlternative ? ` or --${flagAlternative} <${argName}>` : ''}.`,
    suggestedCommand: `myagents ${command} --help`,
  });
}

function optionalSpaceStringFlag(
  flags: Record<string, unknown>,
  value: unknown,
  flagName: string,
  command: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return exitSpaceInputError(
    flags,
    'FLAG_VALUE_REQUIRED',
    `${command} requires --${flagName} <value>.`,
    `Run \`myagents ${command} --help\`, then retry with a non-empty --${flagName} value.`,
  );
}

function optionalSpaceBooleanFlag(
  flags: Record<string, unknown>,
  value: unknown,
  flagName: string,
  command: string,
  invalidCandidate?: unknown,
  allowBare = false,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (invalidCandidate !== undefined) {
    return exitSpaceInputError(
      flags,
      'BOOLEAN_VALUE_INVALID',
      `${command} --${flagName} must be true or false; got "${String(invalidCandidate)}".`,
      `Use --${flagName} true or --${flagName} false.`,
    );
  }
  if (value === true) {
    if (allowBare) return true;
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      `${command} requires --${flagName} <true|false>.`,
      `Use --${flagName} true or --${flagName} false.`,
    );
  }
  if (value === 'true') return true;
  if (value === false || value === 'false') return false;
  return exitSpaceInputError(
    flags,
    'BOOLEAN_VALUE_INVALID',
    `${command} --${flagName} must be true or false; got "${String(value)}".`,
    `Use --${flagName} true or --${flagName} false.`,
  );
}

function exitSpaceInputError(
  flags: Record<string, unknown>,
  code: string,
  error: string,
  suggestion: string,
): never {
  return exitAgentCliError(flags, { code, error, suggestion });
}

function spaceCommandContext(flags: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  return {
    spaceSlug: requireSpaceSlug(flags),
    sessionId: process.env.MYAGENTS_SESSION_ID,
    workspaceId: flags.workspaceId,
    workspacePath,
    agentId: flags.agentId,
  };
}

function spaceAttachmentPaths(flags: Record<string, unknown>): string[] {
  const missingFlag = flags.attachmentValueMissing ? 'attachment' : flags.fileValueMissing ? 'file' : undefined;
  const paths = [
    ...((flags.attachment as string[] | undefined) ?? []),
    ...((flags.file as string[] | undefined) ?? []),
  ];
  if (missingFlag || paths.some(path => typeof path !== 'string' || !path.trim())) {
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      `Space attachment input requires --${missingFlag ?? 'file'} <path>.`,
      'Pass a non-empty workspace file path after every --file or --attachment flag.',
    );
  }
  return paths;
}

function resolveImMediaFilePath(
  flags: Record<string, unknown>,
  positionalPath: string | undefined,
): string {
  const rawFile = flags.file;
  const filePaths = rawFile === undefined
    ? []
    : Array.isArray(rawFile)
      ? rawFile
      : [rawFile];

  if (filePaths.length > 1) {
    return exitAgentCliError(flags, {
      code: 'FILE_COUNT_INVALID',
      error: 'im send-media accepts exactly one --file <path>.',
      suggestion: 'Run `myagents im send-media --help`, then retry with one absolute file path.',
    });
  }

  const filePath = filePaths[0] ?? positionalPath;
  if (
    flags.fileValueMissing
    || typeof filePath !== 'string'
    || !filePath.trim()
  ) {
    return exitAgentCliError(flags, {
      code: 'FILE_REQUIRED',
      error: 'im send-media requires --file <path>.',
      suggestion: 'Run `myagents im send-media --help`, then retry with one absolute file path.',
    });
  }

  return filePath;
}

function optionalNumberFlag(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type GuardedTextFileScope =
  | { kind: 'workspace'; root: string }
  | { kind: 'local'; basePath: string };

function readGuardedTextFile(path: string, scope: GuardedTextFileScope): string {
  const fs = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const MAX_BYTES = 1024 * 1024;
  const basePath = scope.kind === 'workspace' ? scope.root : scope.basePath;
  const baseReal = fs.realpathSync(pathMod.resolve(basePath));
  const requested = pathMod.resolve(baseReal, path);
  const parentReal = fs.realpathSync(pathMod.dirname(requested));
  const target = pathMod.join(parentReal, pathMod.basename(requested));
  const assertInsideWorkspace = (candidate: string) => {
    if (scope.kind !== 'workspace') return;
    const workspaceReal = fs.realpathSync(pathMod.resolve(scope.root));
    const rel = pathMod.relative(workspaceReal, candidate);
    if (rel === '' || rel.startsWith('..') || pathMod.isAbsolute(rel)) {
      throw new Error(`path must stay inside workspace "${scope.root}"`);
    }
  };
  assertInsideWorkspace(target);
  const leaf = fs.lstatSync(target);
  if (leaf.isSymbolicLink()) {
    throw new Error('path must not be a symlink');
  }
  if (!leaf.isFile()) throw new Error('path must be a regular file');

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('path must be a regular file');
    if (scope.kind === 'workspace') {
      const openedReal = fs.realpathSync(target);
      assertInsideWorkspace(openedReal);
    }
    const current = fs.statSync(target);
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error('path changed while it was being opened');
    }

    const bytes = Buffer.allocUnsafe(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} bytes`);
    const body = bytes.subarray(0, offset).toString('utf8');
    if (body.includes('\0')) {
      throw new Error('file contains NUL bytes');
    }
    return body;
  } finally {
    fs.closeSync(fd);
  }
}

export function readWorkspaceTextFile(path: string, workspacePath = process.cwd()): string {
  return readGuardedTextFile(path, { kind: 'workspace', root: workspacePath });
}

function readLocalTextFile(path: string, basePath = process.cwd()): string {
  return readGuardedTextFile(path, { kind: 'local', basePath });
}

function readTextFileFlag(path: string, flagName: string): string {
  try {
    return readLocalTextFile(path);
  } catch (err) {
    console.error(`Error: failed to read --${flagName} "${path}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function resolveCronPromptText(flags: Record<string, unknown>): string | undefined {
  for (const flagName of ['prompt', 'message', 'promptFile'] as const) {
    const value = flags[flagName];
    if (value !== undefined && typeof value !== 'string') {
      const displayName = flagName === 'promptFile' ? 'prompt-file' : flagName;
      console.error(`Error: --${displayName} requires a value.`);
      process.exit(2);
    }
  }

  const prompt = flags.prompt as string | undefined;
  const message = flags.message as string | undefined;
  const promptFile = flags.promptFile as string | undefined;
  if (promptFile !== undefined && (prompt !== undefined || message !== undefined)) {
    console.error('Error: --prompt-file cannot be combined with --prompt or --message.');
    process.exit(2);
  }
  const resolved = promptFile !== undefined
    ? readTextFileFlag(promptFile, 'prompt-file')
    // Preserve the established alias behavior: --prompt wins when both inline
    // spellings are supplied.
    : prompt ?? message;
  if (resolved !== undefined && resolved.trim().length === 0) {
    console.error('Error: cron prompt cannot be empty.');
    process.exit(2);
  }
  return resolved;
}

function resolveSpaceCommentBody(flags: Record<string, unknown>, workspacePath: string): string {
  if (typeof flags.body === 'string') return flags.body;
  if (typeof flags.bodyFile === 'string') {
    try {
      return readWorkspaceTextFile(flags.bodyFile, workspacePath);
    } catch (error) {
      return exitSpaceInputError(
        flags,
        'BODY_FILE_INVALID',
        `Failed to read --body-file "${flags.bodyFile}": ${error instanceof Error ? error.message : String(error)}.`,
        'Choose a regular, non-symlink text file inside the current workspace.',
      );
    }
  }
  if (flags.stdin) {
    try {
      const fs = require('fs') as typeof import('fs');
      return fs.readFileSync(0, 'utf-8');
    } catch (err) {
      return exitSpaceInputError(
        flags,
        'STDIN_READ_FAILED',
        `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}.`,
        'Retry with --body-file <workspace-relative-path>.',
      );
    }
  }
  return '';
}

function truthyCliFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shouldCreateAttachedTaskForClaim(flags: Record<string, unknown>): boolean {
  return truthyCliFlag(flags.createAttached);
}

function hasSpaceCommentBodyFlags(flags: Record<string, unknown>): boolean {
  return flags.body !== undefined || flags.bodyFile !== undefined || truthyCliFlag(flags.stdin);
}

function shouldFinalizeSpaceIssue(flags: Record<string, unknown>): boolean {
  return (
    hasSpaceCommentBodyFlags(flags)
    || spaceAttachmentPaths(flags).length > 0
    || flags.taskId !== undefined
    || flags.localTaskId !== undefined
    || flags.taskStatus !== undefined
  );
}

function requireNonEmptyStringFlag(
  value: unknown,
  flagName: string,
  command: string,
): string {
  assertStringFlag(value, flagName);
  if (typeof value === 'string' && value.trim()) return value.trim();
  console.error(`Error: ${command} requires --${flagName} <value>.`);
  process.exit(2);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractClaimData(data: unknown): Record<string, unknown> {
  const envelope = objectValue(data) ?? {};
  const nested = objectValue(envelope.data);
  return objectValue(envelope.claim) ?? objectValue(nested?.claim) ?? nested ?? envelope;
}

function extractTaskData(data: unknown): Record<string, unknown> {
  const envelope = objectValue(data) ?? {};
  const nested = objectValue(envelope.data);
  return objectValue(envelope.task) ?? objectValue(nested?.task) ?? nested ?? envelope;
}

function parseSpaceCommaTags(flags: Record<string, unknown>, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    return exitSpaceInputError(
      flags,
      'FLAG_VALUE_REQUIRED',
      'space issue claim --create-attached requires --tags <comma-separated-values>.',
      'Pass a comma-separated string after --tags, or omit the flag.',
    );
  }
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function validateSpaceAttachedNotificationFlags(flags: Record<string, unknown>): void {
  const stringFlags = [
    ['notificationBotChannelId', 'notificationBotChannelId'],
    ['notificationBotThread', 'notificationBotThread'],
    ['notificationEvents', 'notificationEvents'],
  ] as const;
  for (const [key, display] of stringFlags) {
    const value = flags[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      exitSpaceInputError(
        flags,
        'FLAG_VALUE_REQUIRED',
        `space issue claim --create-attached requires --${display} <value>.`,
        `Pass a non-empty value after --${display}, or omit the flag.`,
      );
    }
  }
  if (typeof flags.notificationEvents === 'string') {
    const events = flags.notificationEvents.split(',').map(value => value.trim()).filter(Boolean);
    if (events.length === 0) {
      exitSpaceInputError(
        flags,
        'NOTIFICATION_EVENTS_INVALID',
        '--notificationEvents must contain at least one event.',
        'Pass events such as done,blocked,endCondition, or omit the flag.',
      );
    }
  }
}

function buildAttachedTaskBodyForSpaceClaim(
  claimBody: Record<string, unknown>,
  claim: Record<string, unknown>,
  flags: Record<string, unknown>,
  currentSessionId: string,
): Record<string, unknown> {
  const source = (flags.source as string | undefined) ?? 'space-issue';
  if (source !== 'space-issue') {
    return exitSpaceInputError(
      flags,
      'SOURCE_INVALID',
      `space issue claim --create-attached supports only --source "space-issue"; received "${source}".`,
      'Remove --source or set it to "space-issue".',
    );
  }

  const issueId = requireSpacePositional(flags, claimBody.issueId as string | undefined, 'issueId', 'space issue claim');
  const workspaceId = requireSpacePositional(flags, flags.workspaceId as string | undefined, 'workspaceId', 'space issue claim --create-attached');
  const workspacePath = optionalSpaceStringFlag(flags, flags.workspacePath, 'workspacePath', 'space issue claim --create-attached')
    ?? stringValue(claimBody, 'workspacePath')
    ?? process.cwd();
  const taskMdContent = resolveTaskMdContent(
    flags,
    workspacePath,
    (error, exitCode) => exitAgentCliError(flags, error, exitCode),
  );
  if (typeof taskMdContent !== 'string' || !taskMdContent.trim()) {
    return exitSpaceInputError(
      flags,
      'TASK_CONTENT_REQUIRED',
      'space issue claim --create-attached requires task markdown content.',
      'Pass --taskMdFile, --taskMdContentFile, or --taskMdContent.',
    );
  }

  const explicitName = optionalSpaceStringFlag(flags, flags.name, 'name', 'space issue claim --create-attached');
  const executor = optionalSpaceStringFlag(flags, flags.executor, 'executor', 'space issue claim --create-attached') ?? 'agent';
  const description = optionalSpaceStringFlag(flags, flags.description, 'description', 'space issue claim --create-attached');
  const sourceSpaceId = optionalSpaceStringFlag(flags, flags.sourceSpaceId, 'sourceSpaceId', 'space issue claim --create-attached')
    ?? stringValue(claim, 'spaceId');
  const deliveryId = stringValue(claimBody, 'deliveryId')
    ?? optionalSpaceStringFlag(flags, flags.sourceDeliveryId, 'sourceDeliveryId', 'space issue claim --create-attached');
  validateSpaceAttachedNotificationFlags(flags);

  return {
    name: explicitName ?? `Space Issue ${issueId}`,
    executor,
    description,
    workspaceId,
    workspacePath,
    taskMdContent,
    currentSessionId,
    source,
    sourceSpaceId,
    sourceIssueId: issueId,
    sourceClaimId: stringValue(claim, 'id', 'claimId'),
    sourceDeliveryId: deliveryId,
    tags: parseSpaceCommaTags(flags, flags.tags),
    notification: buildNotificationFromFlags(flags),
  };
}

export function buildClaimCancelBody(
  claimBody: Record<string, unknown>,
  claimResult: Record<string, unknown>,
): Record<string, unknown> {
  const cloudData = objectValue(claimResult.data) ?? {};
  const claim = extractClaimData(claimResult.data);
  const origin = stringValue(claim, 'origin') ?? 'self_claim';
  return {
    issueId: claimBody.issueId,
    ...(claimBody.spaceSlug !== undefined ? { spaceSlug: claimBody.spaceSlug } : {}),
    ...(claimBody.sessionId !== undefined ? { sessionId: claimBody.sessionId } : {}),
    ...(claimBody.workspaceId !== undefined ? { workspaceId: claimBody.workspaceId } : {}),
    agentId: claimBody.agentId,
    workspacePath: claimBody.workspacePath,
    rollback: true,
    ...(origin === 'self_claim'
      ? { expectedNotificationVersion: cloudData.notificationVersion }
      : {}),
  };
}

export function buildSpaceCompleteOperationKey(input: {
  issueId: string;
  taskOrSessionId: string;
  resultComment?: string;
  fileContentHashes?: string[];
}): string {
  const crypto = require('crypto') as typeof import('crypto');
  const basis = [
    input.issueId,
    input.taskOrSessionId,
    input.resultComment ?? '',
    ...(input.fileContentHashes ?? []),
  ].join('\0');
  return `desktop-complete-${crypto.createHash('sha256').update(basis).digest('hex')}`;
}

async function cancelClaimAfterAttachedFailure(
  claimBody: Record<string, unknown>,
  claimResult: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return callApi('space/issue-cancel-claim', buildClaimCancelBody(claimBody, claimResult));
}

async function stopAttachedTaskAfterClaimFailure(
  taskId: string,
  message: string,
): Promise<Record<string, unknown>> {
  return callApi('task/update-status', {
    id: taskId,
    status: 'stopped',
    message,
  });
}

function rollbackSuffix(rollback: Record<string, unknown>): string {
  if (rollback.success) return 'The operational cloud claim rollback completed.';
  return `Cloud claim cancellation also failed: ${String(rollback.error ?? 'unknown error')}.`;
}

function failedAttachedClaimResult(
  message: string,
  claimResult: Record<string, unknown>,
  rollback: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: false,
    code: 'ATTACHED_TASK_TRANSACTION_FAILED',
    error: `${message} ${rollbackSuffix(rollback)}`,
    suggestion: rollback.success
      ? 'Inspect the Issue claim and local Task state before retrying; the cloud claim was rolled back.'
      : 'Inspect both the cloud claim and local Task state, then repair the failed rollback before retrying.',
    data: {
      claim: claimResult.data,
      rollback,
      ...extra,
    },
  };
}

async function claimSpaceIssueWithAttachedTask(
  claimBody: Record<string, unknown>,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const currentSessionId =
    typeof flags.currentSessionId === 'string' && flags.currentSessionId.trim()
      ? flags.currentSessionId.trim()
      : process.env.MYAGENTS_SESSION_ID;
  if (!currentSessionId) {
    return exitSpaceInputError(
      flags,
      'SESSION_REQUIRED',
      'space issue claim --create-attached requires an active MyAgents Session.',
      'Run this command inside the MyAgents AI Session that will own the attached Task.',
    );
  }

  const taskBody = buildAttachedTaskBodyForSpaceClaim(claimBody, {}, flags, currentSessionId);

  const claimResult = await callApi('space/issue-claim', claimBody);
  if (!claimResult.success) return claimResult;

  const claim = extractClaimData(claimResult.data);
  const claimId = stringValue(claim, 'id', 'claimId');
  if (!claimId) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      'Issue claim succeeded but the response did not include a claim id.',
      claimResult,
      rollback,
    );
  }

  if (!taskBody.sourceSpaceId) taskBody.sourceSpaceId = stringValue(claim, 'spaceId');
  taskBody.sourceClaimId = claimId;

  const existingTaskId = stringValue(claim, 'localTaskId');
  const existingSessionId = stringValue(claim, 'localSessionId');
  if (existingTaskId && existingSessionId) {
    return {
      success: true,
      data: {
        issueId: claimBody.issueId,
        spaceSlug: claimBody.spaceSlug,
        claim,
        task: { id: existingTaskId },
        localSessionId: existingSessionId,
        reusedExistingLink: true,
      },
      hint: 'Issue assignment already has an attached local Task/Session; reused the existing link.',
    };
  }
  if (existingTaskId || existingSessionId) {
    return {
      success: false,
      code: 'ATTACHED_TASK_LINK_INCOMPLETE',
      error: 'The cloud claim has an incomplete local Task/Session link. Refusing to create a duplicate Task; repair the existing link first.',
      suggestion: 'Inspect the claim and its local Task/Session references, repair the incomplete link, then retry without creating a duplicate Task.',
      data: { issueId: claimBody.issueId, claim },
    };
  }

  const taskResult = await callApi('task/create-attached', taskBody);
  if (!taskResult.success) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      `Issue claim succeeded but attached task creation failed: ${String(taskResult.error ?? 'unknown error')}.`,
      claimResult,
      rollback,
      { taskCreate: taskResult },
    );
  }

  const task = extractTaskData(taskResult.data);
  const taskId = stringValue(task, 'id', 'taskId');
  if (!taskId) {
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    return failedAttachedClaimResult(
      'Issue claim and attached task creation succeeded, but the task response did not include a task id.',
      claimResult,
      rollback,
      { taskCreate: taskResult.data },
    );
  }

  const localTaskResult = await callApi('space/claim-local-task', {
    spaceSlug: claimBody.spaceSlug,
    sessionId: claimBody.sessionId,
    workspaceId: claimBody.workspaceId,
    claimId,
    localTaskId: taskId,
    localSessionId: currentSessionId,
    agentId: claimBody.agentId,
    workspacePath: claimBody.workspacePath,
  });
  const localTaskData = objectValue(localTaskResult.data);
  const localTaskBound = localTaskData?.updated === true
    || (
      stringValue(localTaskData, 'localTaskId') === taskId
      && stringValue(localTaskData, 'localSessionId') === currentSessionId
    );
  if (!localTaskResult.success || !localTaskBound) {
    const taskRollback = await stopAttachedTaskAfterClaimFailure(
      taskId,
      'Space claim local-task binding failed; cloud claim cancelled.',
    );
    const rollback = await cancelClaimAfterAttachedFailure(claimBody, claimResult);
    const linkError = localTaskResult.success
      ? 'cloud response did not confirm the requested local task/session binding'
      : String(localTaskResult.error ?? 'unknown error');
    return failedAttachedClaimResult(
      `Issue claim and attached task creation succeeded, but local-task binding failed: ${linkError}. Local task id: ${taskId}.`,
      claimResult,
      rollback,
      { taskCreate: taskResult.data, taskRollback, localTaskRef: localTaskResult },
    );
  }

  return {
    success: true,
    data: {
      issueId: claimBody.issueId,
      spaceSlug: claimBody.spaceSlug,
      claim,
      taskCreate: taskResult.data,
      task,
      localTaskRef: localTaskResult.data,
      localSessionId: currentSessionId,
    },
    hint: 'Issue claimed and attached task created.',
  };
}

function resolveSpaceCompleteTaskId(flags: Record<string, unknown>): string | undefined {
  if (flags.taskId !== undefined) {
    return requireSpacePositional(flags, flags.taskId as string | undefined, 'taskId', 'space issue complete');
  }
  if (flags.localTaskId !== undefined) {
    return requireSpacePositional(flags, flags.localTaskId as string | undefined, 'localTaskId', 'space issue complete');
  }
  return undefined;
}

async function completeSpaceIssueWithLocalFollowup(
  completeBody: Record<string, unknown>,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const issueId = requireSpacePositional(flags, completeBody.issueId as string | undefined, 'issueId', 'space issue complete');
  const workspacePath = stringValue(completeBody, 'workspacePath') ?? process.cwd();
  const taskId = resolveSpaceCompleteTaskId(flags);
  if (flags.taskStatus !== undefined && !taskId) {
    return exitSpaceInputError(
      flags,
      'TASK_ID_REQUIRED',
      'space issue complete --taskStatus requires --taskId <taskId>.',
      'Pass the attached Task id or omit --taskStatus.',
    );
  }
  const requestedTaskStatus = optionalSpaceStringFlag(flags, flags.taskStatus, 'taskStatus', 'space issue complete');
  if (requestedTaskStatus && requestedTaskStatus !== 'done') {
    return exitSpaceInputError(
      flags,
      'TASK_STATUS_INVALID',
      'space issue complete can only update the local Task to done.',
      'For blocked or stopped work, update the Task separately and cancel the Issue claim.',
    );
  }
  const taskStatus = taskId ? 'done' : undefined;
  const message = optionalSpaceStringFlag(flags, flags.message, 'message', 'space issue complete');

  let resultComment: string | undefined;
  const attachmentPaths = spaceAttachmentPaths(flags);
  if (hasSpaceCommentBodyFlags(flags)) {
    resultComment = resolveSpaceCommentBody(flags, workspacePath);
    if (!resultComment.trim()) {
      if (attachmentPaths.length > 0) {
        resultComment = undefined;
      } else {
        return exitAgentCliError(flags, {
          code: 'COMMENT_CONTENT_REQUIRED',
          error: 'The completion comment body is empty.',
          suggestion: 'Add non-empty --body-file content, add --attachment <path>, or omit comment flags.',
        });
      }
    }
  }

  let existingTaskStatus: string | undefined;
  let taskAlreadyDone = false;
  let taskRead: Record<string, unknown> | undefined;
  if (taskId) {
    taskRead = await callApi('task/get', { id: taskId });
    if (!taskRead.success) {
      return {
        success: false,
        code: 'LOCAL_TASK_READ_FAILED',
        error: `Cannot complete the Space Issue because attached Task ${taskId} could not be read: ${String(taskRead.error ?? 'unknown error')}.`,
        suggestion: `Run \`myagents task get ${shellQuoteArg(taskId)} --json\` to verify the Task id, then retry without changing the cloud Issue.`,
        data: { issueId, taskId, taskRead },
      };
    }
    existingTaskStatus = stringValue(extractTaskData(taskRead.data), 'status');
    taskAlreadyDone = existingTaskStatus === 'done';
    if (!taskAlreadyDone && existingTaskStatus !== 'running' && existingTaskStatus !== 'verifying') {
      return {
        success: false,
        code: 'LOCAL_TASK_STATE_INVALID',
        error: `Cannot complete the Space Issue while attached Task ${taskId} is ${existingTaskStatus ?? 'in an unknown state'}. Move the Task to running or verifying first; the cloud Issue was not changed.`,
        suggestion: `Move Task ${taskId} to running or verifying, then retry this exact Space completion command.`,
        data: { issueId, taskId, taskStatus: existingTaskStatus, taskRead },
      };
    }
  }

  const operationKey = buildSpaceCompleteOperationKey({
    issueId,
    taskOrSessionId: taskId ?? process.env.MYAGENTS_SESSION_ID ?? 'no-local-task',
    resultComment,
  });
  const completeResult = await callApi('space/issue-complete', {
    ...completeBody,
    resultComment,
    operationKey,
    operationKeySubject: taskId ?? process.env.MYAGENTS_SESSION_ID ?? 'no-local-task',
  });
  if (!completeResult.success) {
    return {
      success: false,
      code: stringValue(completeResult, 'code') ?? 'SPACE_ISSUE_COMPLETE_FAILED',
      error: String(completeResult.error ?? 'Issue completion failed'),
      suggestion: stringValue(completeResult, 'suggestion')
        ?? 'Inspect the Issue with `myagents space issue view <issueId> --space <slug> --json`, then retry only after resolving the reported cloud conflict.',
      data: {
        issueId,
        issueComplete: completeResult,
        operationKey,
      },
    };
  }

  let taskResult: Record<string, unknown> | undefined;
  if (taskId && taskStatus && !taskAlreadyDone) {
    taskResult = await callApi('task/update-status', {
      id: taskId,
      status: taskStatus,
      message,
    });
    if (!taskResult.success) {
      const taskAfterFailure = await callApi('task/get', { id: taskId });
      taskAlreadyDone = taskAfterFailure.success === true
        && stringValue(extractTaskData(taskAfterFailure.data), 'status') === 'done';
      if (!taskAlreadyDone) {
        return {
          success: false,
          code: 'LOCAL_TASK_UPDATE_FAILED',
          error: `Issue completed but local task status update failed: ${String(taskResult.error ?? 'unknown error')}.`,
          suggestion: `Rerun the recovery command to finish the local Task transition; the cloud Issue is already complete.`,
          recoveryHint: {
            recoveryCommand: `myagents space issue complete ${shellQuoteArg(issueId)} --space ${shellQuoteArg(String(completeBody.spaceSlug))} --workspacePath ${shellQuoteArg(workspacePath)} --taskId ${shellQuoteArg(taskId)} --message "completed Space issue"`,
            message: 'Cloud Issue is already complete; rerun the Space completion command so it can finish the local Task transition safely.',
          },
          data: {
            issueId,
            issueComplete: completeResult.data,
            taskId,
            taskStatus,
            taskUpdate: taskResult,
            taskAfterFailure,
          },
        };
      }
    }
  }

  return {
    success: true,
    data: {
      issueId,
      issueComplete: completeResult.data,
      operationKey: stringValue(objectValue(completeResult.data), 'operationKey') ?? operationKey,
      taskId,
      taskStatus,
      taskAlreadyDone,
      taskUpdate: taskResult?.data,
    },
    hint: taskId
      ? 'Issue completed. Attached task has already been marked done. Do not call task update-status again.'
      : 'Issue completed.',
    nextAction: taskId ? 'Do not update the attached Task status again.' : undefined,
  };
}

export function buildRequestBody(
  group: string,
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  // Official image understanding tool. Unlike the user-defined CLI tool
  // registry, this is a built-in product capability backed by AppConfig model
  // settings, so it routes directly to the official vision admin handlers.
  if (group === 'vision') {
    if (action === 'readme') return {};
    if (action === 'analyze') {
      const images = [
        ...((flags.image as string[] | undefined) ?? []),
        ...rest,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (flags.promptFile !== undefined && typeof flags.promptFile !== 'string') {
        console.error('Error: --prompt-file must be a file path string.');
        process.exit(2);
      }
      if (typeof flags.prompt === 'string' && typeof flags.promptFile === 'string') {
        console.error('Error: --prompt and --prompt-file are mutually exclusive.');
        process.exit(2);
      }
      const invalidImageValue = images.find(value => value.startsWith('-'));
      if (invalidImageValue) {
        console.error(`Error: --image requires a path value; got "${invalidImageValue}".`);
        process.exit(1);
      }
      const prompt = typeof flags.prompt === 'string' ? flags.prompt : undefined;
      const promptFile = typeof flags.promptFile === 'string' ? flags.promptFile : undefined;
      if (images.length === 0) {
        console.error('Error: vision analyze requires at least one --image <path> (or positional image path).');
        process.exit(1);
      }
      return { images, prompt, promptFile };
    }
    return {};
  }

  if (group === 'goal') {
    if (action === 'get' || action === 'list') return {};
    if (action === 'create') {
      assertStringFlag(flags.objectiveFile, 'objective-file');
      if (flags.objective !== undefined || rest.length > 0) {
        console.error('Error: inline Goal objectives are not accepted; write the objective to a local text file.');
        process.exit(2);
      }
      const objective = typeof flags.objectiveFile === 'string'
        ? readTextFileFlag(flags.objectiveFile, 'objective-file').trim()
        : '';
      if (!objective) {
        console.error('Error: goal create requires --objective-file <local-path>.');
        console.error('  Usage: myagents goal create --objective-file goal-objective.txt');
        process.exit(2);
      }
      const deadline = parseGoalDeadlineFlag(flags.deadline);
      const maxExecutions = parseGoalMaxExecutionsFlag(flags.maxExecutions);
      const aiCanExit = parseGoalAiCanExitFlag(flags.aiCanExit);
      const endConditions = {
        ...(deadline !== undefined ? { deadline } : {}),
        ...(maxExecutions !== undefined ? { maxExecutions } : {}),
        ...(aiCanExit !== undefined ? { aiCanExit } : {}),
      };
      return Object.keys(endConditions).length > 0
        ? { objective, endConditions }
        : { objective };
    }
    if (action === 'update') {
      assertStringFlag(flags.status, 'status');
      assertStringFlag(flags.reasonFile, 'reason-file');
      if (flags.reason !== undefined || rest.length > 0) {
        console.error('Error: inline Goal status/reason values are not accepted; use --status and --reason-file.');
        process.exit(2);
      }
      const status = ((flags.status as string | undefined) ?? '').trim();
      if (status !== 'complete' && status !== 'blocked') {
        console.error('Error: goal update requires --status complete|blocked.');
        console.error('  Usage: myagents goal update --status complete');
        process.exit(2);
      }
      const reason = (
        typeof flags.reasonFile === 'string'
          ? readTextFileFlag(flags.reasonFile, 'reason-file')
          : ''
      ).trim();
      return { status, reason: reason || undefined };
    }
    return {};
  }

  // CLI tool registry commands (PRD 0.2.36)
  if (group === 'tool') {
    if (action === 'add') {
      // `myagents tool add <dir>` — dir is positional; --dir also accepted
      return { dir: rest[0] ?? flags.dir, dryRun: flags.dryRun };
    }
    if (action === 'env') {
      // Same surface as `mcp env`: tool env <name> set|get|delete KEY[=VALUE]...
      const toolName = rest[0];
      const subAction = rest[1] ?? 'get';
      const envPairs = rest.slice(2);
      const envInput = subAction === 'delete'
        ? envPairs.map(k => (k.includes('=') ? k : `${k}=`))
        : envPairs;
      return {
        name: toolName,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : (flags.env as string[] | undefined)),
      };
    }
    if (action === 'remove') {
      return { name: rest[0], purge: flags.purge };
    }
    // list / info / enable / disable / readme — single positional name (or none)
    return rest[0] ? { name: rest[0] } : {};
  }

  if (group === 'space') {
    const workspacePath = resolveSpaceWorkspacePath(flags);
    if (action === 'list') return {};
    const context = spaceCommandContext(flags, workspacePath);
    if (action === 'whoami') return context;
    if (action === 'assignee' && (rest[0] || 'list') === 'list') return context;
    if (action === 'goal' && (rest[0] || 'list') === 'list') {
      return {
        ...context,
        includeArchived: flags.includeArchived === true,
      };
    }
    if (action === 'issue') {
      const issueAction = rest[0] || 'get';
      const issueId = rest[1] || flags.issueId;
      if (issueAction === 'create') {
        const title = requireSpacePositional(
          flags,
          flags.title as string | undefined,
          'title',
          'space issue create',
          'title',
        );
        const body = resolveSpaceCommentBody(flags, workspacePath);
        if (!body.trim()) {
          return exitSpaceInputError(
            flags,
            'ISSUE_BODY_REQUIRED',
            'space issue create requires a non-empty body.',
            'Use --body-file <workspace-relative-path> for reliable multi-line content.',
          );
        }
        const hasGoal = flags.goalId !== undefined || flags.goal !== undefined;
        const goalId = hasGoal
          ? optionalSpaceStringFlag(
              flags,
              flags.goalId ?? flags.goal,
              'goal',
              'space issue create',
            )
          : undefined;
        return {
          ...context,
          title,
          body,
          goalId,
          assigneeId: flags.assignee,
          humanOnly: optionalSpaceBooleanFlag(
            flags,
            flags.humanOnly,
            'human-only',
            'space issue create',
            flags.humanOnlyInvalidValue,
            true,
          ) ?? false,
          filePaths: spaceAttachmentPaths(flags),
        };
      }
      if (issueAction === 'update') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue update',
          'issueId',
        );
        const unsupportedFlag = Object.keys(flags).find(key => ![
          'space',
          'workspacePath',
          'workspace',
          'workspaceId',
          'sessionId',
          'agentId',
          'issueId',
          'title',
          'body',
          'bodyFile',
          'stdin',
          'goal',
          'goalId',
          'clearGoal',
          'humanOnly',
          'humanOnlyInvalidValue',
          'json',
          'help',
          'port',
          'dryRun',
        ].includes(key));
        if (unsupportedFlag) {
          return exitSpaceInputError(
            flags,
            'UPDATE_FIELD_UNSUPPORTED',
            `space issue update does not accept --${unsupportedFlag}.`,
            'Use issue status/claim/comment/attachment commands for non-metadata mutations.',
          );
        }
        const hasGoal = flags.goal !== undefined || flags.goalId !== undefined;
        if (hasGoal && flags.clearGoal === true) {
          return exitSpaceInputError(
            flags,
            'GOAL_SELECTION_CONFLICT',
            'space issue update accepts either --goal <goalId> or --clear-goal, not both.',
            'Keep exactly one Goal operation and retry.',
          );
        }
        const bodySourceCount = [
          flags.body !== undefined,
          flags.bodyFile !== undefined,
          flags.stdin === true,
        ].filter(Boolean).length;
        if (bodySourceCount > 1) {
          return exitSpaceInputError(
            flags,
            'BODY_SOURCE_CONFLICT',
            'space issue update accepts only one of --body, --body-file, or --stdin.',
            'Keep exactly one body source and retry.',
          );
        }

        const title = optionalSpaceStringFlag(
          flags,
          flags.title,
          'title',
          'space issue update',
        );
        const goalId = hasGoal
          ? optionalSpaceStringFlag(
              flags,
              flags.goal ?? flags.goalId,
              'goal',
              'space issue update',
            )
          : undefined;
        if (flags.body !== undefined) {
          optionalSpaceStringFlag(flags, flags.body, 'body', 'space issue update');
        }
        if (flags.bodyFile !== undefined) {
          optionalSpaceStringFlag(flags, flags.bodyFile, 'body-file', 'space issue update');
        }
        const bareFollowerIsIssueId = rest.length === 2
          && flags.humanOnlyInvalidValue === rest[1];
        const humanOnly = optionalSpaceBooleanFlag(
          flags,
          flags.humanOnly,
          'human-only',
          'space issue update',
          bareFollowerIsIssueId ? undefined : flags.humanOnlyInvalidValue,
          true,
        );
        const hasBody = bodySourceCount === 1;
        const body = hasBody ? resolveSpaceCommentBody(flags, workspacePath) : undefined;
        if (hasBody && !body?.trim()) {
          return exitSpaceInputError(
            flags,
            'ISSUE_BODY_REQUIRED',
            'space issue update requires a non-empty body when a body source is provided.',
            'Provide non-empty text through exactly one of --body, --body-file, or --stdin.',
          );
        }
        if (
          title === undefined
          && body === undefined
          && !hasGoal
          && flags.clearGoal !== true
          && humanOnly === undefined
        ) {
          return exitSpaceInputError(
            flags,
            'ISSUE_UPDATE_EMPTY',
            'space issue update requires at least one metadata field.',
            'Run `myagents space issue update --help` and provide title, body, Goal, or human-only metadata.',
          );
        }
        return {
          ...context,
          issueId: requiredIssueId,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(hasGoal ? { goalUpdate: { action: 'set', goalId } } : {}),
          ...(flags.clearGoal === true ? { goalUpdate: { action: 'clear' } } : {}),
          ...(humanOnly !== undefined ? { humanOnly } : {}),
        };
      }
      if (issueAction === 'list') {
        return {
          ...context,
          goalId: flags.goalId ?? flags.goal,
          state: flags.state ?? flags.status,
          includeSubtree: optionalSpaceBooleanFlag(
            flags,
            flags.includeSubtree,
            'include-subtree',
            'space issue list',
          ),
          humanOnly: optionalSpaceBooleanFlag(
            flags,
            flags.humanOnly,
            'human-only',
            'space issue list',
            flags.humanOnlyInvalidValue,
            true,
          ),
          query: flags.query ?? flags.q,
          cursor: flags.cursor,
          limit: optionalNumberFlag(flags.limit),
        };
      }
      if (issueAction === 'comments') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue comments',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          cursor: flags.cursor,
          limit: optionalNumberFlag(flags.limit) ?? 20,
        };
      }
      if (issueAction === 'get' || issueAction === 'view') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          `space issue ${issueAction}`,
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          commentsLimit: optionalNumberFlag(flags.commentsLimit) ?? (flags.comments ? 5 : undefined),
          commentsCursor: flags.commentsCursor ?? flags.cursor,
        };
      }
      if (issueAction === 'comment') {
        if (rest[1] === 'get') {
          const requiredIssueId = requireSpacePositional(
            flags,
            (rest[2] || flags.issueId) as string | undefined,
            'issueId',
            'space issue comment get',
            'issueId',
          );
          const requiredCommentId = requireSpacePositional(
            flags,
            (rest[3] || flags.commentId) as string | undefined,
            'commentId',
            'space issue comment get',
            'commentId',
          );
          return {
            ...context,
            issueId: requiredIssueId,
            commentId: requiredCommentId,
          };
        }
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue comment',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          body: resolveSpaceCommentBody(flags, workspacePath),
          filePaths: spaceAttachmentPaths(flags),
        };
      }
      if (issueAction === 'status') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue status',
          'issueId',
        );
        const state = rest[2] || flags.state || flags.status;
        const requiredState = requireSpacePositional(
          flags,
          state as string | undefined,
          'state',
          'space issue status',
          'state',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          state: requiredState,
        };
      }
      if (issueAction === 'claim') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          'space issue claim',
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          deliveryId: flags.deliveryId,
        };
      }
      if (issueAction === 'attachment' && rest[1] === 'add') {
        const requiredIssueId = requireSpacePositional(
          flags,
          (rest[2] || flags.issueId) as string | undefined,
          'issueId',
          'space issue attachment add',
          'issueId',
        );
        const filePaths = spaceAttachmentPaths(flags);
        if (filePaths.length === 0) {
          return exitSpaceInputError(
            flags,
            'ATTACHMENT_REQUIRED',
            'space issue attachment add requires --file <path>.',
            'Add one or more workspace files with repeated --file flags.',
          );
        }
        return { ...context, issueId: requiredIssueId, filePaths };
      }
      if (issueAction === 'close' || issueAction === 'complete' || issueAction === 'cancel-claim') {
        const requiredIssueId = requireSpacePositional(
          flags,
          issueId as string | undefined,
          'issueId',
          `space issue ${issueAction}`,
          'issueId',
        );
        return {
          ...context,
          issueId: requiredIssueId,
          ...(issueAction === 'cancel-claim'
            ? {
                rollback: truthyCliFlag(flags.rollback),
                expectedNotificationVersion: optionalNumberFlag(flags.expectedNotificationVersion),
              }
            : {}),
          filePaths: issueAction === 'complete'
            ? spaceAttachmentPaths(flags)
            : [],
        };
      }
    }
    if (action === 'claim') {
      const claimAction = rest[0] || '';
      if (claimAction === 'local-task') {
        const claimId = requireSpacePositional(
          flags,
          (rest[1] || flags.claimId) as string | undefined,
          'claimId',
          'space claim local-task',
          'claimId',
        );
        const localTaskId = requireSpacePositional(
          flags,
          flags.localTaskId as string | undefined,
          'localTaskId',
          'space claim local-task',
          'localTaskId',
        );
        const localSessionId = requireSpacePositional(
          flags,
          (flags.localSessionId ?? process.env.MYAGENTS_SESSION_ID) as string | undefined,
          'localSessionId',
          'space claim local-task',
          'localSessionId',
        );
        return {
          ...context,
          claimId,
          localTaskId,
          localSessionId,
        };
      }
    }
    if (action === 'attachment') {
      const attachmentAction = rest[0] || 'download';
      if (attachmentAction === 'download') {
        const attachmentId = requireSpacePositional(
          flags,
          (rest[1] || flags.attachmentId) as string | undefined,
          'attachmentId',
          'space attachment download',
          'attachmentId',
        );
        return {
          ...context,
          attachmentId,
          issueId: flags.issueId,
          output: flags.output,
        };
      }
      if (attachmentAction === 'add' || attachmentAction === 'inspect') {
        const filePaths = spaceAttachmentPaths(flags);
        if (filePaths.length === 0) {
          return exitSpaceInputError(
            flags,
            'ATTACHMENT_REQUIRED',
            `space attachment ${attachmentAction} requires --file <path>.`,
            'Add one or more workspace files with repeated --file flags.',
          );
        }
        return {
          ...context,
          issueId: rest[1] || flags.issueId || '',
          filePaths,
        };
      }
    }
    return {};
  }

  if (group === 'issue') {
    const workspacePath = resolveSpaceWorkspacePath(flags);
    const context = spaceCommandContext(flags, workspacePath);
    if (action === 'comment' || action === 'comments' || action === 'status') {
      return exitSpaceInputError(
        flags,
        'COMMAND_MOVED',
        `myagents issue only reads an Issue; "${action}" is not supported by this alias.`,
        `Use myagents space issue ${action} ... with an explicit --space <slug>.`,
      );
    }
    const positionalIssueId = action === 'list' || action === 'get' ? rest[0] : action;
    const issueId = requireSpacePositional(
      flags,
      (positionalIssueId ?? flags.issueId) as string | undefined,
      'issueId',
      'issue',
      'issueId',
    );
    return {
      ...context,
      issueId,
      commentsLimit: optionalNumberFlag(flags.commentsLimit),
      commentsCursor: flags.commentsCursor ?? flags.cursor,
    };
  }

  // MCP commands
  if (group === 'mcp') {
    if (action === 'add') {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || 'stdio',
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env as string[] | undefined),
          headers: parseEnvFlags(flags.headers as string[] | undefined),
          description: flags.description,
        },
        dryRun: flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === 'show') {
      return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'mcp-id', 'mcp show', 'id') };
    }
    if (action === 'oauth') {
      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke
      const serverId = rest[1] || (flags.id as string);
      if (!serverId) return { id: undefined }; // will trigger missing field error
      if (oauthAction === 'start') {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,
        };
      }
      return { id: serverId };
    }
    if (action === 'env') {
      const serverId = rest[0];
      const subAction = rest[1]; // set | get | delete
      const envPairs = rest.slice(2);
      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags
      const envInput = subAction === 'delete'
        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)
        : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),
      };
    }
    return {};
  }

  // Model commands
  if (group === 'model') {
    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };
    if (action === 'set-default') return { id: rest[0] || flags.id };
    if (action === 'add') {
      // Structure the provider object from flags
      const provider: Record<string, unknown> = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,           // array (repeatable)
        modelNames: flags.modelNames,   // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential,
      };
      // Build aliases from --aliases sonnet=model-id,opus=model-id
      if (typeof flags.aliases === 'string') {
        const aliases: Record<string, string> = {};
        for (const pair of (flags.aliases as string).split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === 'remove') return { id: rest[0] || flags.id };
    return {};
  }

  // Agent commands
  if (group === 'agent') {
    if (action === 'list') {
      if (flags.archived && flags.active) {
        throw new Error('agent list accepts only one lifecycle filter: use --active or --archived, not both.');
      }
      return {
        lifecycle: flags.archived ? 'archived' : flags.active ? 'active' : 'all',
      };
    }
    if (action === 'enable' || action === 'disable' || action === 'archive' || action === 'unarchive') return { id: rest[0] || flags.id };
    if (action === 'show') return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'agent-id', 'agent show', 'id') };
    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === 'channel') {
      const channelAction = rest[0] || 'list'; // list | add | remove
      if (channelAction === 'list') return { agentId: rest[1] || flags.agentId };
      if (channelAction === 'add') return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === 'remove') return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }

  // Runtime discovery commands (v0.1.69+): `myagents runtime list|describe`
  // Pure query endpoints — no body mutation — meant to be consulted BEFORE
  // choosing values for `task create-direct --runtime/--model/...`.
  if (group === 'runtime') {
    if (action === 'list') return {};
    if (action === 'describe') return { runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'runtime describe', 'runtime') };
    if (action === 'diagnose') return {
      runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'runtime diagnose', 'runtime'),
      workspacePath: flags.workspacePath,
    };
    return {};
  }
  // Sugar form: `myagents diagnose runtime <type>` (issue #194).
  if (group === 'diagnose' && action === 'runtime') {
    return {
      runtime: requirePositional(rest[0] ?? (flags.runtime as string | undefined), 'runtime', 'diagnose runtime', 'runtime'),
      workspacePath: flags.workspacePath,
    };
  }

  // Cron commands
  if (group === 'cron') {
    if (action === 'add') {
      return {
        name: flags.name,
        message: resolveCronPromptText(flags),
        workspacePath: flags.workspace,
        schedule: normalizeScheduleFlag(flags.schedule, { fillMissingCronTimezone: true }),
        intervalMinutes: flags.every ? Number(flags.every) : undefined,
        // Forward --dry-run so the admin handler can return a preview
        // instead of writing to the cron store. Issue #149.
        dryRun: flags.dryRun,
      };
    }
    if (action === 'exit') {
      return { reason: flags.reason || rest[0] };
    }
    if (action === 'readme') {
      return {}; // no body
    }
    if (action === 'start' || action === 'stop' || action === 'remove' || action === 'run-now') {
      return { taskId: rest[0] || flags.id };
    }
    if (action === 'update') {
      // Map CLI flags to Rust field names expected by update_task_fields
      const patch: Record<string, unknown> = {};
      if (flags.name !== undefined) patch.name = flags.name;
      const updatePrompt = resolveCronPromptText(flags);
      if (updatePrompt !== undefined) patch.prompt = updatePrompt;
      if (flags.schedule !== undefined) patch.schedule = normalizeScheduleFlag(flags.schedule);
      if (flags.every !== undefined) patch.intervalMinutes = Number(flags.every);
      if (flags.model !== undefined) patch.model = flags.model;
      if (flags.permissionMode !== undefined) patch.permissionMode = flags.permissionMode;
      if (Object.keys(patch).length === 0) {
        console.error('Error: cron update requires at least one update option.');
        process.exit(2);
      }
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === 'runs') {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : undefined };
    }
    if (action === 'list' || action === 'status') {
      return { workspacePath: flags.workspace };
    }
    return {};
  }

  // IM runtime commands — session-scoped, only work inside an IM Bot session
  if (group === 'im') {
    if (action === 'send-media') {
      return {
        filePath: resolveImMediaFilePath(flags, rest[0]),
        caption: flags.caption,
      };
    }
    if (action === 'wake') {
      return { text: flags.text || rest[0] };
    }
    if (action === 'channels') {
      return {};
    }
    if (action === 'readme') {
      return {};
    }
    return {};
  }

  // Generative UI widget readme. Accept any of:
  //   myagents widget                         → action='list',    rest=[]           → modules=[]
  //   myagents widget readme                  → action='readme',  rest=[]           → modules=[]
  //   myagents widget readme chart            → action='readme',  rest=['chart']    → modules=['chart']
  //   myagents widget readme chart interactive → rest=['chart','interactive']       → modules=['chart','interactive']
  //   myagents widget chart                   → action='chart',   rest=[]           → modules=['chart']
  //   myagents widget chart interactive       → action='chart',   rest=['interactive'] → modules=['chart','interactive']
  // Modules = positional args AFTER `widget`, minus any leading `readme`/`list` keyword.
  if (group === 'widget') {
    const candidates = [action, ...rest].filter(Boolean);
    const modules = candidates[0] === 'readme' || candidates[0] === 'list'
      ? candidates.slice(1)
      : candidates;
    return { modules };
  }

  // Plugin commands
  if (group === 'plugin') {
    if (action === 'install') return { npmSpec: rest[0] || flags.npmSpec };
    if (action === 'remove') return { pluginId: rest[0] || flags.pluginId };
    return {};
  }

  // Claude Plugin commands (PRD 0.2.17). Separate group from the OpenClaw
  // channel-plugin `plugin` above — different concept, different storage.
  if (group === 'cc-plugin') {
    if (action === 'install') {
      return {
        sourceUrl: rest[0] || flags.sourceUrl || flags.url,
      };
    }
    if (action === 'uninstall') {
      return {
        // Allow either positional name or full id via flag
        id: flags.id,
        name: rest[0],
        purgeData: !!flags.purgeData,
      };
    }
    if (action === 'enable' || action === 'disable') {
      return { id: flags.id, name: rest[0] };
    }
    if (action === 'show') {
      return { id: rest[0] || flags.id };
    }
    if (action === 'list') {
      return {};
    }
    return {};
  }

  // Skill commands
  if (group === 'skill') {
    if (action === 'add') {
      return {
        url: rest[0] || flags.url,
        scope: (flags.scope as string) || 'user',
        plugin: flags.plugin,
        skill: flags.skill,
        force: !!flags.force,
        dryRun: !!flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'info' || action === 'enable' || action === 'disable') {
      return { name: rest[0] || flags.name, scope: (flags.scope as string) || 'user' };
    }
    if (action === 'list' || action === 'sync') {
      return {};
    }
    return {};
  }

  // Config commands
  if (group === 'config') {
    if (action === 'get') return { key: rest[0] || flags.key };
    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };
    return {};
  }

  // Task Center (v0.1.69) — covers all `myagents task <action>` subcommands.
  //
  // The `actor` / `source` trust fields are NOT settable via the CLI; the
  // admin-api handler derives them from the calling process environment
  // (MYAGENTS_PORT present → agent subprocess; otherwise user terminal).
  if (group === 'task') {
    if (action === 'list') {
      return {
        workspaceId: flags.workspaceId,
        status: flags.status,
        tag: flags.tag,
        includeDeleted: flags.includeDeleted,
      };
    }
    if (action === 'get') return { id: requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task get', 'id') };
    if (action === 'update-status') {
      return {
        id: rest[0],
        status: rest[1],
        message: flags.message,
      };
    }
    if (action === 'append-session') {
      return { id: rest[0], sessionId: rest[1] || flags.sessionId };
    }
    if (action === 'archive') return { id: rest[0], message: flags.message };
    // `remove` is the cron-side vocabulary for the same operation; before this
    // alias the CLI accepted `task remove` and forwarded to a non-existent
    // /api/admin/task/remove route, leaving the user with an opaque "Unknown
    // admin route" error (issue #205 gap #4). Accept both so AI / users who
    // generalized from `cron remove` don't hit a dead end.
    if (action === 'delete' || action === 'remove') return { id: rest[0] };
    if (action === 'create-direct') {
      assertStringFlag(flags.name, 'name');
      // Resolve task.md body: `--taskMdFile` (industry-standard for long
      // text — avoids shell-escape hell for multi-line / backtick / quoted
      // markdown) takes precedence over `--taskMdContent` when both are
      // set. Mirrors the `cron add --prompt-file` pattern above.
      const taskMdContent = resolveTaskMdContent(flags);
      const executionMode = (flags.executionMode as string | undefined) ?? 'once';
      maybeWarnRecurringWithoutInterval(executionMode, flags);
      const cronExpression = typeof flags.cronExpression === 'string' ? flags.cronExpression : undefined;
      const cronTimezone = typeof flags.cronTimezone === 'string'
        ? flags.cronTimezone
        : (executionMode === 'recurring' && cronExpression?.trim() ? resolveLocalTimezone() : undefined);
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        taskMdContent,
        executionMode,
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        // Scheduling-detail fields the Rust TaskCreateDirectInput already
        // accepts. Before issue #205 only the create-from-alignment path
        // (which inherits them from the alignment session) could populate
        // these; the CLI parser dropped them on create-direct, forcing every
        // recurring task to default to 60 min and every cron / dispatchAt
        // schedule to be set via GUI afterward.
        intervalMinutes: parseIntervalMinutesFlag(flags.intervalMinutes),
        cronExpression,
        cronTimezone,
        dispatchAt: parseDispatchAtFlag(flags.dispatchAt),
        notification: buildNotificationFromFlags(flags),
        // Per-task runtime overrides. Admin-api validates these before
        // forwarding to Rust — if the caller mistypes a value, they get a
        // recovery hint pointing to `runtime list` / `runtime describe`.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
        mcpEnabledServers: parseMcpEnabledServersFlag(flags.mcpEnabledServers),
      };
    }
    if (action === 'create-attached') {
      assertStringFlag(flags.name, 'name');
      const currentSessionId =
        typeof flags.currentSessionId === 'string' && flags.currentSessionId.trim()
          ? flags.currentSessionId.trim()
          : process.env.MYAGENTS_SESSION_ID;
      if (!currentSessionId) {
        console.error('Error: task create-attached requires MYAGENTS_SESSION_ID. Run it from inside a MyAgents AI session.');
        process.exit(2);
      }
      const source = (flags.source as string | undefined) ?? 'space-issue';
      if (source !== 'space-issue') {
        console.error(`Error: task create-attached --source currently supports only "space-issue" (got "${source}")`);
        process.exit(2);
      }
      const workspaceId = requireNonEmptyStringFlag(
        flags.workspaceId,
        'workspaceId',
        'task create-attached',
      );
      const workspacePath = requireNonEmptyStringFlag(
        flags.workspacePath,
        'workspacePath',
        'task create-attached',
      );
      const sourceIssueId = requireNonEmptyStringFlag(
        flags.sourceIssueId,
        'sourceIssueId',
        'task create-attached',
      );
      const taskMdContent = resolveTaskMdContent(flags);
      if (typeof taskMdContent !== 'string' || !taskMdContent.trim()) {
        console.error('Error: task create-attached requires --taskMdFile, --taskMdContentFile, or --taskMdContent');
        process.exit(2);
      }
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId,
        workspacePath,
        taskMdContent,
        currentSessionId,
        source,
        sourceSpaceId: flags.sourceSpaceId,
        sourceIssueId,
        sourceClaimId: flags.sourceClaimId,
        sourceDeliveryId: flags.sourceDeliveryId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        notification: buildNotificationFromFlags(flags),
      };
    }
    if (action === 'update') {
      // Patch shape mirrors `create-direct`: the same flag set, but every
      // field is optional. Rust `TaskUpdateInput` treats `None` as
      // "leave unchanged" except for the explicit clear-override flags
      // (`clearProviderOverride` / `clearRuntimeOverride` /
      // `clearMcpOverride`), which the CLI
      // exposes for the AI's "reset to follow Agent" intent.
      const id = requirePositional(rest[0] ?? (flags.id as string | undefined), 'task-id', 'task update', 'id');
      // `--taskMdFile` / `--taskMdContent` map to TaskUpdateInput.prompt
      // (Rust writes the body to task.md atomically under the row's write
      // lock). Reuse the create-side helper so size / NUL / file-not-found
      // errors stay consistent.
      const promptFromTaskMd =
        flags.taskMdFile !== undefined || flags.taskMdContent !== undefined
          ? resolveTaskMdContent(flags)
          : undefined;
      const executionMode = flags.executionMode as string | undefined;
      if (executionMode) maybeWarnRecurringWithoutInterval(executionMode, flags);
      const body: Record<string, unknown> = { id };
      if (flags.name !== undefined) body.name = flags.name;
      if (flags.executor !== undefined) body.executor = flags.executor;
      if (flags.description !== undefined) body.description = flags.description;
      if (executionMode !== undefined) body.executionMode = executionMode;
      if (flags.runMode !== undefined) body.runMode = flags.runMode;
      if (flags.intervalMinutes !== undefined) body.intervalMinutes = parseIntervalMinutesFlag(flags.intervalMinutes);
      if (flags.cronExpression !== undefined) body.cronExpression = flags.cronExpression;
      if (flags.cronTimezone !== undefined) body.cronTimezone = flags.cronTimezone;
      if (flags.dispatchAt !== undefined) body.dispatchAt = parseDispatchAtFlag(flags.dispatchAt);
      if (flags.model !== undefined) body.model = flags.model;
      if (flags.providerId !== undefined) body.providerId = flags.providerId;
      if (flags.clearProviderOverride) body.clearProviderOverride = true;
      if (flags.permissionMode !== undefined) body.permissionMode = flags.permissionMode;
      if (flags.runtime !== undefined) body.runtime = flags.runtime;
      if (flags.runtimeConfig !== undefined) body.runtimeConfig = parseRuntimeConfigFlag(flags.runtimeConfig);
      if (flags.clearRuntimeOverride) body.clearRuntimeOverride = true;
      if (flags.mcpEnabledServers !== undefined) body.mcpEnabledServers = parseMcpEnabledServersFlag(flags.mcpEnabledServers);
      if (flags.clearMcpOverride) body.clearMcpOverride = true;
      if (typeof flags.tags === 'string') {
        body.tags = (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean);
      }
      const notification = buildNotificationFromFlags(flags);
      // CLI merges with existing notification before sending — see the
      // notification-merge block in main() so partial patches like
      // `--notificationDesktop false` don't clobber `botChannelId`.
      if (notification !== undefined) body.notification = notification;
      if (promptFromTaskMd !== undefined) body.prompt = promptFromTaskMd;
      return body;
    }
    if (action === 'create-from-alignment') {
      // First positional MUST be the alignmentSessionId. Use --name for the
      // task title (to avoid ambiguity when the user writes a task name that
      // happens to parse as a sessionId). An empty alignmentSessionId will be
      // rejected by the Rust layer's `validate_safe_id`.
      assertStringFlag(flags.name, 'name');
      return {
        name: flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        alignmentSessionId: flags.alignmentSessionId ?? rest[0],
        executionMode: flags.executionMode ?? 'once',
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        // Identical override contract to create-direct above — keep these two
        // in lockstep.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
        mcpEnabledServers: parseMcpEnabledServersFlag(flags.mcpEnabledServers),
      };
    }
    if (action === 'run' || action === 'rerun') {
      return { id: rest[0] || flags.id };
    }
    return {};
  }

  // Thought (v0.1.69) — `myagents thought <list|create>`
  if (group === 'thought') {
    if (action === 'list') {
      return {
        tag: flags.tag,
        query: flags.query,
        limit: flags.limit ? Number(flags.limit) : undefined,
      };
    }
    if (action === 'create') {
      // Issue #149: on Windows the AI-emitted `myagents thought create '<text>'`
      // sometimes loses the positional argument (root cause not reproducible
      // from macOS — likely a shell-quoting interaction in
      // git-bash → cmd.exe → node argv). The result was a silent
      // `{ content: undefined }` → JSON.stringify drops the field → Rust 422
      // "missing field `content`". Two layers of defense added here:
      //   1. `--content-file <path>` reads the body from a file on disk —
      //      bypasses every shell quoting issue, mirrors `cron add`'s
      //      `--prompt-file` (which exists for the exact same reason).
      //   2. Reject empty content at the CLI boundary with an actionable
      //      error pointing at --content-file, so the AI can self-recover
      //      on retry instead of routing through an opaque server 422.
      let contentText: string | undefined =
        (typeof flags.content === 'string' ? flags.content : undefined) ?? rest.join(' ');
      if (flags.contentFile && typeof flags.contentFile === 'string') {
        try {
          // Lazy-require keeps cold path short for non-thought commands.
          const fs = require('fs') as typeof import('fs');
          const MAX_BYTES = 1024 * 1024; // 1 MB — pathological for a thought
          const stat = fs.statSync(flags.contentFile);
          if (stat.size > MAX_BYTES) {
            console.error(`Error: --content-file "${flags.contentFile}" is ${stat.size} bytes, exceeds ${MAX_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.contentFile, 'utf-8');
          if (raw.includes('\0')) {
            console.error(`Error: --content-file "${flags.contentFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          contentText = raw;
        } catch (err) {
          console.error(`Error: failed to read --content-file "${flags.contentFile}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }
      const trimmed = contentText?.trim() ?? '';
      if (!trimmed) {
        console.error('Error: thought create requires a non-empty content. Pass it as a positional arg, --content "<text>", or --content-file <path>.');
        console.error('  → Tip: shells with quirky quoting (Windows / pwsh) drop quoted args sometimes — write the text to a file and pass --content-file.');
        process.exit(1);
      }
      return { content: trimmed };
    }
    if (action === 'readme') return {}; // graceful no-op surfaced via admin-api
    return {};
  }

  // ===== Session events (PRD 0.2.37) — `myagents session send/watch` =====
  if (group === 'session') {
    if (action === 'send') {
      // Positional: <sessionId>
      // Flags: -p / --prompt | --prompt-file (mutually exclusive), --no-reply
      const toSessionId = requirePositional(
        rest[0] ?? (flags.toSessionId as string | undefined) ?? (flags.to as string | undefined),
        'sessionId',
        'session send',
        'toSessionId',
      );

      // -p (short) is now mapped to --prompt by parseArgs shortFlagAliases.
      let promptText = flags.prompt as string | undefined;
      const MAX_PROMPT_BYTES = 4 * 1024;

      if (flags.promptFile && typeof flags.promptFile === 'string') {
        if (promptText !== undefined) {
          console.error('Error: --prompt-file and -p/--prompt are mutually exclusive');
          process.exit(3);
        }
        try {
          const fs = require('fs') as typeof import('fs');
          const MAX_FILE_BYTES = 1024 * 1024; // 1 MB safety cap (mirror cron add)
          const stat = fs.statSync(flags.promptFile);
          if (stat.size > MAX_FILE_BYTES) {
            console.error(`Error: --prompt-file "${flags.promptFile}" is ${stat.size} bytes, exceeds ${MAX_FILE_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.promptFile, 'utf-8');
          if (raw.includes('\0')) {
            console.error(`Error: --prompt-file "${flags.promptFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          promptText = raw;
        } catch (err) {
          console.error(`Error: failed to read --prompt-file "${flags.promptFile}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      if (!promptText || promptText.length === 0) {
        console.error('Error: session send requires --prompt "<text>" or --prompt-file <path>');
        console.error('  → Tip: see `myagents session send --help` for usage examples');
        process.exit(3);
      }

      // Fail-fast guard: inline -p with newlines or >4KB will be truncated on
      // Windows by cmd.exe (\\n treated as command boundary). Always require
      // --prompt-file for those cases — uniform behavior across platforms,
      // forces good habits. Exit 3 = arg validation error.
      if (!flags.promptFile) {
        if (promptText.includes('\n')) {
          console.error('Error: -p / --prompt content contains newlines (\\n) — Windows cmd.exe truncates flags after \\n,');
          console.error('       which would drop subsequent flags. Write the content to a file and use --prompt-file instead:');
          console.error('         myagents session send <sid> --prompt-file <path>');
          process.exit(3);
        }
        if (promptText.length > MAX_PROMPT_BYTES) {
          console.error(`Error: -p / --prompt content is ${promptText.length} bytes, exceeds ${MAX_PROMPT_BYTES} (4 KB) limit.`);
          console.error('       Write the content to a file and use --prompt-file instead:');
          console.error('         myagents session send <sid> --prompt-file <path>');
          process.exit(3);
        }
      }

      return {
        toSessionId,
        prompt: promptText,
        replyBack: !flags.noReply,
      };
    }
    if (action === 'watch') {
      const targetSessionId = requirePositional(
        rest[0] ?? (flags.targetSessionId as string | undefined) ?? (flags.to as string | undefined),
        'sessionId',
        'session watch',
        'targetSessionId',
      );
      const unsupportedFlag = ['prompt', 'promptFile', 'then', 'thenFile', 'thenPrompt', 'thenPromptFile']
        .find((key) => flags[key] !== undefined);
      if (unsupportedFlag) {
        console.error('Error: session watch does not accept prompt/then flags. Use `myagents session send` to ask the target session to do new work.');
        process.exit(3);
      }
      if (rest.length > 1) {
        console.error('Error: session watch accepts exactly one <sessionId> argument.');
        process.exit(3);
      }
      return { targetSessionId };
    }
    return {};
  }

  return flags;
}

/** Parse KEY=VALUE pairs from --env flags */
function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs || envPairs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip CLI-global flags that should not be persisted into config data */
function stripGlobalFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const globalKeys = new Set(['json', 'dryRun', 'help', 'port', 'workspacePath']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}

/** Try to parse a string as JSON, otherwise return as-is */
function tryParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Normalize `--schedule` into a CronSchedule object.
 *
 * Accepted forms:
 *   - Cron expression string (legacy, most common):
 *       --schedule "*\/30 * * * *"
 *     → { kind: 'cron', expr: "*\/30 * * * *" }
 *
 *   - JSON object matching CronSchedule (the internal wire shape):
 *       --schedule '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
 *       --schedule '{"kind":"every","minutes":30}'
 *       --schedule '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
 *     → parsed object, passed through as-is
 *
 * Fails hard (exit 2) on a malformed JSON-looking input so callers get a
 * clear rejection at the CLI boundary rather than an opaque axum
 * deserialize error three hops away. We detect "looks like JSON" by the
 * leading `{` — a real cron expression never starts with that.
 */
export function normalizeScheduleFlag(
  raw: unknown,
  options: { fillMissingCronTimezone?: boolean; defaultTimezone?: string } = {},
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const defaultTimezone = options.defaultTimezone ?? resolveLocalTimezone();
  const withDefaultCronTimezone = (obj: Record<string, unknown>): Record<string, unknown> => {
    if (!options.fillMissingCronTimezone || obj.kind !== 'cron') return obj;
    const tz = typeof obj.tz === 'string' ? obj.tz.trim() : '';
    return tz ? obj : { ...obj, tz: defaultTimezone };
  };
  if (typeof raw !== 'string') {
    console.error('Error: --schedule must be a cron expression string or a JSON object (e.g. \'{"kind":"at","at":"2026-04-23T09:10:00+08:00"}\')');
    process.exit(2);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: --schedule looks like JSON but failed to parse: ${msg}`);
      console.error('  Expected shapes: {"kind":"at","at":"<ISO>"} | {"kind":"every","minutes":<n>} | {"kind":"cron","expr":"<expr>"[,"tz":"<tz>"]}');
      process.exit(2);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Error: --schedule JSON must be an object with a "kind" field');
      process.exit(2);
    }
    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;
    if (kind === 'loop') {
      console.error('Error: Cron Loop has retired. Use Goal Mode instead:');
      console.error('  myagents goal create --objective-file <path>');
      process.exit(2);
    }
    if (kind !== 'at' && kind !== 'every' && kind !== 'cron') {
      console.error(`Error: --schedule JSON has invalid "kind": ${JSON.stringify(kind)} (expected one of: at, every, cron)`);
      process.exit(2);
    }
    // Per-kind required-field validation so missing fields fail at the CLI
    // boundary with a clear message instead of turning into a cryptic Rust
    // deserialize error "Failed to parse JSON" downstream.
    if (kind === 'at' && typeof obj.at !== 'string') {
      console.error('Error: --schedule {"kind":"at"} requires string field "at" (ISO-8601, e.g. "2026-04-23T09:10:00+08:00")');
      process.exit(2);
    }
    if (kind === 'every') {
      if (typeof obj.minutes !== 'number' || !Number.isFinite(obj.minutes)) {
        console.error('Error: --schedule {"kind":"every"} requires numeric field "minutes" (>= 5)');
        process.exit(2);
      }
      if (!Number.isInteger(obj.minutes) || obj.minutes < 5) {
        // Match Rust's `interval_minutes.max(5)` contract — Rust silently clamps
        // but that's a surprise; reject up front for clarity.
        console.error(`Error: --schedule {"kind":"every"}.minutes must be an integer >= 5 (got ${obj.minutes})`);
        process.exit(2);
      }
      if (obj.startAt !== undefined && typeof obj.startAt !== 'string') {
        console.error('Error: --schedule {"kind":"every"}.startAt must be a string (ISO-8601) when provided');
        process.exit(2);
      }
    }
    if (kind === 'cron') {
      if (typeof obj.expr !== 'string') {
        console.error('Error: --schedule {"kind":"cron"} requires string field "expr" (e.g. "0 9 * * *")');
        process.exit(2);
      }
      if (obj.tz !== undefined && obj.tz !== null && typeof obj.tz !== 'string') {
        console.error('Error: --schedule {"kind":"cron"}.tz must be a string (IANA tz name) when provided');
        process.exit(2);
      }
    }
    return withDefaultCronTimezone(obj);
  }
  // Non-JSON input → treat as a standard cron expression.
  return withDefaultCronTimezone({ kind: 'cron', expr: trimmed });
}

/** Hard cap for `--taskMdContent` (inline string). Mirrors the `--taskMdFile`
 *  1 MB cap so neither ingress path can ship a pathologically large body
 *  through to Rust, where it would bloat `.task/<id>/task.md` without bound. */
const TASK_MD_MAX_BYTES = 1024 * 1024;

/**
 * Resolve `task create-direct --taskMdFile` / `--taskMdContentFile` /
 * `--taskMdContent` into a
 * single `taskMdContent` string.
 *
 * Precedence (both flags set → `--taskMdFile` wins):
 *   1. `--taskMdFile <path>` or `--taskMdContentFile <path>` — read the file (size + NUL guarded).
 *      Chosen as primary because inline markdown on the shell is hostile to
 *      backticks, quotes, and newlines.
 *   2. `--taskMdContent <string>` — raw inline content (size-guarded).
 *
 * Earlier revisions silently joined trailing positional args as a "legacy"
 * fallback — that was undocumented surface area and a fat-fingered positional
 * could silently become task body. Removed after cross-review (v0.1.69).
 */
function resolveTaskMdContent(
  flags: Record<string, unknown>,
  workspacePath?: string,
  structuredExit?: (error: AgentCliError, exitCode: number) => never,
): string | undefined {
  const fail = (error: AgentCliError, exitCode: number): never => {
    if (structuredExit) return structuredExit(error, exitCode);
    console.error(`Error: ${error.error}`);
    if (error.suggestion) console.error(`Suggestion: ${error.suggestion}`);
    process.exit(exitCode);
  };
  const filePath = flags.taskMdFile ?? flags.taskMdContentFile;
  if (filePath !== undefined && filePath !== '') {
    if (typeof filePath !== 'string') {
      return fail({
        code: 'TASK_CONTENT_FILE_INVALID',
        error: '--taskMdFile/--taskMdContentFile requires a file path string.',
        suggestion: 'Pass a regular text file path inside the current workspace.',
      }, 2);
    }
    try {
      if (workspacePath) {
        return readWorkspaceTextFile(filePath, workspacePath);
      }
      // Lazy require — same pattern as the cron `--prompt-file` reader
      // (keeps startup fast for commands that don't need fs).
      const fs = require('fs') as typeof import('fs');
      const stat = fs.statSync(filePath);
      if (stat.size > TASK_MD_MAX_BYTES) {
        return fail({
          code: 'TASK_CONTENT_TOO_LARGE',
          error: `--taskMdFile "${filePath}" is ${stat.size} bytes and exceeds the ${TASK_MD_MAX_BYTES} byte limit.`,
          suggestion: 'Reduce the Task markdown to 1 MB or less, then retry.',
        }, 1);
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.includes('\0')) {
        return fail({
          code: 'TASK_CONTENT_FILE_INVALID',
          error: `--taskMdFile "${filePath}" contains NUL bytes and is not valid Task markdown.`,
          suggestion: 'Choose a UTF-8 text file, then retry.',
        }, 1);
      }
      return raw;
    } catch (err) {
      return fail({
        code: 'TASK_CONTENT_FILE_INVALID',
        error: `Failed to read --taskMdFile "${filePath}": ${err instanceof Error ? err.message : String(err)}.`,
        suggestion: 'Choose a regular, non-symlink text file inside the current workspace.',
      }, 1);
    }
  }
  const contentFlag = flags.taskMdContent;
  if (typeof contentFlag === 'string' && contentFlag !== '') {
    // Byte-length cap — a 1 MB inline arg on the shell is almost always a
    // copy-paste gone wrong, and downstream JSON serialisation / logging
    // would otherwise choke silently.
    const byteLen = Buffer.byteLength(contentFlag, 'utf-8');
    if (byteLen > TASK_MD_MAX_BYTES) {
      return fail({
        code: 'TASK_CONTENT_TOO_LARGE',
        error: `--taskMdContent is ${byteLen} bytes and exceeds the ${TASK_MD_MAX_BYTES} byte limit.`,
        suggestion: 'Reduce the Task markdown to 1 MB or less, then retry.',
      }, 1);
    }
    return contentFlag;
  }
  return undefined;
}

/**
 * Parse the value of `--runtimeConfig` (a JSON object string) into an object.
 *
 * Fails hard (exit 2) on malformed JSON — unlike `tryParseJson` which falls
 * back to the raw string. Reason: silently forwarding a broken string to the
 * server would surface as a cryptic Rust deserialization error 3 hops later.
 * An early, typed rejection with "must be a JSON object" is a much more
 * fixable error for the AI caller.
 */
function parseRuntimeConfigFlag(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --runtimeConfig must be a JSON object string (e.g. --runtimeConfig \'{"model":"o3"}\')');
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: --runtimeConfig is not valid JSON: ${msg}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('Error: --runtimeConfig must be a JSON object (not array, null, or primitive)');
    process.exit(2);
  }
  return parsed as Record<string, unknown>;
}

function parseMcpEnabledServersFlag(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --mcpEnabledServers must be a comma-separated string (e.g. --mcpEnabledServers playwright,im-cron). Use --mcpEnabledServers "" for explicit no MCP.');
    process.exit(2);
  }
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Build a `notification` sub-object from the `--notification*` flags so the
 * Rust `TaskCreateDirectInput.notification` / `TaskUpdateInput.notification`
 * field (`Option<NotificationConfig>`) round-trips cleanly.
 *
 * Returns `undefined` when no notification flag was set — the Rust update
 * path treats `None` as "leave unchanged", and create-direct already defaults
 * to `{ desktop: true }` via serde so omitting it is the right behavior.
 *
 * Flags supported:
 *   --notificationBotChannelId <bot-id>     IM bot id (see `myagents im channels`)
 *   --notificationBotThread <chat-id>       Override bot routing thread / channel
 *   --notificationDesktop true|false        Toggle desktop notification (default true)
 *   --notificationEvents done,blocked,...   Comma-separated event filter
 */
function buildNotificationFromFlags(
  flags: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const channel = flags.notificationBotChannelId;
  const thread = flags.notificationBotThread;
  const desktop = flags.notificationDesktop;
  const events = flags.notificationEvents;
  if (
    channel === undefined
    && thread === undefined
    && desktop === undefined
    && events === undefined
  ) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  if (desktop !== undefined) {
    // Accept `true` / `false` strings (CLI parser leaves un-quoted bools as
    // strings) and any truthy/falsy value; explicit `false` MUST disable.
    if (typeof desktop === 'boolean') {
      out.desktop = desktop;
    } else if (typeof desktop === 'string') {
      const v = desktop.toLowerCase();
      if (v === 'false' || v === '0' || v === 'no' || v === 'off') {
        out.desktop = false;
      } else {
        out.desktop = true;
      }
    } else {
      out.desktop = !!desktop;
    }
  }
  if (channel !== undefined) {
    // Bare `--notificationBotChannelId` (no value) parses as boolean `true`;
    // forwarding `"true"` as a bot id is a near-certain mistake. Require a
    // non-empty string so the AI / user gets a clear error instead of a
    // confused router that says "no such bot 'true'".
    if (typeof channel !== 'string' || channel.length === 0) {
      console.error('Error: --notificationBotChannelId requires a bot id (e.g. --notificationBotChannelId feishu_main). See: myagents im channels');
      process.exit(2);
    }
    out.botChannelId = channel;
  }
  if (thread !== undefined) {
    if (typeof thread !== 'string' || thread.length === 0) {
      console.error('Error: --notificationBotThread requires a non-empty value');
      process.exit(2);
    }
    out.botThread = thread;
  }
  if (events !== undefined) {
    if (typeof events !== 'string') {
      console.error('Error: --notificationEvents must be a comma-separated string (e.g. done,blocked,endCondition)');
      process.exit(2);
    }
    const eventsList = events.split(',').map(s => s.trim()).filter(Boolean);
    if (eventsList.length === 0) {
      // Empty list would silently mean "subscribe to nothing" — almost
      // certainly a typo (`--notificationEvents=,,,` or empty string).
      console.error('Error: --notificationEvents resolved to an empty list. Pass at least one event (e.g. done,blocked,endCondition) or omit the flag to use the default set.');
      process.exit(2);
    }
    out.events = eventsList;
  }
  return out;
}

/**
 * Parse `--dispatchAt` flag into milliseconds since epoch. Accepts either a
 * raw epoch-ms integer (what Rust persists) or an ISO 8601 / RFC 3339 string
 * (what humans type). Bails with a precise error on unparseable input — a
 * silent fall-through would later become a confusing "task never fires"
 * because Rust treats `None` as "no schedule".
 */
export function parseDispatchAtValue(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('Error: --dispatchAt must be a number (epoch ms) or an ISO 8601 timestamp');
  }
  const trimmed = raw.trim();
  // Pure-integer path: epoch-ms (the Rust wire format). `parseInt` would
  // silently chop `"123abc"`; require the whole string to be digits to
  // surface typos.
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new Error(`Error: --dispatchAt "${raw}" must include an explicit timezone offset or Z (e.g. 2026-06-01T09:00:00+08:00). For recurring cron schedules, use --cronTimezone/JSON "tz" instead.`);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`Error: --dispatchAt "${raw}" is not a valid timestamp (try epoch ms or ISO 8601, e.g. 2026-06-01T09:00:00+08:00)`);
  }
  return ms;
}

function parseDispatchAtFlag(raw: unknown): number | undefined {
  try {
    return parseDispatchAtValue(raw);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

/**
 * Recurring tasks with no explicit interval / cron silently default to 60min
 * on the Rust side (`schedule_from_task` falls through to
 * `interval_minutes.unwrap_or(60).max(5)`). Surface this so the AI / user
 * doesn't ship a "let me poll every minute" task that quietly runs hourly.
 * Print to stderr so JSON output stays parseable.
 */
function maybeWarnRecurringWithoutInterval(
  executionMode: string,
  flags: Record<string, unknown>,
): void {
  if (executionMode !== 'recurring') return;
  if (flags.intervalMinutes !== undefined || flags.cronExpression !== undefined) {
    return;
  }
  console.error(
    'Warning: --executionMode recurring without --intervalMinutes or --cronExpression — '
    + 'task will run every 60 minutes (Rust default). Add --intervalMinutes <n> to set the cadence.',
  );
}

/**
 * Parse `--intervalMinutes` into a positive integer. Without this validator
 * `Number("abc")` produces `NaN`, which `JSON.stringify` emits as `null`,
 * which Rust serde drops via `#[serde(default)]` → the task silently falls
 * back to the 60-minute default with no error surfaced to the user.
 * Codex review (issue #205) caught this as a class-of-bug pattern.
 */
function parseIntervalMinutesFlag(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`Error: --intervalMinutes must be a positive integer (got: ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  if (n < 5) {
    // The Rust scheduler clamps to .max(5), so anything lower would silently
    // be ignored. Reject so the user knows their "every 2 min" turned into
    // "every 5 min" before they ship a misconfigured cadence.
    console.error(`Error: --intervalMinutes minimum is 5 (got: ${n}). The scheduler enforces this floor; lower values are silently clamped.`);
    process.exit(2);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  main().catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    if (isSpaceJsonInvocation()) {
      console.log(JSON.stringify({
        success: false,
        code: 'SPACE_CLI_ERROR',
        error: message,
        suggestion: 'Check the command leaf help and retry with explicit, non-empty flag values.',
        suggestedCommand: `myagents ${rawArgs.slice(0, 4).filter(arg => !arg.startsWith('-')).join(' ')} --help`,
      }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  });
}
