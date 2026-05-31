import { Check, CircleDot, ListTodo, Plus, Search, Trash2 } from 'lucide-react';

import type { TaskCreateInput, TaskGetInput, TaskUpdateInput, ToolUseSimple } from '@/types/chat';

import { getTaskListSnapshot } from '@/utils/taskTodoState';

import TodoChecklist from './TodoChecklist';

interface TaskTodoToolProps {
  tool: ToolUseSimple;
}

// Renderer for the SDK 0.3.142+ incremental Task tools
// (TaskCreate / TaskUpdate / TaskGet / TaskList) that replaced TodoWrite.
//
// The aggregated "current task list" lives in the Agent Status Panel
// (useAgentStatusState accumulates across all messages). Here each tool *call*
// renders only its own operation — except TaskList, whose result already carries
// the full snapshot, so it shows the checklist directly.
export default function TaskTodoTool({ tool }: TaskTodoToolProps) {
  if (tool.name === 'TaskList') {
    const snapshot = getTaskListSnapshot(tool);
    if (!snapshot) {
      return <div className="text-sm text-[var(--ink-muted)]">加载任务列表...</div>;
    }
    if (snapshot.length === 0) {
      return <div className="text-sm text-[var(--ink-muted)]">暂无任务</div>;
    }
    return <TodoChecklist items={snapshot.map(t => ({ content: t.content, status: t.status, key: t.id }))} />;
  }

  return <TaskOpRow tool={tool} />;
}

function TaskOpRow({ tool }: { tool: ToolUseSimple }) {
  const { icon, text, accent } = describeTaskOp(tool);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={accent ? 'text-[var(--accent)]' : 'text-[var(--ink-muted)]'}>{icon}</span>
      <span className="select-text text-[var(--ink-secondary)]">{text}</span>
    </div>
  );
}

function describeTaskOp(tool: ToolUseSimple): { icon: React.ReactNode; text: string; accent: boolean } {
  const iconCls = 'size-4 shrink-0';
  switch (tool.name) {
    case 'TaskCreate': {
      const input = tool.parsedInput as TaskCreateInput | undefined;
      const subject = typeof input?.subject === 'string' ? input.subject : '';
      return { icon: <Plus className={iconCls} />, text: subject ? `创建任务：${subject}` : '创建任务', accent: false };
    }
    case 'TaskUpdate': {
      const input = tool.parsedInput as TaskUpdateInput | undefined;
      const subject = typeof input?.subject === 'string' ? input.subject : '';
      if (input?.status === 'deleted') {
        return { icon: <Trash2 className={iconCls} />, text: subject ? `删除任务：${subject}` : '删除任务', accent: false };
      }
      if (input?.status === 'completed') {
        return { icon: <Check className={iconCls} strokeWidth={3} />, text: subject ? `完成：${subject}` : '完成任务', accent: false };
      }
      if (input?.status === 'in_progress') {
        return { icon: <CircleDot className={iconCls} />, text: subject ? `进行中：${subject}` : '开始任务', accent: true };
      }
      return { icon: <ListTodo className={iconCls} />, text: subject ? `更新任务：${subject}` : '更新任务', accent: false };
    }
    case 'TaskGet': {
      const input = tool.parsedInput as TaskGetInput | undefined;
      const id = typeof input?.taskId === 'string' ? input.taskId : '';
      return { icon: <Search className={iconCls} />, text: id ? `查询任务 #${id}` : '查询任务', accent: false };
    }
    default:
      return { icon: <ListTodo className={iconCls} />, text: tool.name, accent: false };
  }
}
