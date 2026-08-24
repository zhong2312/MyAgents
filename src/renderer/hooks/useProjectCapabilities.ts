import { useCallback, useRef, useState } from 'react';

interface EnabledSkill {
  name: string;
  description: string;
  scope?: 'user' | 'project';
  folderName?: string;
}

interface EnabledCommand {
  name: string;
  invocationName?: string;
  description: string;
  scope?: 'user' | 'project';
  fileName?: string;
}

interface ProjectCapabilitiesResponse {
  success: boolean;
  skills?: Array<{
    name: string;
    description: string;
    scope: 'user' | 'project';
    folderName: string;
    enabled: boolean;
    origin?: 'global' | 'project';
  }>;
  commands?: Array<{
    name: string;
    invocationName?: string;
    description: string;
    scope: 'user' | 'project';
    fileName: string;
    enabled?: boolean;
  }>;
}

type ApiGet = <T>(path: string) => Promise<T>;

/**
 * Renderer projection of the Sidecar-owned effective capability snapshot.
 * Overlapping invalidations are latest-wins so a slow older read cannot
 * restore stale menu/sidebar state after a newer mutation has settled.
 */
export function useProjectCapabilities(apiGet: ApiGet) {
  const [enabledSkills, setEnabledSkills] = useState<EnabledSkill[]>([]);
  const [enabledCommands, setEnabledCommands] = useState<EnabledCommand[]>([]);
  const [globalSkillFolderNames, setGlobalSkillFolderNames] = useState<Set<string>>(new Set());
  const loadRequestIdRef = useRef(0);

  const loadSkillsAndCommands = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    try {
      const response = await apiGet<ProjectCapabilitiesResponse>('/api/project-capabilities');
      if (requestId !== loadRequestIdRef.current || !response.success) return;

      const skills = response.skills ?? [];
      const commands = response.commands ?? [];
      setEnabledSkills(skills.filter(item => item.enabled).map(item => ({
        name: item.name,
        description: item.description,
        scope: item.scope,
        folderName: item.folderName,
      })));
      setEnabledCommands(commands.filter(item => item.enabled !== false).map(item => ({
        name: item.name,
        invocationName: item.invocationName,
        description: item.description,
        scope: item.scope,
        fileName: item.fileName,
      })));
      setGlobalSkillFolderNames(new Set(
        skills.filter(item => item.origin === 'global').map(item => item.folderName),
      ));
    } catch (error) {
      if (requestId === loadRequestIdRef.current) {
        console.error('[Chat] Failed to load skills/commands:', error);
      }
    }
  }, [apiGet]);

  return {
    enabledSkills,
    enabledCommands,
    globalSkillFolderNames,
    loadSkillsAndCommands,
  };
}
