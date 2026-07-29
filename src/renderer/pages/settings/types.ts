import type { CapabilityInitialSelect } from '../../../shared/skillsTypes';
import type { OfficialToolId } from '../../../shared/official-tools';
import type { SubscriptionStatusWithVerify } from '@/types/subscription';

export type SubscriptionStatus = SubscriptionStatusWithVerify;

export interface NetworkProbeResult {
  ok: boolean;
  stage: string;
  kind: string;
  message: string;
  detail?: string;
  httpStatus?: number;
  url: string;
}

export type ProxyProbeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; message: string; detail?: string }
  | { status: 'error'; message: string; detail?: string; stage?: string; kind?: string };

export interface ProviderVerifyError {
  error: string;
  detail?: string;
  action?: 'proxy-settings';
}

export interface SettingsProps {
  mode?: 'settings' | 'capabilities';
  initialSection?: string;
  navigationNonce?: number;
  initialMcpId?: string;
  initialOfficialToolId?: OfficialToolId;
  initialSelect?: CapabilityInitialSelect;
  onSectionChange?: () => void;
  isActive?: boolean;
  updateReady?: boolean;
  updateVersion?: string | null;
  updateChecking?: boolean;
  updateDownloading?: boolean;
  updateInstalling?: boolean;
  updatePreparing?: boolean;
  onCheckForUpdate?: () => Promise<'up-to-date' | 'downloading' | 'error'>;
  onRestartAndUpdate?: () => void;
}
