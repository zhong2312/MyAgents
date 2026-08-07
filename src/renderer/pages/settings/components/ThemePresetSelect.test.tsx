import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { themeRegistry } from '@/theme';

import { ThemePresetSelect } from './ThemePresetSelect';

describe('ThemePresetSelect', () => {
  it('renders every accepted Theme in one flat list and persists only the selected Theme ID', async () => {
    const onPersistTheme = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemePresetSelect
        value="default-black"
        onPersistTheme={onPersistTheme}
        onPersistError={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /MyAgents Classic2/ });
    fireEvent.click(trigger);
    const defaultBlackOption = screen.getAllByRole('button', { name: 'MyAgents Classic2' })
      .find(candidate => candidate !== trigger);
    expect(defaultBlackOption).toBeDefined();
    expect(screen.getByRole('button', { name: 'MyAgents Light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MyAgents Classic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Absolutely' })).not.toBeInTheDocument();
    expect(screen.queryByText('基准')).not.toBeInTheDocument();
    expect(screen.queryByText('社区 · PR #441')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(themeRegistry.getProductionIds().length + 1);

    const swatchGroup = defaultBlackOption?.querySelector('span[aria-hidden="true"]');
    expect(swatchGroup).not.toBeNull();
    expect(swatchGroup?.children).toHaveLength(2);
    expect(swatchGroup?.children[0]).toHaveStyle({ backgroundColor: '#111111' });
    const label = within(defaultBlackOption!).getByText('MyAgents Classic2');
    const indicator = defaultBlackOption?.querySelector('[data-selected-indicator]');
    expect(indicator).not.toBeNull();
    expect(label.compareDocumentPosition(indicator!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(indicator!.compareDocumentPosition(swatchGroup!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Raycast' }));
    });
    expect(onPersistTheme).toHaveBeenCalledWith('raycast');
  });

  it('does not display an optimistic value and reports persistence failures', async () => {
    const failure = new Error('disk unavailable');
    const onPersistError = vi.fn();
    render(
      <ThemePresetSelect
        value="myagents-default"
        onPersistTheme={vi.fn().mockRejectedValue(failure)}
        onPersistError={onPersistError}
      />,
    );

    const trigger = screen.getByRole('button', { name: /MyAgents Classic/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Linear' }));

    expect(trigger).toHaveTextContent('MyAgents Classic');
    await waitFor(() => expect(onPersistError).toHaveBeenCalledWith(failure));
    expect(trigger).toHaveTextContent('MyAgents Classic');
  });
});
