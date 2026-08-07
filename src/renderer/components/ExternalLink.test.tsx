import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
}));

import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import ExternalLink from './ExternalLink';

describe('ExternalLink primary action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as Selection);
  });

  it('opens HTTP links in the Chat-owned BrowserPanel', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <ExternalLink href="https://example.com">Example</ExternalLink>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('uses the system handler for an explicit Cmd/Ctrl click', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <ExternalLink href="https://example.com">Example</ExternalLink>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }), { metaKey: true });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('falls back to the system handler outside Chat', () => {
    render(<ExternalLink href="https://example.com">Example</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});
