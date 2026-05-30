import type { ToolUseSimple } from '@/types/chat';

import { getEffectiveTodoWriteTodos } from '@/utils/todoWriteState';

import TodoChecklist from './TodoChecklist';

interface TodoWriteToolProps {
  tool: ToolUseSimple;
}

// Legacy renderer for the SDK <0.3.142 `TodoWrite` tool. Kept for backward-compatible
// replay of old sessions; new sessions emit Task tools rendered by TaskTodoTool.
export default function TodoWriteTool({ tool }: TodoWriteToolProps) {
  const todos = getEffectiveTodoWriteTodos(tool);

  if (!todos) {
    return <div className="text-sm text-[var(--ink-muted)]">加载待办事项...</div>;
  }

  return <TodoChecklist items={todos} />;
}
