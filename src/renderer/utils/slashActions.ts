// Client-action slash commands
// ----------------------------------------------------------------------------
// Most slash commands either insert text into the input (and get sent to the
// AI, e.g. `/compact`) or are disk-backed skills/commands discovered by the
// Rust scanner. A *client-action* command is different: selecting it triggers
// a renderer-side UI action (e.g. opening the loop/cron panel) and is never
// sent to the AI.
//
// Such a command's behavior lives entirely in the renderer, so it is also
// *defined* and *injected* in the renderer (not registered in the Rust builtin
// list). It is only surfaced when the host wires an `onSlashAction` handler to
// service it — so it can never appear as a dead entry whose action can't run.
// This keeps the command and its action coupled by construction.

import type { SlashCommand } from '../../shared/slashCommands';
import { i18n } from '@/i18n';

/** Built-in slash commands whose selection dispatches a renderer-side action. */
export const CLIENT_ACTION_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'loop', description: 'Run a task continuously (Ralph Loop)', source: 'builtin' },
];

function getClientActionSlashCommands(): SlashCommand[] {
  return CLIENT_ACTION_SLASH_COMMANDS.map((cmd) => ({
    ...cmd,
    description: String(i18n.t(`chat:composer.slashCommands.${cmd.name}`, { defaultValue: cmd.description })),
  }));
}

const CLIENT_ACTION_NAMES = new Set(['loop']);

/** Whether selecting `cmd` should dispatch a client action instead of inserting text. */
export function isClientActionCommand(cmd: SlashCommand): boolean {
  return cmd.source === 'builtin' && CLIENT_ACTION_NAMES.has(cmd.name);
}

/** Reserved command names — a disk-backed skill/command may not shadow these. */
const RESERVED_NAMES = new Set(CLIENT_ACTION_NAMES);

/**
 * Merge client-action commands into a fetched slash-command list.
 *
 * - `enabled` is false (no `onSlashAction` handler) → returns the list
 *   untouched so the command never appears where its action can't run.
 * - Client-action names are **reserved**: the product command preempts any
 *   same-named disk-backed skill/command. Without this, a user skill literally
 *   named `loop` would shadow `/loop` (its `source` is 'skill', so the dispatch
 *   would insert text instead of opening the panel) — a silent failure of a
 *   first-class command, and incoherent with ranking builtins first. Reserving
 *   guarantees `/loop` always resolves to its action.
 */
export function withClientActionCommands(commands: SlashCommand[], enabled: boolean): SlashCommand[] {
  if (!enabled) return commands;
  const kept = commands.filter((c) => !RESERVED_NAMES.has(c.name));
  return [...kept, ...getClientActionSlashCommands()];
}
