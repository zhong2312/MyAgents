import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { WorkspaceRow } from '@/components/launcher/WorkspaceSelector';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import { getBotWorkspaceCandidates } from './botWorkspaceSelection';

interface BotWorkspacePickerDialogProps {
  projects: readonly Project[];
  defaultWorkspacePath?: string;
  onSelect: (project: Project) => void;
  onClose: () => void;
}

export default function BotWorkspacePickerDialog({
  projects,
  defaultWorkspacePath,
  onSelect,
  onClose,
}: BotWorkspacePickerDialogProps) {
  const { t } = useTranslation('settings');
  const candidates = getBotWorkspaceCandidates(projects, defaultWorkspacePath);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 210);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[210]">
      <div className="w-[min(92vw,26rem)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              {t('agentSettings.botRegistry.selectWorkspaceTitle')}
            </h3>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              {t('agentSettings.botRegistry.selectWorkspaceDescription')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agentSettings.botRegistry.cancel')}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {candidates.map(project => (
            <WorkspaceRow
              key={project.id}
              project={project}
              isDefault={workspacePathsEqual(project.path, defaultWorkspacePath)}
              isSelected={false}
              showDefaultBadge={false}
              onSelect={onSelect}
            />
          ))}
          {candidates.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
              {t('agentSettings.botRegistry.noWorkspaceAvailable')}
            </p>
          )}
        </div>
      </div>
    </OverlayBackdrop>
  );
}
