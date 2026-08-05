import { z } from "zod";

import type { WorkbenchStorage } from "@/workbench-sdk";

export const INSPIRATION_BOARDS_SCHEMA_VERSION = 1 as const;
export const INSPIRATION_BOARDS_PATH = "inspiration/boards/index.json";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

/** 画布节点：只存引用与视图状态，不复制灵感内容（T17/T18）。 */
export const canvasNodeSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["inspiration", "character", "location", "faction", "item", "event", "chapter", "group"]),
    /** 关联实体 id；group 节点为 null。 */
    entityId: z.string().trim().min(1).nullable(),
    label: z.string().trim().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export type CanvasNode = z.infer<typeof canvasNodeSchema>;

export const canvasEdgeSchema = z
  .object({
    id: idSchema,
    source: z.string().trim().min(1),
    target: z.string().trim().min(1),
    /** 默认视觉推演；采纳为正式关系后才写入领域草稿/提案（T19）。 */
    label: z.string(),
  })
  .strict();

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;

export const inspirationBoardSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    name: z.string().trim().min(1),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((board, context) => {
    const nodeIds = new Set<string>();
    board.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "画布节点 id 不得重复",
        });
      }
      nodeIds.add(node.id);
    });
    board.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "连线引用的节点不存在",
        });
      }
    });
  });

export type InspirationBoard = z.infer<typeof inspirationBoardSchema>;

export const inspirationBoardsIndexSchema = z
  .object({
    schemaVersion: z.literal(INSPIRATION_BOARDS_SCHEMA_VERSION),
    boards: z.array(
      z.object({ id: idSchema, name: z.string().trim().min(1), updatedAt: z.string().datetime() }),
    ),
  })
  .strict();

export type InspirationBoardsIndex = z.infer<typeof inspirationBoardsIndexSchema>;

function boardPath(boardId: string): string {
  if (!idSchema.safeParse(boardId).success) {
    throw new Error("画布 id 只能使用小写字母、数字和连字符");
  }
  return `inspiration/boards/${boardId}.json`;
}

export function createEmptyBoard(name: string, createdAt: string): InspirationBoard {
  return {
    schemaVersion: 1,
    id: `board-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "未命名画布",
    nodes: [],
    edges: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export class InspirationBoardFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "InspirationBoardFormatError";
  }
}

export function parseInspirationBoard(path: string, content: string): InspirationBoard {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new InspirationBoardFormatError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = inspirationBoardSchema.safeParse(value);
  if (!parsed.success) {
    throw new InspirationBoardFormatError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return parsed.data;
}

export function serializeBoard(board: InspirationBoard): string {
  return `${JSON.stringify(inspirationBoardSchema.parse(board), null, 2)}\n`;
}

export interface LoadedBoard {
  readonly board: InspirationBoard;
  readonly content: string;
}

export interface InspirationBoardRepository {
  loadIndex(): Promise<InspirationBoardsIndex>;
  loadBoard(boardId: string): Promise<LoadedBoard>;
  createBoard(name: string): Promise<LoadedBoard>;
  saveBoard(current: LoadedBoard, board: InspirationBoard): Promise<LoadedBoard>;
  deleteBoard(boardId: string): Promise<void>;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<{ content: string }> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

export function createInspirationBoardRepository(
  storage: WorkbenchStorage,
): InspirationBoardRepository {
  const loadIndex = async (): Promise<InspirationBoardsIndex> => {
    const file = await ensureTextFile(
      storage,
      INSPIRATION_BOARDS_PATH,
      `${JSON.stringify({ schemaVersion: 1, boards: [] }, null, 2)}\n`,
    );
    return inspirationBoardsIndexSchema.parse(JSON.parse(file.content));
  };

  return {
    async loadIndex() {
      return loadIndex();
    },

    async loadBoard(boardId) {
      const path = boardPath(boardId);
      const file = await storage.readText(path);
      const board = parseInspirationBoard(path, file.content);
      if (board.id !== boardId) {
        throw new Error("画布记录与 boardId 不一致");
      }
      return { board, content: file.content };
    },

    async createBoard(name) {
      const index = await loadIndex();
      const board = createEmptyBoard(name, new Date().toISOString());
      const content = serializeBoard(board);
      await storage.createText(boardPath(board.id), content, { createParents: true });
      const nextIndex = {
        ...index,
        boards: [
          ...index.boards,
          { id: board.id, name: board.name, updatedAt: board.updatedAt },
        ],
      };
      await storage.writeText(INSPIRATION_BOARDS_PATH, `${JSON.stringify(nextIndex, null, 2)}\n`, {
        expectedContent: JSON.stringify(index, null, 2) + "\n",
      });
      return { board, content };
    },

    async saveBoard(current, board) {
      if (board.id !== current.board.id) {
        throw new Error("保存画布时不得修改稳定 id");
      }
      const next = { ...board, updatedAt: new Date().toISOString() };
      const content = serializeBoard(next);
      await storage.writeText(boardPath(board.id), content, {
        expectedContent: current.content,
      });
      const index = await loadIndex();
      const nextIndex = {
        ...index,
        boards: index.boards.map((entry) =>
          entry.id === board.id ? { ...entry, name: next.name, updatedAt: next.updatedAt } : entry,
        ),
      };
      await storage.writeText(
        INSPIRATION_BOARDS_PATH,
        `${JSON.stringify(nextIndex, null, 2)}\n`,
        { expectedContent: `${JSON.stringify(index, null, 2)}\n` },
      );
      return { board: next, content };
    },

    async deleteBoard(boardId) {
      const index = await loadIndex();
      const nextIndex = {
        ...index,
        boards: index.boards.filter((entry) => entry.id !== boardId),
      };
      await storage.writeText(
        INSPIRATION_BOARDS_PATH,
        `${JSON.stringify(nextIndex, null, 2)}\n`,
        { expectedContent: `${JSON.stringify(index, null, 2)}\n` },
      );
      await storage.remove(boardPath(boardId), { permanent: true }).catch(() => false);
    },
  };
}

/** T18：把画布便签投影为灵感记录（新增便签时后台创建灵感，标题/正文同步）。 */
export function buildStickyFromInspiration(
  inspiration: { readonly id: string; readonly title: string; readonly body: string },
  position: { readonly x: number; readonly y: number },
): CanvasNode {
  return {
    id: `node-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: "inspiration",
    entityId: inspiration.id,
    label: inspiration.title,
    x: position.x,
    y: position.y,
    width: 220,
    height: 140,
  };
}
