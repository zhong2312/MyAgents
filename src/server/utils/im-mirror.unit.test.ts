import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedImagePayload } from '../runtimes/types';
import {
  resolvedImagesToMirrorImages,
  visibleDesktopMirrorText,
  mirrorIfChannelBound,
} from './im-mirror';

describe('IM desktop mirror projection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MYAGENTS_MANAGEMENT_PORT;
  });

  it('removes stacked hidden system-reminder envelopes from mirrored user text', () => {
    const content = [
      '<system-reminder>first hidden payload</system-reminder>',
      '<system-reminder>second hidden payload</system-reminder>',
      'Visible desktop question',
    ].join('\n');

    expect(visibleDesktopMirrorText(content)).toBe('Visible desktop question');
  });

  it('projects only supported bounded image payloads', () => {
    const images: ResolvedImagePayload[] = [
      {
        kind: 'inline_base64',
        name: 'photo.png',
        mimeType: 'image/png',
        data: 'cG5n',
      },
      {
        kind: 'inline_base64',
        name: 'animation.gif',
        mimeType: 'image/gif',
        data: 'Z2lm',
      },
      {
        kind: 'inline_base64',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        data: 'anBlZw==',
      },
    ];

    expect(resolvedImagesToMirrorImages(images)).toEqual([
      { mimeType: 'image/png', dataBase64: 'cG5n' },
      { mimeType: 'image/jpeg', dataBase64: 'anBlZw==' },
    ]);
  });

  it.each(['NO_REPLY', ' <NO_REPLY> '])('suppresses explicit assistant silence token %j', async (text) => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '12345';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await mirrorIfChannelBound({ sessionId: 'session-1', role: 'assistant', text });

    expect(fetch).not.toHaveBeenCalled();
  });
});
