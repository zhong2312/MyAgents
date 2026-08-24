import { describe, expect, it } from 'vitest';

import {
  appendOmittedImageNote,
  classifyToolAttachmentPresentation,
  extractToolResultRenderParts,
  normalizeSdkToolUseResult,
} from './tool-result-attachments';

describe('normalizeSdkToolUseResult', () => {
  it('unwraps SDK 0.3.232+ subagent MCP metadata envelopes', () => {
    const metadata = { traceId: 'private-metadata' };
    expect(normalizeSdkToolUseResult({
      content: [{ type: 'text', text: 'visible result' }],
      _meta: metadata,
    })).toEqual({
      content: [{ type: 'text', text: 'visible result' }],
      metadata,
      isMetadataEnvelope: true,
    });
  });

  it('preserves legacy structured and scalar tool_use_result values', () => {
    const legacy = { query: 'sdk upgrade', results: [{ title: 'result' }] };
    expect(normalizeSdkToolUseResult(legacy)).toEqual({
      content: legacy,
      metadata: undefined,
      isMetadataEnvelope: false,
    });
    expect(normalizeSdkToolUseResult('plain result')).toEqual({
      content: 'plain result',
      metadata: undefined,
      isMetadataEnvelope: false,
    });
  });

  it('does not mistake an ordinary content-bearing result for an SDK envelope', () => {
    const ordinary = { content: 'visible result', status: 'ok' };
    expect(normalizeSdkToolUseResult(ordinary).isMetadataEnvelope).toBe(false);
  });
});

describe('extractToolResultRenderParts', () => {
  it('extracts MCP image content blocks without leaking base64 into text (#293)', () => {
    const result = extractToolResultRenderParts([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);

    expect(result.text).toBe('screenshot captured');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'base64', data: 'aGVsbG8=' },
      },
    ]);
  });

  it('extracts Anthropic base64 image source blocks', () => {
    const result = extractToolResultRenderParts([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' },
      },
    ]);

    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/jpeg',
        source: { kind: 'base64', data: 'ZmFrZQ==' },
      },
    ]);
  });

  it('extracts data-URL payloads and prefers the embedded mime type', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', data: 'data:image/webp;base64,Zm9v' },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/webp',
        source: { kind: 'base64', data: 'Zm9v' },
      },
    ]);
  });

  it('maps file-path image refs to externalPath sources (allow-list enforced at save layer)', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', file: { path: '/Users/x/.myagents/generated/shot.png', mimeType: 'image/png' } },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'externalPath', sourcePath: '/Users/x/.myagents/generated/shot.png' },
      },
    ]);
  });

  it('maps remote urls to url sources (SSRF guard enforced at save layer)', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', url: 'https://example.com/img.png' },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://example.com/img.png' },
      },
    ]);
  });

  it('redacts unknown base64-like fields when falling back to JSON text', () => {
    const payload = 'a'.repeat(300);
    const result = extractToolResultRenderParts({ type: 'unknown', data: payload });

    expect(result.attachments).toEqual([]);
    expect(result.text).toContain('[300 bytes omitted]');
    expect(result.text).not.toContain(payload);
  });

  it('passes string content through untouched', () => {
    const result = extractToolResultRenderParts('plain result');
    expect(result).toEqual({ text: 'plain result', attachments: [] });
  });

  it('extracts a bare data-URL image STRING so base64 never reaches text (finding 2)', () => {
    const result = extractToolResultRenderParts('data:image/png;base64,aGVsbG8=');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      { kind: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'aGVsbG8=' } },
    ]);
  });

  it('extracts a data-URL image carried inside a text block (finding 2)', () => {
    const result = extractToolResultRenderParts([
      { type: 'text', text: '  data:image/jpeg;base64,ZmFrZQ==  ' },
    ]);
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      { kind: 'image', mimeType: 'image/jpeg', source: { kind: 'base64', data: 'ZmFrZQ==' } },
    ]);
  });

  it('does NOT treat a non-image data URL or prose-with-url as an image', () => {
    const pdf = extractToolResultRenderParts('data:application/pdf;base64,JVBER');
    expect(pdf.attachments).toEqual([]);
    expect(pdf.text).toBe('data:application/pdf;base64,JVBER');
    const prose = extractToolResultRenderParts('see data:image/png;base64,xx inline');
    expect(prose.attachments).toEqual([]); // not a standalone data URL
    expect(prose.text).toContain('see data:image/png');
  });

  it('handles null/undefined content', () => {
    expect(extractToolResultRenderParts(null)).toEqual({ text: '', attachments: [] });
    expect(extractToolResultRenderParts(undefined)).toEqual({ text: '', attachments: [] });
  });
});

describe('classifyToolAttachmentPresentation (#293 artifact/process split)', () => {
  it('classifies playwright / computer-use screenshots as process media', () => {
    expect(classifyToolAttachmentPresentation('mcp__playwright__browser_take_screenshot')).toBe('process');
    expect(classifyToolAttachmentPresentation('mcp__computer-use__screenshot')).toBe('process');
    expect(classifyToolAttachmentPresentation('mcp__cuse__click')).toBe('process');
    // generic screenshot-named tools err toward process (flood prevention)
    expect(classifyToolAttachmentPresentation('mcp__my-browser__take_screenshot')).toBe('process');
  });

  it('classifies generator tools (and unknown/missing names) as artifact', () => {
    expect(classifyToolAttachmentPresentation('mcp__gemini-image__generate_image')).toBe('artifact');
    expect(classifyToolAttachmentPresentation('mcp__edge-tts__synthesize')).toBe('artifact');
    expect(classifyToolAttachmentPresentation('some_random_tool')).toBe('artifact');
    expect(classifyToolAttachmentPresentation(undefined)).toBe('artifact');
    expect(classifyToolAttachmentPresentation(null)).toBe('artifact');
  });
});

describe('appendOmittedImageNote', () => {
  it('appends a count note when images were dropped', () => {
    expect(appendOmittedImageNote('done', 2)).toBe('done\n[2 image attachment(s) omitted]');
    expect(appendOmittedImageNote('', 1)).toBe('[1 image attachment(s) omitted]');
  });
  it('is a no-op when no images were dropped', () => {
    expect(appendOmittedImageNote('done', 0)).toBe('done');
    expect(appendOmittedImageNote('done', -1)).toBe('done');
  });
});
