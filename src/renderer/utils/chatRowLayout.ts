import type { ContentBlock, Message as MessageType, ToolUseSimple } from '@/types/chat';

export type RowGrowthClass = 'fixed-ish' | 'can-grow';

export interface RowLayoutContract {
  messageId: string;
  estimatedHeight: number;
  growthClass: RowGrowthClass;
  containsHeavyMarkdown: boolean;
  containsLongCodeBlock: boolean;
  likelyUserCollapsed?: boolean;
  fingerprint: string;
}

const MIN_ROW_HEIGHT = 96;
const MAX_ROW_HEIGHT = 2600;
const USER_COLLAPSE_VIEWPORT_RATIO = 0.5;
const USER_COLLAPSE_CONFIDENCE_MULTIPLIER = 1.35;
const CHARS_PER_PROSE_LINE = 72;
const CODE_LINE_HEIGHT = 22;
const PROSE_LINE_HEIGHT = 26;
const BLOCK_HEADER_HEIGHT = 44;
const BLOCK_GROUP_CHROME_HEIGHT = 28;
const ATTACHMENT_PLACEHOLDER_HEIGHT = 160;

function clampHeight(value: number): number {
  return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.ceil(value)));
}

function countLines(text: string): number {
  if (!text) return 0;
  const explicit = text.split(/\r?\n/).length;
  const wrapped = Math.ceil(text.replace(/\s+/g, ' ').length / CHARS_PER_PROSE_LINE);
  return Math.max(explicit, wrapped);
}

function codeFenceLineCounts(text: string): number[] {
  const counts: number[] = [];
  const fencePattern = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    const body = match[1] ?? '';
    counts.push(body.length > 0 ? body.split(/\r?\n/).length : 1);
  }
  return counts;
}

function estimateMarkdownHeight(text: string): {
  height: number;
  containsHeavyMarkdown: boolean;
  containsLongCodeBlock: boolean;
} {
  const fenceLines = codeFenceLineCounts(text);
  const fencedLineTotal = fenceLines.reduce((sum, lines) => sum + lines, 0);
  const stripped = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const proseLines = countLines(stripped);
  const tableLines = (stripped.match(/^\s*\|.*\|\s*$/gm) ?? []).length;
  const headingCount = (stripped.match(/^#{1,6}\s+/gm) ?? []).length;
  const listLines = (stripped.match(/^\s*(?:[-*+]|\d+\.)\s+/gm) ?? []).length;
  const height =
    28 +
    proseLines * PROSE_LINE_HEIGHT +
    fencedLineTotal * CODE_LINE_HEIGHT +
    fenceLines.length * 46 +
    tableLines * 10 +
    headingCount * 12 +
    listLines * 6;

  return {
    height,
    containsHeavyMarkdown: text.length > 1800 || tableLines >= 8 || fenceLines.length >= 2,
    containsLongCodeBlock: fenceLines.some(lines => lines >= 24),
  };
}

function estimateAttachmentHeight(message: MessageType): number {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return 0;
  const imageCount = attachments.filter(att => att.isImage || att.mimeType.startsWith('image/')).length;
  const fileCount = attachments.length - imageCount;
  return imageCount * ATTACHMENT_PLACEHOLDER_HEIGHT + fileCount * 56 + 16;
}

function estimateToolAttachmentHeight(tool: ToolUseSimple | undefined, presentation: 'artifact' | 'process'): number {
  const attachments = tool?.attachments?.filter(att =>
    presentation === 'process' ? att.presentation === 'process' : att.presentation !== 'process'
  ) ?? [];
  if (attachments.length === 0) return 0;
  return attachments.reduce((sum, att) => {
    if (att.kind === 'image') return sum + 220;
    if (att.kind === 'audio') return sum + 86;
    return sum + 68;
  }, 12);
}

function estimateToolHeader(block: ContentBlock): number {
  if (block.type === 'text') return 0;
  let height = BLOCK_HEADER_HEIGHT;
  if (block.type === 'thinking' && block.thinking && block.thinking.length > 1600) {
    height += 16;
  }
  if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool) {
    if (block.tool.isLoading) height += 6;
    if (block.tool.subagentCalls?.length) height += Math.min(120, block.tool.subagentCalls.length * 18);
    height += estimateToolAttachmentHeight(block.tool, 'process') > 0 ? 22 : 0;
  }
  return height;
}

function estimateContentBlocks(blocks: ContentBlock[]): {
  height: number;
  containsHeavyMarkdown: boolean;
  containsLongCodeBlock: boolean;
  canGrow: boolean;
} {
  let height = 68;
  let containsHeavyMarkdown = false;
  let containsLongCodeBlock = false;
  let canGrow = false;
  let contiguousProcessBlocks = 0;

  for (const block of blocks) {
    if (block.type === 'text') {
      const textEstimate = estimateMarkdownHeight(block.text ?? '');
      height += textEstimate.height;
      containsHeavyMarkdown ||= textEstimate.containsHeavyMarkdown;
      containsLongCodeBlock ||= textEstimate.containsLongCodeBlock;
      contiguousProcessBlocks = 0;
      continue;
    }

    contiguousProcessBlocks += 1;
    height += estimateToolHeader(block);
    if (block.type === 'thinking') {
      canGrow ||= block.isComplete !== true;
      containsHeavyMarkdown ||= Boolean(block.thinking && block.thinking.length > 1200);
      continue;
    }

    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      const tool = block.tool;
      canGrow ||= Boolean(tool?.isLoading || !tool?.result);
      height += estimateToolAttachmentHeight(tool, 'artifact');
      if (tool?.result && tool.result.length > 6000) {
        containsHeavyMarkdown = true;
      }
    }
  }

  if (contiguousProcessBlocks > 0) {
    height += BLOCK_GROUP_CHROME_HEIGHT;
  }

  return { height, containsHeavyMarkdown, containsLongCodeBlock, canGrow };
}

