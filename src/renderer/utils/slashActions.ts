// Client-action slash commands
// ----------------------------------------------------------------------------
// Most slash commands either insert text into the input (and get sent to the
// AI (for example builtin SDK `/compact`) or are disk-backed skills/commands discovered by the
// Rust scanner. A *client-action* command is different: selecting it triggers
// a renderer-side UI action (e.g. arming the Goal composer draft) and is never
// sent to the AI.
//
// Such a command's behavior lives entirely in the renderer, so it is also
// *defined* and *injected* in the renderer (not registered in the Rust builtin
// list). It is only surfaced when the host wires an `onSlashAction` handler to
// service it — so it can never appear as a dead entry whose action can't run.
// This keeps the command and its action coupled by construction.

import type { SlashCommand } from '../../shared/slashCommands';
import { i18n } from '@/i18n';

/** Product slash commands whose selection dispatches a renderer-side action. */
export const CLIENT_ACTION_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'goal', description: 'Run toward a goal continuously', source: 'client', aliases: ['loop'] },
];

/** Native Managed Codex action; Chat injects it only for that runtime. */
export const MANAGED_CODEX_COMPACT_SLASH_COMMAND: SlashCommand = {
  name: 'compact',
  description: 'Compress chat history to free context space',
  source: 'client',
};

function getClientActionSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.map((cmd) => ({
    ...cmd,
    description: String(i18n.t(`chat:input.slashCommands.${cmd.name}`, { defaultValue: cmd.description })),
  }));
}

export function resolveClientActionName(
  rawName: string,
  commands: readonly SlashCommand[] = CLIENT_ACTION_SLASH_COMMANDS,
): string | null {
  const name = rawName.trim().replace(/^\/+/, '').toLowerCase();
  for (const command of commands) {
    const commandName = command.name.toLowerCase();
    if (name === commandName) return commandName;
    if (command.aliases?.some(alias => alias.toLowerCase() === name)) return commandName;
  }
  return null;
}

/** Whether selecting `cmd` should dispatch a client action instead of inserting text. */
export function isClientActionCommand(cmd: SlashCommand): boolean {
  return cmd.source === 'client';
}

/**
 * Merge client-action commands into a fetched slash-command list.
 *
 * - `enabled` is false (no `onSlashAction` handler) → returns the list
 *   untouched so the command never appears where its action can't run.
 * - Client-action names are **reserved**: the product command preempts any
 *   same-named disk-backed skill/command. Without this, a user skill literally
 *   named `goal` would shadow `/goal` (its `source` is 'skill', so the dispatch
 *   would insert text instead of opening the panel) — a silent failure of a
 *   first-class command, and incoherent with ranking builtins first. Reserving
 *   guarantees `/goal` and its `/loop` alias always resolve to their action.
 */
export function withClientActionCommands(
  commands: SlashCommand[],
  enabled: boolean,
  additionalCommands: readonly SlashCommand[] = [],
): SlashCommand[] {
  if (!enabled) return commands;
  const clientCommands = [...CLIENT_ACTION_SLASH_COMMANDS, ...additionalCommands];
  const reservedNames = new Set(clientCommands.flatMap(command => [command.name, ...(command.aliases ?? [])]));
  const kept = commands.filter((c) => !reservedNames.has(c.name));
  return [...kept, ...getClientActionSlashCommands(clientCommands)];
}
