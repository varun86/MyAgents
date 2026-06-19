import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { ContentBlock, Message, ToolUseSimple } from '@/types/chat';

import { useAgentStatusState } from './useAgentStatusState';

function toolMsg(id: string, tool: Partial<ToolUseSimple> & { name: string }): Message {
  const block: ContentBlock = {
    type: 'tool_use',
    tool: { id: tool.name + '-' + id, input: {}, streamIndex: 0, ...tool } as ToolUseSimple,
  };
  return { id, role: 'assistant', content: [block], timestamp: new Date(0) };
}

describe('useAgentStatusState — TodoWrite ↔ Task selection', () => {
  it('derives todos from Task tools when present', () => {
    const messages: Message[] = [
      toolMsg('m1', { name: 'TaskCreate', parsedInput: { subject: 'A', description: '' }, result: JSON.stringify({ task: { id: 't1', subject: 'A' } }) }),
      toolMsg('m2', { name: 'TaskUpdate', parsedInput: { taskId: 't1', status: 'completed' } }),
    ];
    const { result } = renderHook(() => useAgentStatusState(messages));
    expect(result.current.todos.map(t => ({ content: t.content, status: t.status }))).toEqual([
      { content: 'A', status: 'completed' },
    ]);
    expect(result.current.summary.todoCompleted).toBe(1);
  });

  it('keeps a legacy TodoWrite list when a Task call yields no tasks (resume across upgrade)', () => {
    // Old turn wrote a TodoWrite list; a new turn emits a lone TaskGet (read-only).
    const messages: Message[] = [
      toolMsg('m1', {
        name: 'TodoWrite',
        parsedInput: { todos: [{ content: '旧任务', status: 'in_progress', activeForm: '做旧任务' }] },
      }),
      toolMsg('m2', { name: 'TaskGet', parsedInput: { taskId: 't1' } }),
    ];
    const { result } = renderHook(() => useAgentStatusState(messages));
    // The TodoWrite list must NOT be blanked out by the empty Task accumulation.
    expect(result.current.todos.map(t => t.content)).toEqual(['旧任务']);
  });
});

describe('useAgentStatusState — Codex CollabAgent activity', () => {
  it('keeps a completed spawnAgent card visible while nested calls are still running', () => {
    const messages: Message[] = [
      toolMsg('m1', {
        name: 'CollabAgent',
        parsedInput: { tool: 'spawnAgent', prompt: 'review analytics', model: 'gpt-5.5' } as unknown as ToolUseSimple['parsedInput'],
        result: 'Tool: spawnAgent\nStatus: completed',
        isLoading: false,
        taskStartTime: 123,
        taskStats: { toolCount: 84, inputTokens: 0, outputTokens: 0 },
        subagentCalls: [
          { id: 'child-1', name: 'Bash', input: { command: 'rg analytics' }, result: '...', isLoading: false },
          { id: 'child-2', name: 'Thinking', input: {}, result: 'still checking', isLoading: true },
        ],
      }),
    ];

    const { result } = renderHook(() => useAgentStatusState(messages));
    expect(result.current.summary.subagentRunning).toBe(1);
    expect(result.current.subagents[0]).toMatchObject({
      id: 'CollabAgent-m1',
      agentType: 'Codex · gpt-5.5',
      description: 'review analytics',
      mode: 'sync',
      startedAt: 123,
      toolCount: 84,
    });
  });
});
