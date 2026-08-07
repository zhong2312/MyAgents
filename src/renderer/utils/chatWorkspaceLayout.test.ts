import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_LAYOUT_METRICS,
  nextSplitViewAfterBrowserClose,
  resolveWorkspacePanelMode,
  shouldPresentBrowserFullscreen,
} from './chatWorkspaceLayout';

const baseInput = {
  ...DEFAULT_WORKSPACE_LAYOUT_METRICS,
  splitPanelVisible: false,
  splitRatio: 0.5,
};

describe('resolveWorkspacePanelMode', () => {
  it('keeps the workspace tree inline when the remaining chat width reaches the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 960,
    })).toBe('inline');
  });

  it('uses the overlay drawer when inline workspace would squeeze chat below the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 959,
    })).toBe('overlay');
  });

  it('includes the active split ratio when a split preview is open', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.5,
    })).toBe('inline');

    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.49,
    })).toBe('overlay');
  });

  it('ignores split ratio when the split preview is closed', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1200,
      splitPanelVisible: false,
      splitRatio: 0.2,
    })).toBe('inline');
  });
});

describe('shouldPresentBrowserFullscreen', () => {
  it('keeps an open browser split only when split view has enough room', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: true,
      narrowLayout: false,
    })).toBe(false);
  });

  it('uses fullscreen for an open browser when the layout is narrow or split view is disabled', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: true,
      narrowLayout: true,
    })).toBe(true);
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: false,
      narrowLayout: false,
    })).toBe(true);
  });

  it('does not claim fullscreen when a browser resource exists behind another active view', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: false,
      splitViewEnabled: false,
      narrowLayout: true,
    })).toBe(false);
  });
});

describe('nextSplitViewAfterBrowserClose', () => {
  it('hands fullscreen browser close to the surviving terminal before the file view', () => {
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: true,
      fileVisible: true,
    })).toBe('terminal');
  });

  it('falls back to a file view and returns null when no split resource survives', () => {
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: false,
      fileVisible: true,
    })).toBe('file');
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: false,
      fileVisible: false,
    })).toBeNull();
  });
});
