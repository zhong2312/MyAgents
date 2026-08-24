import {
  isProjectActiveForUser,
  isProjectVisibleToUser,
  type Project,
} from '@/config/types';
import { orderWorkspaceSelectorProjects } from '@/components/launcher/WorkspaceSelector';

/** Launcher-compatible eligibility and ordering for Bot workspace targeting. */
export function getBotWorkspaceCandidates(
  projects: readonly Project[],
  defaultWorkspacePath?: string,
): Project[] {
  return orderWorkspaceSelectorProjects(
    projects.filter(isProjectVisibleToUser).filter(isProjectActiveForUser),
    defaultWorkspacePath,
  );
}
