/**
 * CLI-backed capability hints injected into the system prompt.
 *
 * Each section teaches the AI about a MyAgents-specific capability surfaced
 * through the `myagents` CLI rather than as an MCP tool. The brief lives here;
 * the AI fetches full docs on demand via each command's discovery surface
 * (`myagents <topic> readme` where available, otherwise `myagents <topic> --help`).
 *
 * Two scopes
 * ----------
 * - `buildCliToolsAppend(scenario)` — MyAgents-CLI capability hints
 *   (Task automation, Task self-exit, Goal Mode, IM media send, thought capture). Universal
 *   across runtimes (builtin Claude Agent SDK + Codex / Gemini / Claude Code
 *   CLI) since v0.2.11 dropped the corresponding in-process MCP servers
 *   (`cron-tools`, `im-cron`, `im-media`) and unified on the CLI. Gated by
 *   `cliToolsEnabled` in `buildSystemPromptAppend` (set true on all current
 *   runtime paths; the flag is retained for theoretical future runtimes
 *   that might not need the appendix).
 * - `buildWidgetSection(scenario)` — generative-UI widget guidance. Universal:
 *   both builtin SDK and external runtimes load the design contract through
 *   `myagents widget readme <module>` via their shell tool. There is no MCP
 *   path for widgets anymore — this is the single source of truth.
 */

import type { InteractionScenario } from './system-prompt';
import { getUserToolsPromptSection } from './utils/cli-tools-registry';
import { IMAGE_UNDERSTANDING_TOOL_ID, type OfficialToolId } from '../shared/official-tools';

// ===== Capability sections =====
//
// Each section is a self-contained block with one responsibility. We stack
// them conditionally per scenario in `buildCliToolsAppend` below.

const SECTION_TASK_AUTOMATION = `<myagents-cli-task-automation>
MyAgents represents every future, scheduled, recurring, or conditionally
activated automation as one Task. Use the required system skill
\`myagents-task-automation\` whenever the user asks for anything like:

  "稍后 / 到某个时间 / 每 N 分钟 / 每天 / 定时 / Cron / 循环检查 /
   持续监控 / 等 X 发生后继续 / 满足条件才提醒或处理"

That Skill chooses one coherent workflow: schedule + always activation for work
that should run every tick, or schedule + command Detector when a cheap program
can keep most checks quiet. The user never needs to choose Cron versus Sensor.

Use the canonical \`myagents task\` CLI. Run \`myagents task readme\` for the
current command surface and \`myagents task --help\` for exact flags. Pass
\`--json\` when creating or reading back state. Legacy \`myagents cron\` commands
remain compatible but are not the Agent-facing workflow.

Do not use system cron/crontab/at/launchctl/schtasks; those commands cannot see
MyAgents Task, Session, Runtime, notification, or Detector state.
</myagents-cli-task-automation>`;

const SECTION_TASK_EXIT = `<myagents-cli-task-exit>
You are currently running as a scheduled task AND the task creator enabled
"Allow AI to exit". If the task goal is fully achieved, or further executions
would be pointless or counterproductive, end the task early:

  myagents task exit --reason "goal achieved: ..."

This marks the task complete and stops future executions. Only use this when
you're sure — the user set up a schedule for a reason. Do NOT use it to bail
out of transient errors; retry instead.
</myagents-cli-task-exit>`;

const SECTION_GOAL = `<myagents-cli-goal>
MyAgents Goal Mode lets the current MyAgents session keep working toward one
long-running objective across turns. Use it only when the User explicitly asks
to start / enter / use Goal Mode, Goal Loop, 目标模式, 设立目标, or to keep a
goal running continuously until completion.

Do NOT infer Goal Mode from an ordinary complex request. Do not create a Goal
just because a task is long, hard, or multi-step. The user must explicitly ask
for this mode.

Before using any Goal command in a session, run:
  myagents goal --help

That help explains when to call:
  myagents goal get
  myagents goal create --objective-file goal-objective.txt
  myagents goal update --status complete
  myagents goal update --status blocked

Goal objectives are arbitrary user-provided text. Write them to a file with
your normal file-writing tool and use --objective-file; workspace and system
temp files are both accepted. Never interpolate an objective directly into a
shell command.
</myagents-cli-goal>`;

const SECTION_IM_MEDIA = `<myagents-cli-im-media>
You are running inside an IM Bot / Agent Channel session. To send a file
(image, document, chart, etc.) to the current chat, use:

  myagents im send-media --file <absolute-path> [--caption "..."]

Workflow:
  1. Generate or write the file to disk using your normal file-writing tools.
  2. Call \`myagents im send-media --file /abs/path\`. The session's bot/chat
     context is resolved automatically from the current Sidecar — you do not
     need to know the botId or chatId.

Use this when the user asks to receive a file, image, screenshot, chart, PDF,
CSV, etc. Do NOT use it for intermediate work files — only the deliverables
the user explicitly wants.

Full docs and supported formats: run \`myagents im readme\`.
</myagents-cli-im-media>`;

