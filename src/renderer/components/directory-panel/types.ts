import type React from 'react';

import type { Provider } from '@/config/types';
import type { FilePreviewFocusTarget } from '@/types/filePreview';
import type {
  DirectoryTree,
  DirectoryTreeNode,
} from '../../../shared/dir-types';
import type { RichDocKind } from '../../../shared/fileTypes';
import type { CapabilityInitialSelect } from '../../../shared/skillsTypes';
import type { FileSearchHit } from '@/api/searchClient';

export interface DirectoryPanelHandle {
  handleFileDrop: (
    paths: string[],
    position?: { x: number; y: number },
  ) => Promise<void>;
  refresh: () => void;
}

export interface WorkspaceTreePersistedState {
  openPaths: Set<string>;
  directoryInfo: DirectoryTree | null;
}

export interface DirectoryPanelProps {
  agentDir: string;
  projectIcon?: string;
  projectDisplayName?: string;
  currentSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  provider?: Provider | null;
  providers?: Provider[];
  onProviderChange?: (providerId: string, targetModel?: string) => void;
  onCollapse?: () => void;
  onOpenConfig?: () => void;
  refreshTrigger?: number;
  persistedTreeStateRef?: React.MutableRefObject<WorkspaceTreePersistedState>;
  onRefreshAll?: () => void;
  isTauriDragActive?: boolean;
  onInsertReference?: (paths: string[]) => void;
  onQuoteFile?: (path: string) => void;
  onQuoteSelection?: (path: string, startLine: number, endLine: number) => void;
  externalRevealRequest?: { id: number; path: string } | null;
  onExternalRevealHandled?: (id: number) => void;
  enabledAgents?: Record<
    string,
    {
      description: string;
      prompt?: string;
      model?: string;
      scope?: 'user' | 'project';
      folderName?: string;
    }
  >;
  enabledSkills?: Array<{
    name: string;
    description: string;
    scope?: 'user' | 'project';
    folderName?: string;
  }>;
  enabledCommands?: Array<{
    name: string;
    description: string;
    scope?: 'user' | 'project';
    fileName?: string;
  }>;
  globalSkillFolderNames?: Set<string>;
  onInsertSlashCommand?: (command: string) => void;
  onOpenSettings?: (initialSelect?: CapabilityInitialSelect) => void;
  onSyncSkillToGlobal?: (folderName: string) => void;
  onFilePreviewExternal?: (
    file: {
      name: string;
      content: string;
      size: number;
      path: string;
      richDocKind?: RichDocKind;
      initialLineNumber?: number;
      focusTarget?: FilePreviewFocusTarget;
    },
    options?: { initialEditMode?: boolean },
  ) => void;
  onOpenTerminal?: () => void;
  terminalAlive?: boolean;
  onOpenBrowser?: () => void;
}

export type FilePreview = {
  name: string;
  content: string;
  size: number;
  path: string;
  richDocKind?: RichDocKind;
  initialLineNumber?: number;
  focusTarget?: FilePreviewFocusTarget;
  initialEditMode?: boolean;
};

export type ContextMenuState = {
  x: number;
  y: number;
  node: DirectoryTreeNode | null;
  isMultiSelect?: boolean;
} | null;

export type SearchResultContextMenuState = {
  x: number;
  y: number;
  hit: FileSearchHit;
} | null;

export type DialogState = {
  type: 'delete' | 'delete-multi';
  node: DirectoryTreeNode | null;
  nodes?: DirectoryTreeNode[];
} | null;

export type TreeClipboard = {
  mode: 'copy' | 'cut';
  paths: string[];
} | null;
