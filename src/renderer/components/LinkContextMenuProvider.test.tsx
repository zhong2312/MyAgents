import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_EVENTS } from '../../shared/constants';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  copyPlainText: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  isExternalUrl: (url: string) => /^(?:https?:\/\/|mailto:)/i.test(url),
  openExternal: mocks.openExternal,
}));

vi.mock('@/utils/clipboard', () => ({
  copyPlainText: mocks.copyPlainText,
}));

vi.mock('./Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import LinkContextMenuProvider from './LinkContextMenuProvider';

describe('LinkContextMenuProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copyPlainText.mockResolvedValue(undefined);
  });

  it('dispatches HTTP preview through the active Chat browser owner', () => {
    const onOpen = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, onOpen);
    render(
      <LinkContextMenuProvider>
        <a href="https://example.com">Example</a>
      </LinkContextMenuProvider>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Example' }));
    fireEvent.click(screen.getByRole('button', { name: '预览（内置浏览器）' }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    window.removeEventListener(CUSTOM_EVENTS.OPEN_IN_BROWSER_PANEL, onOpen);
  });

  it('does not offer an internal browser preview for mail links', () => {
    render(
      <LinkContextMenuProvider>
        <a href="mailto:test@example.com">Email</a>
      </LinkContextMenuProvider>,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Email' }));

    expect(screen.queryByRole('button', { name: '预览（内置浏览器）' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在系统浏览器中打开' })).toBeInTheDocument();
  });
});
