// Agent heartbeat section — wraps HeartbeatConfigCard
import { useCallback } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { HeartbeatConfig } from '../../../../shared/types/im';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import HeartbeatConfigCard from '../../ImSettings/components/HeartbeatConfigCard';

interface AgentHeartbeatSectionProps {
  agent: AgentConfig;
  workspacePath: string;
  onAgentChanged: () => void;
}

export default function AgentHeartbeatSection({ agent, workspacePath, onAgentChanged }: AgentHeartbeatSectionProps) {
  const handleChange = useCallback(async (heartbeat: HeartbeatConfig | undefined) => {
    await patchAgentConfig(agent.id, { heartbeat });
    onAgentChanged();
  }, [agent.id, onAgentChanged]);

  return (
    <HeartbeatConfigCard heartbeat={agent.heartbeat} onChange={handleChange} flat workspacePath={workspacePath} />
  );
}
