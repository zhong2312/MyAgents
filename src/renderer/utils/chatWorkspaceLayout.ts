export type WorkspacePanelMode = 'inline' | 'overlay';

export const DEFAULT_WORKSPACE_LAYOUT_METRICS = {
  contentMinWidthPx: 640,
  sidebarMinWidthPx: 320,
} as const;

export interface WorkspacePanelModeInput {
  viewportWidthPx: number;
  splitPanelVisible: boolean;
  splitRatio: number;
  contentMinWidthPx: number;
  sidebarMinWidthPx: number;
}

export function resolveWorkspacePanelMode(input: WorkspacePanelModeInput): WorkspacePanelMode {
  const splitRatio = input.splitPanelVisible
    ? Math.min(Math.max(input.splitRatio, 0), 1)
    : 1;
  const leftPaneWidthPx = input.viewportWidthPx * splitRatio;
  const chatWidthWithInlineWorkspacePx = leftPaneWidthPx - input.sidebarMinWidthPx;
  return chatWidthWithInlineWorkspacePx >= input.contentMinWidthPx ? 'inline' : 'overlay';
}

/** The actively presented Chat-owned browser fills Chat when no split lane exists. */
export function shouldPresentBrowserFullscreen(input: {
  browserPresented: boolean;
  splitViewEnabled: boolean;
  narrowLayout: boolean;
}): boolean {
  return input.browserPresented && (!input.splitViewEnabled || input.narrowLayout);
}

/** Select the surviving split view after the browser resource is destroyed. */
export function nextSplitViewAfterBrowserClose(input: {
  terminalVisible: boolean;
  fileVisible: boolean;
}): 'terminal' | 'file' | null {
  if (input.terminalVisible) return 'terminal';
  if (input.fileVisible) return 'file';
  return null;
}