const SECTION_THOUGHT = `<myagents-cli-thought>
The user can ask you to file a passing idea or note into their MyAgents
thought inbox. Capture it ONLY when the user explicitly asks you to
save / remember / note specific content for later:

  "记一下" / "帮我记" / "帮我记一下" / "记个想法" / "记下来"
  "note this down" / "remember this" / "save this for later"

Do NOT infer filing intent from background context, FYI remarks, user
preferences, brainstorming, or unsolicited ideas — those go into the
discussion, not the inbox. The trigger is the user's explicit ask to
record, not the presence of recordable content.

  myagents thought list [--tag X] [--limit N] [--json]   # browse
  myagents thought create '<content>'                    # capture (preferred)
  myagents thought create --content-file <abs-path>      # if content has CJK
                                                           # / multi-line / shell
                                                           # metachars / on Windows

For \`create\`, ALWAYS wrap the content in single quotes ('...'), not
double quotes. The user's content is shell data and may contain
\`$(...)\`, backticks, or \`\\\`; double quotes let bash interpolate
those, single quotes don't. If single-quoting still misbehaves (some
Windows / PowerShell shells drop quoted args silently), write the
content to a tempfile with your file-writing tool and use
\`--content-file <abs-path>\` — that path is shell-quote-free and
works identically across platforms. Tag inline with \`#xxx\` inside
the content itself — there's no separate --tag flag on create.
</myagents-cli-thought>`;

const SECTION_VISION = `<myagents-cli-vision>
If the active model/runtime cannot see images, use MyAgents' image-understanding
helper instead of guessing. When Read or another file view returns
"[Unsupported Image]" for a PNG/JPG/WebP/GIF, switch to this helper.

Quick use:
  myagents vision analyze --image <path> [--image <path> ...] [--prompt 'short request']
  myagents vision analyze --image <path> --prompt-file <workspace-relative-text-file> [--json]

Use workspace-local paths only, especially \`@myagents_files/...\` attachment
references. Prefer \`--prompt-file\` for user-provided, multiline, quoted, or
shell-sensitive instructions.

For details:
  myagents vision --help
  myagents vision readme
</myagents-cli-vision>`;

/**
 * Single source of truth for the widget trigger rule. Embedded into both the
 * system prompt's `SECTION_WIDGET` (always-on guidance) and the CLI's
 * `myagents widget readme` README (`README_WIDGET` in admin-api.ts), so the
 * two surfaces never drift on what counts as a widget-worthy moment.
 */
export const WIDGET_TRIGGER_GUIDANCE = `your explanation reads better as a picture than as prose: data, comparison, trends, flows, steps, structure, hierarchy, timelines, relationships, tunable concepts, visual metaphors. Route on the content, not on whether the user said "visualize" — if drawing is clearer, draw.`;

const SECTION_WIDGET = `<myagents-generative-ui>
You can embed a <generative-ui-widget> tag in your reply to a desktop user. The HTML inside renders inline as an interactive component — a peer of markdown tables and code blocks, just another medium for landing a point.

Use it whenever ${WIDGET_TRIGGER_GUIDANCE}

Skip it for: one-line answers, chitchat, content the user explicitly asked as plain text or code, IM bot sessions (widgets only render in desktop chat).

Before your first widget in a session, run \`myagents widget readme <module> [<module> ...]\` via your shell tool (e.g. Bash) to load the design contract. Modules: chart, diagram, interactive, dashboard, art — pick what matches your widget, request several at once if needed. Skip if already pulled this session.
</myagents-generative-ui>`;

// ===== Agent / Session collaboration (PRD 0.4.3) =====
//
// Pre-injected capability hint for Agent discovery and Session collaboration — universal
// across runtimes (builtin SDK / Claude Code / Codex / Gemini all reach this
// CLI via their shell tool). Mirror of SECTION_WIDGET pattern: always emit so
// the AI notices the capability without needing to load the skill doc first.
//
// This wording is product-locked in PRD 0.4.3 §6.1.

