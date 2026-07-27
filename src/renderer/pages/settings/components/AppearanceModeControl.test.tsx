import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppearanceModeControl } from './AppearanceModeControl';

describe('AppearanceModeControl', () => {
  it('renders appearance terminology and emits all three global appearance modes', () => {
    const onChange = vi.fn();
    render(<AppearanceModeControl value="system" onChange={onChange} />);

    expect(screen.getByText('外观模式')).toBeInTheDocument();
    const system = screen.getByRole('button', { name: '跟随系统' });
    const light = screen.getByRole('button', { name: '日间模式' });
    const dark = screen.getByRole('button', { name: '夜间模式' });
    expect(system).toHaveAttribute('aria-pressed', 'true');
    expect(light).toHaveAttribute('aria-pressed', 'false');
    expect(dark).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(system);
    fireEvent.click(light);
    fireEvent.click(dark);
    expect(onChange.mock.calls).toEqual([['system'], ['light'], ['dark']]);
  });
});
