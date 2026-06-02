import { describe, it, expect } from 'vitest';
import {
  shouldBlockToolInPlanMode,
  planModeDenyMessage,
  PLAN_MODE_READONLY_TOOLS,
  PLAN_MODE_HOST_INTERACTION_TOOLS,
} from './plan-mode-gate';

describe('shouldBlockToolInPlanMode (#295 plan-mode hard gate)', () => {
  it('never blocks outside plan mode', () => {
    for (const mode of ['auto', 'fullAgency', 'custom', 'default', 'acceptEdits', 'bypassPermissions']) {
      expect(shouldBlockToolInPlanMode('Bash', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('Edit', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('mcp__whatever__do', mode)).toBe(false);
    }
  });

  it('blocks write / side-effecting tools in plan mode (the #295 regression)', () => {
    // The exact tools from the bug report plus the common write/exec surface.
    for (const tool of [
      'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'Task', 'WebFetch', 'WebSearch', 'Skill',
      'mcp__gemini-image__generate', 'mcp__playwright__click',
    ]) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(true);
    }
  });

  it('allows the read-only inspection tools in plan mode', () => {
    for (const tool of PLAN_MODE_READONLY_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('never blocks control-transfer tools — they must reach the host for approval', () => {
    for (const tool of PLAN_MODE_HOST_INTERACTION_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('is case-sensitive / exact-match (an unknown tool is blocked, fail-closed)', () => {
    expect(shouldBlockToolInPlanMode('read', 'plan')).toBe(true); // not 'Read'
    expect(shouldBlockToolInPlanMode('SomeFutureTool', 'plan')).toBe(true);
  });

  it('readonly and control-transfer sets do not overlap with each other', () => {
    const overlap = (PLAN_MODE_READONLY_TOOLS as readonly string[]).filter(t =>
      (PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });
});

describe('planModeDenyMessage', () => {
  it('names the blocked tool and points the model at ExitPlanMode', () => {
    const msg = planModeDenyMessage('Bash');
    expect(msg).toContain('Bash');
    expect(msg).toContain('ExitPlanMode');
    expect(msg).toContain('Plan');
  });
});
