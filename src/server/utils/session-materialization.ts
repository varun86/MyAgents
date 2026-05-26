import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeType } from '../../shared/types/runtime';
import { createSessionMetadata, type SessionMetadata } from '../types/session';
import { snapshotForImSession, snapshotForOwnedSession } from './session-snapshot';

export type SessionMaterializationScenario = 'desktop' | 'cron' | 'im' | 'agent-channel';

export function isLiveFollowScenario(scenario: SessionMaterializationScenario): boolean {
  return scenario === 'im' || scenario === 'agent-channel';
}

export function snapshotForMaterializedSession(
  agent: AgentConfig,
  scenario: SessionMaterializationScenario,
): Partial<SessionMetadata> {
  return isLiveFollowScenario(scenario)
    ? snapshotForImSession(agent)
    : snapshotForOwnedSession(agent);
}

export function createMaterializedSessionMetadata(params: {
  agentDir: string;
  sessionId: string;
  scenario: SessionMaterializationScenario;
  agent?: AgentConfig;
  fallbackRuntime?: RuntimeType;
  title?: string;
}): SessionMetadata {
  const snapshot = params.agent
    ? snapshotForMaterializedSession(params.agent, params.scenario)
    : undefined;
  const meta = createSessionMetadata(params.agentDir, snapshot);
  if (!params.agent && params.fallbackRuntime) {
    meta.runtime = params.fallbackRuntime;
  }
  meta.id = params.sessionId;
  meta.title = params.title ?? 'New Chat';
  return meta;
}
