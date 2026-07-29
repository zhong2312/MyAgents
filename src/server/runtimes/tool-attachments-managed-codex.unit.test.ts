import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const separator = process.platform === 'win32' ? '\\' : '/';
  return `${process.cwd()}${separator}.tmp-managed-attachment-test-${process.pid}`;
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import {
  ATTACHMENT_ERROR_CODES,
  lookupExternalAttachment,
  saveToolAttachment,
} from './tool-attachments';

const context = {
  sessionId: 'managed-session',
  turnId: 'turn-1',
  toolUseId: 'image-call',
  mimeType: 'image/png',
  producedBy: 'codex.image_generation',
};

describe('Managed Codex external-path attachments', () => {
  const managedHome = path.join(TEST_HOME, '.myagents', 'codex');
  const generatedImage = path.join(managedHome, 'generated_images', 'thread', 'call.png');
  const authFile = path.join(managedHome, 'auth.json');

  beforeAll(() => {
    mkdirSync(path.dirname(generatedImage), { recursive: true });
    writeFileSync(generatedImage, Buffer.from('generated-image'));
    writeFileSync(authFile, Buffer.from('credential'));
  });

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('registers a generated image as a zero-copy attachment URL', async () => {
    const attachment = await saveToolAttachment(
      { kind: 'externalPath', sourcePath: generatedImage },
      context,
    );

    expect(attachment).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      refPath: '/api/attachment/tool/managed-session/turn-1/call.png',
      savedPath: generatedImage,
      producedBy: 'codex.image_generation',
    });
    expect(lookupExternalAttachment('managed-session', 'turn-1', 'call.png')).toBe(generatedImage);
  });

  it('still rejects auth.json as an external attachment', async () => {
    await expect(saveToolAttachment(
      { kind: 'externalPath', sourcePath: authFile },
      context,
    )).rejects.toMatchObject({ code: ATTACHMENT_ERROR_CODES.REJECTED_PATH });
  });
});
