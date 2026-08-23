export interface ManuscriptComment {
  readonly id: string;
  readonly chapterId: string;
  readonly quote: string;
  readonly content: string;
  readonly start: number;
  readonly end: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManuscriptCommentIndexEntry {
  readonly id: string;
  readonly chapterId: string;
  readonly path: string;
  readonly updatedAt: string;
}

export interface ManuscriptCommentIndex {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly comments: readonly ManuscriptCommentIndexEntry[];
}

export function serializeManuscriptComment(comment: ManuscriptComment): string {
  return `${JSON.stringify(comment, null, 2)}\n`;
}

export function serializeManuscriptCommentIndex(
  index: ManuscriptCommentIndex,
): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`评论字段 ${field} 无效`);
  return value;
}

function asInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`评论字段 ${field} 无效`);
  }
  return value;
}

export function parseManuscriptComment(content: string): ManuscriptComment {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("评论记录必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    id: asString(record.id, "id"),
    chapterId: asString(record.chapterId, "chapterId"),
    quote: asString(record.quote, "quote"),
    content: asString(record.content, "content"),
    start: asInteger(record.start, "start"),
    end: asInteger(record.end, "end"),
    createdAt: asString(record.createdAt, "createdAt"),
    updatedAt: asString(record.updatedAt, "updatedAt"),
  });
}

export function parseManuscriptCommentIndex(
  content: string,
): ManuscriptCommentIndex {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("评论索引必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.comments)) {
    throw new Error("评论索引版本不受支持");
  }
  const comments = record.comments.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("评论索引条目无效");
    }
    const item = entry as Record<string, unknown>;
    return Object.freeze({
      id: asString(item.id, "id"),
      chapterId: asString(item.chapterId, "chapterId"),
      path: asString(item.path, "path"),
      updatedAt: asString(item.updatedAt, "updatedAt"),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    updatedAt: asString(record.updatedAt, "updatedAt"),
    comments: Object.freeze(comments),
  });
}

export function createEmptyManuscriptCommentIndex(
  now = new Date().toISOString(),
): ManuscriptCommentIndex {
  return Object.freeze({ schemaVersion: 1, updatedAt: now, comments: [] });
}
