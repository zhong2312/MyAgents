import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchPill } from './SearchPill';

describe('SearchPill compact interaction', () => {
  it('uses a real icon button that focuses and expands the search input', () => {
    const inputRef = createRef<HTMLInputElement>();
    const onFocus = vi.fn();

    render(
      <SearchPill
        inputRef={inputRef}
        value=""
        onChange={vi.fn()}
        placeholder="搜索任务"
        collapseWhenNarrow
        onFocus={onFocus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '搜索任务' }));

    expect(inputRef.current).toHaveFocus();
    expect(onFocus).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '搜索任务' })).not.toBeInTheDocument();
  });
});
