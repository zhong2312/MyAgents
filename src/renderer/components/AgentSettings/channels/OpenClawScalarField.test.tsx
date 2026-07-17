import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import OpenClawScalarField from './OpenClawScalarField';

describe('OpenClawScalarField', () => {
    it('renders and toggles a real boolean switch', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <OpenClawScalarField
                name="streaming"
                field={{ type: 'boolean' }}
                value="true"
                onChange={onChange}
            />,
        );

        const toggle = screen.getByRole('switch', { name: '流式回复' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        await user.click(toggle);
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it('renders schema numbers as numeric inputs and enums without a native select', () => {
        const { container, rerender } = render(
            <OpenClawScalarField
                name="limit"
                field={{ type: 'integer' }}
                value="invalid"
                onChange={vi.fn()}
            />,
        );
        const numberInput = screen.getByRole('spinbutton', { name: 'limit' });
        const error = screen.getByRole('alert');
        expect(numberInput).toHaveAttribute('aria-invalid', 'true');
        expect(numberInput).toHaveAttribute('aria-describedby', error.id);
        expect(error).not.toBeEmptyDOMElement();

        rerender(
            <OpenClawScalarField
                name="mode"
                field={{ type: 'string', enum: ['fast', 'quality'] }}
                value="fast"
                onChange={vi.fn()}
            />,
        );
        expect(container.querySelector('select')).toBeNull();
        expect(screen.getByRole('button', { name: /fast/i })).toBeInTheDocument();
    });
});
