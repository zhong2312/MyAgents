import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OpenClawConfigEditor } from './ChannelDetailView';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const schemaProperties = {
    timeout: { type: 'integer' },
    name: { type: 'string' },
};

describe('OpenClawConfigEditor', () => {
    it('persists field mutations across an unmount while an older save is pending', async () => {
        const firstSave = deferred<Record<string, unknown>>();
        const onChange = vi.fn()
            .mockImplementationOnce(() => firstSave.promise)
            .mockResolvedValue({ name: 'b' });
        const firstEditor = render(
            <OpenClawConfigEditor
                pluginConfig={{ timeout: 30, name: 'a' }}
                pluginId="openclaw-lark"
                npmSpec="@larksuite/openclaw-lark"
                schemaProperties={schemaProperties}
                onChange={onChange}
            />,
        );

        fireEvent.change(screen.getByRole('spinbutton', { name: 'timeout' }), { target: { value: '' } });
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        expect(onChange).toHaveBeenNthCalledWith(1, { type: 'delete', key: 'timeout' });

        firstEditor.unmount();
        render(
            <OpenClawConfigEditor
                pluginConfig={{ timeout: 30, name: 'a' }}
                pluginId="openclaw-lark"
                npmSpec="@larksuite/openclaw-lark"
                schemaProperties={schemaProperties}
                onChange={onChange}
            />,
        );
        fireEvent.change(screen.getByRole('textbox', { name: 'name' }), { target: { value: 'b' } });
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
        expect(onChange).toHaveBeenNthCalledWith(2, { type: 'set', key: 'name', value: 'b' });

        await act(async () => { firstSave.resolve({ name: 'a' }); });
    });

    it('rolls the latest failed save back to the last persisted snapshot', async () => {
        const onChange = vi.fn().mockRejectedValue(new Error('disk unavailable'));
        render(
            <OpenClawConfigEditor
                pluginConfig={{ timeout: 30, name: 'a' }}
                pluginId="openclaw-lark"
                npmSpec="@larksuite/openclaw-lark"
                schemaProperties={schemaProperties}
                onChange={onChange}
            />,
        );

        const nameInput = screen.getByRole('textbox', { name: 'name' });
        fireEvent.change(nameInput, { target: { value: 'b' } });

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk unavailable'));
        expect(onChange).toHaveBeenCalledWith({ type: 'set', key: 'name', value: 'b' });
        expect(nameInput).toHaveValue('a');
    });
});
