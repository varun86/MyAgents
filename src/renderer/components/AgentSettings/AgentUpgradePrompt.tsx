// Shown when a workspace is not yet an Agent — explains benefits + upgrade button
import { useCallback, useEffect, useRef } from 'react';
import { HeartPulse } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import type { AgentConfig } from '../../../shared/types/agent';
import { addAgentConfig } from '@/config/services/agentConfigService';

interface AgentUpgradePromptProps {
  projectId: string;
  workspacePath: string;
  onUpgraded?: (agentId: string) => void;
}

export default function AgentUpgradePrompt({ projectId, workspacePath, onUpgraded }: AgentUpgradePromptProps) {
  const { t } = useTranslation('settings');
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleUpgrade = useCallback(async () => {
    try {
      const project = projects.find(p => p.id === projectId);
      const agentConfig: AgentConfig = {
        id: crypto.randomUUID(),
        name: project?.displayName || project?.name || workspacePath.split('/').pop() || 'Agent',
        enabled: true,
        workspacePath,
        providerId: project?.providerId ?? undefined,
        model: project?.model ?? undefined,
        permissionMode: project?.permissionMode || config.defaultPermissionMode || 'plan',
        mcpEnabledServers: project?.mcpEnabledServers,
        channels: [],
      };

      // Persist agent config via TypeScript service (maintains imBotConfigs shim)
      await addAgentConfig(agentConfig);

      // Mark project as agent
      await patchProject(projectId, { isAgent: true, agentId: agentConfig.id });
      await refreshConfig();

      if (isMountedRef.current) onUpgraded?.(agentConfig.id);
    } catch (e) {
      console.error('[AgentUpgradePrompt] Upgrade failed:', e);
    }
  }, [projectId, workspacePath, config, projects, patchProject, refreshConfig, onUpgraded]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      <HeartPulse className="h-10 w-10 text-[var(--heartbeat)]" />
      <h2 className="text-lg font-semibold text-[var(--ink)]">
        {t('agentSettings.upgrade.title')}
      </h2>
      <p className="max-w-md text-center text-sm text-[var(--ink-muted)]">
        {t('agentSettings.upgrade.description')}
      </p>
      <ul className="max-w-md text-sm text-[var(--ink-muted)]">
        <li className="mb-1">• {t('agentSettings.upgrade.benefitShared')}</li>
        <li className="mb-1">• {t('agentSettings.upgrade.benefitOverrides')}</li>
        <li className="mb-1">• {t('agentSettings.upgrade.benefitUnified')}</li>
        <li>• {t('agentSettings.upgrade.benefitRouting')}</li>
      </ul>
      <button
        className="rounded-lg bg-[var(--button-primary-bg)] px-6 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        onClick={handleUpgrade}
      >
        {t('agentSettings.upgrade.action')}
      </button>
    </div>
  );
}
