import type { SubagentToolCall, ToolUseSimple } from '@/types/chat';

/**
 * Tools that render as an expandable sub-agent container (a card holding a nested
 * `subagentCalls` trace). Single source of truth for builtin Task/Agent and
 * Codex CollabAgent spawn cards.
 */
export function isSubagentContainerTool(name: string): boolean {
  return name === 'Task' || name === 'Agent' || name === 'CollabAgent';
}

export function isSubagentCallRunning(call: Pick<SubagentToolCall, 'isLoading'>): boolean {
  return call.isLoading === true;
}

export function hasRunningSubagentCall(tool: Pick<ToolUseSimple, 'subagentCalls'>): boolean {
  return tool.subagentCalls?.some(isSubagentCallRunning) === true;
}

/**
 * A container is active while either the parent tool itself is still executing
 * or a nested sub-agent trace entry is still streaming. This distinction matters
 * for Codex: `spawnAgent` completes as soon as the child thread is created, but
 * the child thread can keep producing nested tools for minutes afterward.
 */
export function isSubagentContainerRunning(tool: Pick<ToolUseSimple, 'name' | 'isLoading' | 'result' | 'subagentCalls'> | null | undefined): boolean {
  if (!tool || !isSubagentContainerTool(tool.name)) return false;
  return (tool.isLoading === true && !tool.result) || hasRunningSubagentCall(tool);
}
