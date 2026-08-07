import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
  isExternalUrl: (url: string) => /^https?:\/\//i.test(url),
}));

import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import Markdown from './Markdown';

describe('Markdown web links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection);
  });

  it('opens an ordinary click in the Chat-owned BrowserPanel', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <Markdown>[Example](https://example.com)</Markdown>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('keeps Cmd/Ctrl click as an explicit system-browser bypass', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <Markdown>[Example](https://example.com)</Markdown>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }), { ctrlKey: true });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
