/**
 * 小说知识索引的事实源边界。
 *
 * 提案、回收站和派生缓存都不是当前正式事实，所有
 * renderer/server 索引入口必须使用同一套规则，避免不同入口得到不同答案。
 */
export const KNOWLEDGE_INDEXABLE_EXTENSIONS = Object.freeze([
  ".md",
  ".json",
] as const);

const IGNORED_EXACT_PREFIXES = Object.freeze([
  ".git/",
  ".cache/",
  "prompts/",
  "knowledge/derived/",
  "manuscript/trash/",
  "research/trash/",
  "world/maps/trash/",
] as const);

export function normalizeKnowledgePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** 返回路径是否属于当前可检索的正式事实源。 */
export function isKnowledgeSourcePath(path: string): boolean {
  const normalized = normalizeKnowledgePath(path).toLocaleLowerCase("en-US");
  if (!normalized) return false;
  if (IGNORED_EXACT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  if (
    normalized === "proposals" ||
    normalized.startsWith("proposals/") ||
    normalized.includes("/proposals/") ||
    normalized.endsWith("/proposals") ||
    normalized === "trash" ||
    normalized.startsWith("trash/") ||
    normalized.includes("/trash/") ||
    normalized.endsWith("/trash")
  ) {
    return false;
  }
  const extension = normalized.slice(normalized.lastIndexOf("."));
  return (KNOWLEDGE_INDEXABLE_EXTENSIONS as readonly string[]).includes(
    extension,
  );
}

export const KNOWLEDGE_SOURCE_SCOPE_VERSION = 1 as const;