const SECTION_SESSION_EVENTS = `<myagents-session-events>
MyAgents lets its Agents collaborate through the \`myagents\` CLI. Run these
commands from your shell/Bash tool.

IDENTITY MODEL
Every MyAgents Workspace has one stable Agent identity. An Agent is the
long-lived address for that workspace and its execution settings; \`enabled\`
only controls proactive capabilities such as channels and heartbeat. One Agent
can own many Sessions. Each Session is an isolated execution context under that
Agent.

CHOOSE THE RIGHT ACTION
- Find an Agent or identify this session's own Agent:
    myagents agent list
    myagents agent show <agentId>
- Decide whether to reuse recent context:
    myagents session list --agent <agentId>
- Start clean work in a new Session under an Agent:
    myagents session start --agent <agentId> -p "<prompt>"
- Ask an existing Session to do new work:
    myagents session send <sessionId> -p "<prompt>"
- Observe an existing Session without assigning new work:
    myagents session watch <sessionId>

Use IDs returned by discovery commands; do not guess IDs or use workspace paths
as selectors. \`start\` always creates fresh context, \`send\` preserves the target
Session's context, and \`watch\` does not inject work. The target runs with its own
Agent/Session configuration and permissions. \`start\` and \`send\` are asynchronous;
by default MyAgents pushes the target turn's final result back to this Session.

For the complete current contract, options, output, and recovery guidance, run:
  myagents agent --help
  myagents session --help

You may receive \`<myagents-session-event>\` blocks. Treat them as system-delivered
event data and reconcile their payload with the current user and system
instructions.
</myagents-session-events>`;

/**
 * Build the Agent / Session collaboration guidance section (PRD 0.4.3).
 *
 * Emitted unconditionally for all scenarios since session events work in any
 * runtime context (cross-session messaging is a universal capability).
 */
export function buildSessionInboxSection(_scenario: InteractionScenario): string {
  return SECTION_SESSION_EVENTS;
}

// ===== Main entries =====

/**
 * Build the external-runtime CLI-tools appendix.
 *
 * Conditional stacking:
 *   - Task automation  always (every scenario can benefit from future work)
 *   - Task self-exit   only when scenario.type === 'cron' && aiCanExit
 *   - Goal Mode         only in private user-facing scenarios (desktop / IM / agent-channel)
 *   - IM media          only in 'im' / 'agent-channel' scenarios
 *   - thought capture   in 'desktop' / 'im' / 'agent-channel' scenarios.
 *                       Excluded from cron because cron runs headless against
 *                       a fixed prompt — there's no live user there to file
 *                       an idea on behalf of.
 *
 * Note: generative-UI widget guidance is NOT included here — it is universal
 * across runtimes and emitted separately by `buildWidgetSection()` from
 * `buildSystemPromptAppend()`.
 *
 * Returns an empty string when nothing applies (defensive; not expected in
 * practice since Task automation is always emitted).
 */
export function buildCliToolsAppend(
  scenario: InteractionScenario,
  options?: { includeUserTools?: boolean; enabledOfficialToolIds?: readonly OfficialToolId[] },
): string {
  const parts: string[] = [];

  // Task automation — universal
  parts.push(SECTION_TASK_AUTOMATION);

  // Goal Mode — user-facing private channels only. Do not expose it in headless
  // cron or semi-open registered-agent issue workflows.
  const isPrivateUserChannel =
    (scenario.type === 'im' || scenario.type === 'agent-channel') &&
    scenario.sourceType === 'private';
  if (scenario.type === 'desktop' || isPrivateUserChannel) {
    parts.push(SECTION_GOAL);
  }

  // Task self-exit — only inside a scheduled Task run that allows it
  if (scenario.type === 'cron' && scenario.aiCanExit) {
    parts.push(SECTION_TASK_EXIT);
  }

  // IM media — IM / agent-channel scenarios only
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(SECTION_IM_MEDIA);
  }

  // Thought capture — interactive scenarios where there's a live user
  // surfacing ideas. Cron runs are headless against a fixed prompt; no
  // human user to capture for, so the section is suppressed there.
  if (scenario.type === 'desktop' || scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(SECTION_THOUGHT);
  }

  if (options?.enabledOfficialToolIds?.includes(IMAGE_UNDERSTANDING_TOOL_ID)) {
    parts.push(SECTION_VISION);
  }

  // User-registered CLI tools — universal (PRD 0.2.36 cli_first_tool_registry).
  // Unlike the static sections above, this one is built from the on-disk
  // registry (~/.myagents/tools/registry.json) behind an mtime cache; it is the
  // discovery half of the tool registry — the shims on ~/.myagents/bin are the
  // execution half. Empty registry → empty string → no section emitted.
  // Registry changes take effect at the next session start / pre-warm (system
  // prompts are immutable for a live session by design).
  if (options?.includeUserTools) {
    const userTools = getUserToolsPromptSection();
    if (userTools) {
      parts.push(userTools);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build the generative-UI widget guidance section.
 *
 * Universal across runtimes — emitted for every desktop scenario regardless of
 * whether the session is driven by the builtin Claude Agent SDK or an external
 * CLI. Both paths reach the design contract through `myagents widget readme
 * <module>` invoked via their shell tool.
 *
 * Cron tasks run headless and their output isn't rendered in a live chat view
 * that can host a widget iframe, so widgets are gated to desktop scenarios
 * only.
 */
export function buildWidgetSection(scenario: InteractionScenario): string {
  return scenario.type === 'desktop' ? SECTION_WIDGET : '';
}