function userCollapseThreshold(viewportHeight: number): number {
  return Math.max(320, viewportHeight * USER_COLLAPSE_VIEWPORT_RATIO);
}

export function estimateMessageRowHeight(message: MessageType, viewportHeight: number): RowLayoutContract {
  const safeViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
  const attachmentHeight = estimateAttachmentHeight(message);

  if (message.role === 'user') {
    const text = typeof message.content === 'string' ? message.content : '';
    const markdown = estimateMarkdownHeight(text);
    const naturalHeight = 72 + markdown.height + attachmentHeight;
    const collapseThreshold = userCollapseThreshold(safeViewportHeight);
    const likelyUserCollapsed = naturalHeight > collapseThreshold * USER_COLLAPSE_CONFIDENCE_MULTIPLIER;
    const estimatedHeight = likelyUserCollapsed
      ? collapseThreshold + 96 + Math.min(attachmentHeight, 220)
      : naturalHeight;
    return {
      messageId: message.id,
      estimatedHeight: clampHeight(estimatedHeight),
      growthClass: likelyUserCollapsed || attachmentHeight > 0 ? 'can-grow' : 'fixed-ish',
      containsHeavyMarkdown: markdown.containsHeavyMarkdown,
      containsLongCodeBlock: markdown.containsLongCodeBlock,
      likelyUserCollapsed,
      fingerprint: buildMessageLayoutFingerprint(message, safeViewportHeight),
    };
  }

  if (typeof message.content === 'string') {
    const markdown = estimateMarkdownHeight(message.content);
    return {
      messageId: message.id,
      estimatedHeight: clampHeight(80 + markdown.height + attachmentHeight),
      growthClass: message.streamingTextActive ? 'can-grow' : 'fixed-ish',
      containsHeavyMarkdown: markdown.containsHeavyMarkdown,
      containsLongCodeBlock: markdown.containsLongCodeBlock,
      fingerprint: buildMessageLayoutFingerprint(message, safeViewportHeight),
    };
  }

  const blocks = estimateContentBlocks(message.content);
  return {
    messageId: message.id,
    estimatedHeight: clampHeight(blocks.height + attachmentHeight),
    growthClass: blocks.canGrow || attachmentHeight > 0 ? 'can-grow' : 'fixed-ish',
    containsHeavyMarkdown: blocks.containsHeavyMarkdown,
    containsLongCodeBlock: blocks.containsLongCodeBlock,
    fingerprint: buildMessageLayoutFingerprint(message, safeViewportHeight),
  };
}

function bucket(value: number, size: number): number {
  return Math.floor(value / size);
}

function textFingerprint(text: string): string {
  const fenceLines = codeFenceLineCounts(text);
  const maxFence = fenceLines.length ? Math.max(...fenceLines) : 0;
  return [
    bucket(text.length, 400),
    bucket(countLines(text), 8),
    fenceLines.length,
    bucket(maxFence, 8),
    (text.match(/^\s*\|.*\|\s*$/gm) ?? []).length > 0 ? 1 : 0,
  ].join(':');
}

function blockFingerprint(block: ContentBlock): string {
  if (block.type === 'text') return `t:${textFingerprint(block.text ?? '')}`;
  if (block.type === 'thinking') {
    return `h:${block.isComplete ? 1 : 0}:${block.isFailed ? 1 : 0}:${bucket((block.thinking ?? '').length, 800)}`;
  }
  const tool = block.tool;
  return [
    block.type === 'server_tool_use' ? 's' : 'u',
    tool?.name ?? '',
    tool?.isLoading ? 1 : 0,
    tool?.isError || tool?.isFailed ? 1 : 0,
    bucket(tool?.result?.length ?? 0, 1000),
    tool?.attachments?.length ?? 0,
    tool?.subagentCalls?.length ?? 0,
  ].join(':');
}

export function buildMessageLayoutFingerprint(message: MessageType, viewportHeight: number): string {
  const viewportBucket = bucket(userCollapseThreshold(viewportHeight), 80);
  const attachmentPart = `${message.attachments?.length ?? 0}:${message.attachments?.filter(a => a.isImage || a.mimeType.startsWith('image/')).length ?? 0}`;
  if (typeof message.content === 'string') {
    return `${message.id}|${message.role}|${viewportBucket}|${attachmentPart}|${textFingerprint(message.content)}|${message.streamingTextActive ? 1 : 0}`;
  }
  return `${message.id}|${message.role}|${viewportBucket}|${attachmentPart}|${message.content.map(blockFingerprint).join('|')}`;
}

export function buildHeightEstimateSeed(messages: readonly MessageType[], layoutByMessageId: ReadonlyMap<string, RowLayoutContract>): number[] {
  return messages.map(message => layoutByMessageId.get(message.id)?.estimatedHeight ?? 480);
}
