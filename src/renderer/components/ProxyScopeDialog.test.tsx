import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Provider } from '@/config/types';
import { i18n } from '@/i18n';
import ProxyScopeDialog from './ProxyScopeDialog';

const providers = [
  {
    id: 'anthropic-sub',
    name: 'Anthropic',
    vendor: 'Anthropic',
    cloudProvider: 'Official',
    type: 'subscription',
    primaryModel: 'claude-sonnet',
    isBuiltin: true,
    config: {},
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    cloudProvider: 'Official',
    type: 'api',
    primaryModel: 'deepseek-chat',
    isBuiltin: true,
    config: {},
    models: [],
  },
] as Provider[];

describe('ProxyScopeDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders general requests before providers and saves both dimensions', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ProxyScopeDialog
        providers={providers}
        initialGeneralRequests
        initialProviderIds={['anthropic-sub']}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const choices = screen.getAllByRole('checkbox');
    expect(choices).toHaveLength(3);
    expect(choices[0]).toHaveAccessibleName(/General network requests/);
    expect(choices[0]).toHaveAttribute('aria-checked', 'true');
    expect(choices[1]).toHaveAccessibleName(/Anthropic/);
    expect(choices[2]).toHaveAccessibleName(/DeepSeek/);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(choices[0]);
    await user.click(choices[2]);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      generalRequests: false,
      providerIds: ['anthropic-sub', 'deepseek'],
    });
  });

  it('select all includes general requests and zero selection remains saveable', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <ProxyScopeDialog
        providers={providers}
        initialGeneralRequests={false}
        initialProviderIds={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getAllByRole('checkbox').every(choice => choice.getAttribute('aria-checked') === 'true'))
      .toBe(true);
    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    await user.click(save);

    expect(onSave).toHaveBeenCalledWith({ generalRequests: false, providerIds: [] });
  });
});
