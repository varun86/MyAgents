import { describe, expect, it, vi } from 'vitest';

import {
  buildCodexFileChangeResultContent,
  buildCodexInitializeParams,
  buildCodexSandboxPolicy,
  buildCodexTurnStartParams,
  CodexRuntime,
  initializeCodexRpc,
  KNOWN_CODEX_SERVER_REQUEST_METHODS,
  mapCodexTurnCompletedNotification,
  mapCodexTurnPlanUpdatedNotification,
  serializeCodexPermissionResponse,
  type PendingCodexRequest,
} from '../runtimes/codex';

describe('Codex app-server protocol helpers', () => {
  it('uses v2 initialize capabilities and sends initialized notification', async () => {
    const rpc = {
      call: vi.fn().mockResolvedValue({}),
      notify: vi.fn(),
    };

    await initializeCodexRpc(rpc, 1234);

    expect(rpc.call).toHaveBeenCalledWith('initialize', buildCodexInitializeParams(), 1234);
    expect(rpc.notify).toHaveBeenCalledWith('initialized');
    expect(buildCodexInitializeParams()).toMatchObject({
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
  });

  it('keeps the known Codex server request allowlist in sync with app-server schema', () => {
    expect(KNOWN_CODEX_SERVER_REQUEST_METHODS).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval',
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'applyPatchApproval',
      'execCommandApproval',
    ]);
  });

  it('passes cwd, approvalPolicy, sandboxPolicy, model, and summary to turn/start', () => {
    expect(buildCodexSandboxPolicy('danger-full-access', '/tmp/ws')).toEqual({ type: 'dangerFullAccess' });
    expect(buildCodexTurnStartParams({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hi' }],
      cwd: '/tmp/ws',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: 'gpt-5.2-codex',
    })).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'hi' }],
      cwd: '/tmp/ws',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'gpt-5.2-codex',
      summary: 'concise',
    });
  });

  // #324 — turn/start.effort: included only when the user picked a non-default
  // level; default/null OMITS the key (conservative shape older codex builds
  // also accept — an explicit null is "no override" per schema but adds noise).
  it('includes effort in turn/start only when set', () => {
    const base = {
      threadId: 'thread-1',
      input: [],
      cwd: '/tmp/ws',
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const,
      model: null,
    };
    expect(buildCodexTurnStartParams({ ...base, reasoningEffort: 'xhigh' }).effort).toBe('xhigh');
    expect('effort' in buildCodexTurnStartParams({ ...base, reasoningEffort: null })).toBe(false);
    expect('effort' in buildCodexTurnStartParams(base)).toBe(false);
  });

  it('records Codex config changes as next-turn process state', async () => {
    const runtime = new CodexRuntime();
    const proc = {
      exited: false,
      model: 'gpt-5.1-codex',
      permissionMode: 'full-auto',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      reasoningEffort: '',
      defaultPermissionMode: 'full-auto',
    } as unknown as import('../runtimes/types').RuntimeProcess;

    await runtime.setModel(proc, 'gpt-5.2-codex');
    await runtime.setPermissionMode(proc, 'no-restrictions');
    await runtime.setReasoningEffort(proc, 'xhigh');

    const state = proc as unknown as {
      model: string;
      permissionMode: string;
      approvalPolicy: 'never';
      sandbox: 'danger-full-access';
      reasoningEffort: string;
    };
    expect(state.model).toBe('gpt-5.2-codex');
    expect(state.permissionMode).toBe('no-restrictions');
    expect(state.approvalPolicy).toBe('never');
    expect(state.sandbox).toBe('danger-full-access');
    expect(buildCodexTurnStartParams({
      threadId: 'thread-1',
      input: [],
      cwd: '/tmp/ws',
      approvalPolicy: state.approvalPolicy,
      sandbox: state.sandbox,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
    })).toMatchObject({
      model: 'gpt-5.2-codex',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      effort: 'xhigh',
    });
  });

  it('preserves Codex turn/completed status instead of treating interrupts as success', () => {
    expect(mapCodexTurnCompletedNotification({ status: 'completed' })).toEqual({
      kind: 'turn_complete',
      status: 'completed',
    });

    expect(mapCodexTurnCompletedNotification({ status: 'interrupted' })).toEqual({
      kind: 'turn_complete',
      status: 'interrupted',
      result: 'Turn ended with status interrupted',
    });

    expect(mapCodexTurnCompletedNotification({
      status: 'failed',
      error: { message: 'websocket failed' },
    })).toEqual({
      kind: 'turn_complete',
      status: 'failed',
      error: 'websocket failed',
      result: 'websocket failed',
    });
  });

  it('maps Codex turn/plan/updated into an AgentStatusPanel todo snapshot', () => {
    expect(mapCodexTurnPlanUpdatedNotification({
      plan: [
        { step: 'Inspect status flow', status: 'completed' },
        { step: 'Wire plan updates', status: 'inProgress' },
        { step: 'Run tests', status: 'pending' },
        { step: '   ', status: 'pending' },
      ],
    })).toEqual({
      kind: 'agent_plan_update',
      todos: [
        {
          key: 'codex-plan-0',
          content: 'Inspect status flow',
          activeForm: 'Inspect status flow',
          status: 'completed',
        },
        {
          key: 'codex-plan-1',
          content: 'Wire plan updates',
          activeForm: 'Wire plan updates',
          status: 'in_progress',
        },
        {
          key: 'codex-plan-2',
          content: 'Run tests',
          activeForm: 'Run tests',
          status: 'pending',
        },
      ],
    });
  });

  it('formats fileChange object kinds without leaking [object Object]', () => {
    expect(buildCodexFileChangeResultContent([
      {
        path: '/tmp/a.md',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-old\n+new',
      },
      {
        path: '/tmp/new.md',
        kind: { type: 'add' },
        diff: 'hello',
      },
    ])).toBe('update: /tmp/a.md\n@@ -1 +1 @@\n-old\n+new\n\nadd: /tmp/new.md\nhello');
    expect(buildCodexFileChangeResultContent([
      {
        path: '/tmp/old.md',
        kind: { type: 'move', move_path: '/tmp/new.md' },
      },
    ])).toBe('move: /tmp/old.md -> /tmp/new.md');
    expect(buildCodexFileChangeResultContent([])).toBe('File changed');
  });

  it('ignores malformed fileChange entries before formatting result text', () => {
    expect(buildCodexFileChangeResultContent([
      null,
      'not-a-change',
      {
        path: '/tmp/old.md',
        kind: { type: 'move', move_path: '/tmp/new.md' },
      },
    ])).toBe('move: /tmp/old.md -> /tmp/new.md');

    expect(buildCodexFileChangeResultContent([null, 'not-a-change'])).toBe('File changed');
  });

  it('serializes command/file approvals with session scope when always allowed', () => {
    const pending: PendingCodexRequest = {
      kind: 'command_approval',
      rpcId: 7,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1' },
    };
    expect(serializeCodexPermissionResponse(pending, 'always_allow')).toEqual({
      type: 'result',
      result: { decision: 'acceptForSession' },
    });
    expect(serializeCodexPermissionResponse(pending, 'deny', undefined, true)).toEqual({
      type: 'result',
      result: { decision: 'cancel' },
    });
  });

  it('serializes Codex tool user input answers by native question id without comma-splitting free text', () => {
    const pending: PendingCodexRequest = {
      kind: 'tool_user_input',
      rpcId: 8,
      method: 'item/tool/requestUserInput',
      params: {
        questions: [
          { id: 'choice', question: 'Pick', options: [] },
          { id: 'notes', question: 'Notes', options: [] },
        ],
      },
    };

    expect(serializeCodexPermissionResponse(pending, 'allow_once', {
      answers: { choice: 'A,B', notes: 'custom text, with comma' },
    })).toEqual({
      type: 'result',
      result: {
        answers: {
          choice: { answers: ['A,B'] },
          notes: { answers: ['custom text, with comma'] },
        },
      },
    });
  });

  it('serializes MCP elicitations and permission profile requests', () => {
    const elicitation: PendingCodexRequest = {
      kind: 'mcp_elicitation',
      rpcId: 9,
      method: 'mcpServer/elicitation/request',
      params: {
        mode: 'form',
        requestedSchema: {
          properties: {
            branch: { type: 'string' },
            publish: { type: 'boolean', default: false },
            optionalNote: { type: 'string' },
          },
          required: ['branch'],
        },
      },
    };
    expect(serializeCodexPermissionResponse(elicitation, 'allow_once', {
      answers: { branch: 'main', publish: 'true' },
    })).toEqual({
      type: 'result',
      result: {
        action: 'accept',
        content: { branch: 'main', publish: true },
        _meta: null,
      },
    });
    expect(serializeCodexPermissionResponse(elicitation, 'allow_once', {
      answers: { publish: 'true' },
    })).toEqual({
      type: 'error',
      code: -32000,
      message: 'Missing required MCP elicitation answers',
    });

    const permissions: PendingCodexRequest = {
      kind: 'permissions_approval',
      rpcId: 10,
      method: 'item/permissions/requestApproval',
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    };
    expect(serializeCodexPermissionResponse(permissions, 'always_allow')).toEqual({
      type: 'result',
      result: {
        permissions: { network: { enabled: true } },
        scope: 'session',
      },
    });
    expect(serializeCodexPermissionResponse(permissions, 'deny')).toMatchObject({
      type: 'error',
      code: -32000,
    });
  });
});
