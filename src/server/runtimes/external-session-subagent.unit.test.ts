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

  // Cross-review (#0.2.29) regression — a nested sub-agent tool that emits
  // rich-media (e.g. Codex child image_generation) must carry its `attachments`
  // into the persisted snapshot so history replay re-renders the gallery instead
  // of dropping the image. Pre-fix the snapshot subagentCalls had no attachments.
  it('preserves a sub-agent tool call\'s attachments through the persisted snapshot', () => {
    const childId = 'imggen-1::subagent-control::spawn-1';
    const childCall: PersistSubagentCall = {
      id: childId,
      name: 'image_generation',
      input: {},
      inputJson: '',
      result: 'Image generated',
      isLoading: false,
      attachments: [
        { kind: 'image', refPath: '/generated/tool-attachments/s/t/img.png', mimeType: 'image/png' },
      ],
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
      pendingToolInputs: new Map(),
      childToolToParent: new Map([[childId, 'spawn-1']]),
      pendingSubagentCallsByParent: new Map([['spawn-1', [childCall]]]),
      currentAssistantText: '',
    }));

    expect(blocks).toHaveLength(1);
    const subagentCalls = blocks[0].tool?.subagentCalls;
    expect(subagentCalls).toHaveLength(1);
    expect(subagentCalls?.[0].attachments).toEqual([
      { kind: 'image', refPath: '/generated/tool-attachments/s/t/img.png', mimeType: 'image/png' },
    ]);
  });
});
