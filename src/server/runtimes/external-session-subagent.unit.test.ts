import { describe, expect, it } from 'vitest';

import {
  buildExternalAssistantSnapshotContent,
  type PersistContentBlock,
  type PersistSubagentCall,
} from './external-session';

function parseSnapshot(content: string | null): PersistContentBlock[] {
  expect(content).toBeTruthy();
  return JSON.parse(content!) as PersistContentBlock[];
}

describe('external-session sub-agent live snapshot', () => {
  it('nests pending child tools under a pending spawn parent instead of flattening them', () => {
    const childId = 'wait-1::subagent-control::spawn-1';
    const childCall: PersistSubagentCall = {
      id: childId,
      name: 'CollabAgent',
      input: { tool: 'wait' },
      inputJson: '{"tool":"wait"}',
      isLoading: true,
    };

    const blocks = parseSnapshot(buildExternalAssistantSnapshotContent({
      contentBlocks: [],
      pendingTextBuffer: '',
      pendingThinkingBlock: null,
      pendingToolInputs: new Map([
        ['spawn-1', { name: 'CollabAgent', inputJson: '{"tool":"spawnAgent"}' }],
        [childId, { name: 'CollabAgent', inputJson: '{"tool":"wait"}' }],
      ]),
      childToolToParent: new Map([[childId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.id).toBe('spawn-1');
    expect(blocks[0].tool?.subagentCalls).toEqual([childCall]);
  });

  it('attaches pending child message traces to an already persisted spawn parent', () => {
    const messageTraceId = 'AgentMessage::child-thread::message-1::spawn-1';
    const childCall: PersistSubagentCall = {
      id: messageTraceId,
      name: 'AgentMessage',
      input: {},
      inputJson: '',
      result: 'child output',
      isLoading: true,
    };

    const blocks = parseSnapshot(buildExternalAssistantSnapshotContent({
      contentBlocks: [{
        type: 'tool_use',
        tool: {
          id: 'spawn-1',
          name: 'CollabAgent',
          input: { tool: 'spawnAgent' },
          inputJson: '{"tool":"spawnAgent"}',
          isLoading: true,
          streamIndex: 0,
        },
      }],
      pendingTextBuffer: '',
      pendingThinkingBlock: null,
      pendingToolInputs: new Map([[messageTraceId, { name: 'AgentMessage', inputJson: '' }]]),
      childToolToParent: new Map([[messageTraceId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.id).toBe('spawn-1');
    expect(blocks[0].tool?.subagentCalls).toEqual([childCall]);
    expect(blocks.some((block) => block.tool?.id === messageTraceId)).toBe(false);
  });
});
