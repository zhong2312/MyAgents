import type { WorkbenchStorage } from "@/workbench-sdk";

import { createStorageTransaction } from "./shared/infrastructure/storageTransaction";
import {
  createEmptyManuscriptCommentIndex,
  parseManuscriptComment,
  parseManuscriptCommentIndex,
  serializeManuscriptComment,
  serializeManuscriptCommentIndex,
  type ManuscriptComment,
  type ManuscriptCommentIndex,
} from "./manuscriptCommentSchema";

export const MANUSCRIPT_COMMENT_INDEX_PATH = "manuscript/comments/index.json";
export const MANUSCRIPT_COMMENT_RECORD_ROOT = "manuscript/comments/records";

export interface LoadedManuscriptComments {
  readonly index: ManuscriptCommentIndex;
  readonly indexContent: string;
  readonly comments: readonly ManuscriptComment[];
  readonly files: ReadonlyMap<string, string>;
}

function recordPath(id: string): string {
  return `${MANUSCRIPT_COMMENT_RECORD_ROOT}/${id}.json`;
}

function createStableId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `comment-${random.toLowerCase()}`;
}

function indexContent(index: ManuscriptCommentIndex): string {
  return serializeManuscriptCommentIndex(index);
}

async function readLoaded(
  storage: WorkbenchStorage,
): Promise<LoadedManuscriptComments> {
  const indexFile = await storage.readText(MANUSCRIPT_COMMENT_INDEX_PATH);
  const index = parseManuscriptCommentIndex(indexFile.content);
  const files = new Map<string, string>([
    [MANUSCRIPT_COMMENT_INDEX_PATH, indexFile.content],
  ]);
  const comments: ManuscriptComment[] = [];
  for (const entry of index.comments) {
    if (entry.path !== recordPath(entry.id)) {
      throw new Error(`评论索引路径与 ID 不匹配：${entry.id}`);
    }
    const content = (await storage.readText(entry.path)).content;
    files.set(entry.path, content);
    const comment = parseManuscriptComment(content);
    if (comment.id !== entry.id || comment.chapterId !== entry.chapterId) {
      throw new Error(`评论记录与索引不匹配：${entry.id}`);
    }
    comments.push(comment);
  }
  return Object.freeze({
    index,
    indexContent: indexFile.content,
    comments: Object.freeze(comments),
    files,
  });
}

export function createManuscriptCommentInitializationFiles(
  now = new Date().toISOString(),
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: MANUSCRIPT_COMMENT_INDEX_PATH,
      content: indexContent(createEmptyManuscriptCommentIndex(now)),
    },
  ];
}

export function createManuscriptCommentRepository(storage: WorkbenchStorage) {
  const load = async (): Promise<LoadedManuscriptComments> => {
    const [index] = await storage.stat([MANUSCRIPT_COMMENT_INDEX_PATH]);
    if (!index?.exists) {
      const transaction = createStorageTransaction(storage);
      for (const file of createManuscriptCommentInitializationFiles()) {
        transaction.createText(file.path, file.content);
      }
      await transaction.commit();
    }
    return readLoaded(storage);
  };

  const create = async (
    current: LoadedManuscriptComments,
    input: Omit<ManuscriptComment, "id" | "createdAt" | "updatedAt">,
  ): Promise<LoadedManuscriptComments> => {
    if (
      !input.chapterId.trim() ||
      !input.quote.trim() ||
      !input.content.trim()
    ) {
      throw new Error("评论必须包含章节、引用文字和评论内容");
    }
    if (input.start > input.end) {
      throw new Error("评论选区范围无效");
    }
    const now = new Date().toISOString();
    const comment: ManuscriptComment = Object.freeze({
      ...input,
      id: createStableId(),
      createdAt: now,
      updatedAt: now,
    });
    const nextIndex: ManuscriptCommentIndex = Object.freeze({
      schemaVersion: 1,
      updatedAt: now,
      comments: Object.freeze([
        ...current.index.comments,
        Object.freeze({
          id: comment.id,
          chapterId: comment.chapterId,
          path: recordPath(comment.id),
          updatedAt: now,
        }),
      ]),
    });
    const nextIndexContent = indexContent(nextIndex);
    const transaction = createStorageTransaction(storage);
    transaction.createText(
      recordPath(comment.id),
      serializeManuscriptComment(comment),
    );
    transaction.writeText(
      MANUSCRIPT_COMMENT_INDEX_PATH,
      nextIndexContent,
      current.indexContent,
    );
    await transaction.commit();
    return readLoaded(storage);
  };

  const removeMany = async (
    current: LoadedManuscriptComments,
    commentIds: readonly string[],
  ): Promise<LoadedManuscriptComments> => {
    const ids = new Set(commentIds);
    if (ids.size === 0) throw new Error("至少选择一条评论");
    const entries = current.index.comments.filter((item) => ids.has(item.id));
    if (entries.length !== ids.size) {
      const missingId = [...ids].find(
        (id) => !current.index.comments.some((item) => item.id === id),
      );
      throw new Error(`评论不存在：${missingId ?? "未知评论"}`);
    }

    const nextIndex: ManuscriptCommentIndex = Object.freeze({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      comments: Object.freeze(
        current.index.comments.filter((item) => !ids.has(item.id)),
      ),
    });
    const transaction = createStorageTransaction(storage);
    transaction.writeText(
      MANUSCRIPT_COMMENT_INDEX_PATH,
      indexContent(nextIndex),
      current.indexContent,
    );
    for (const entry of entries) transaction.remove(entry.path);
    await transaction.commit();
    return readLoaded(storage);
  };

  const remove = async (
    current: LoadedManuscriptComments,
    commentId: string,
  ): Promise<LoadedManuscriptComments> => removeMany(current, [commentId]);

  return Object.freeze({ load, create, remove, removeMany });
}

export type ManuscriptCommentRepository = ReturnType<
  typeof createManuscriptCommentRepository
>;
