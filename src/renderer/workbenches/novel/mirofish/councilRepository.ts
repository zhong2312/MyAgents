import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";
import { z } from "zod";

import type { CouncilSession } from "./councilRound";

export const COUNCIL_SESSIONS_PATH = "simulation/councils.json";

const statementSchema = z.object({ actorId: z.string(), message: z.string() });
const voteSchema = z.object({ actorId: z.string(), choice: z.string() });
const sessionSchema = z.object({
  schemaVersion: z.literal(1),
  topic: z.string(),
  actorIds: z.array(z.string()),
  maxRounds: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  history: z.array(statementSchema),
  votes: z.array(voteSchema),
  status: z.enum(["idle", "running", "completed", "error"]),
  updatedAt: z.string().datetime(),
  error: z.string().nullable(),
});

const fileSchema = z.object({ schemaVersion: z.literal(1), sessions: z.array(sessionSchema) });

export interface LoadedCouncilSessions {
  readonly value: z.infer<typeof fileSchema>;
  readonly content: string;
}

async function ensureFile(storage: WorkbenchStorage): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([COUNCIL_SESSIONS_PATH]);
  if (info?.exists) return storage.readText(COUNCIL_SESSIONS_PATH);
  const content = `${JSON.stringify({ schemaVersion: 1, sessions: [] }, null, 2)}\n`;
  try {
    return await storage.createText(COUNCIL_SESSIONS_PATH, content, { createParents: true });
  } catch {
    return storage.readText(COUNCIL_SESSIONS_PATH);
  }
}

export function createCouncilRepository(storage: WorkbenchStorage) {
  return {
    async load(): Promise<LoadedCouncilSessions> {
      const file = await ensureFile(storage);
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        throw new Error(`${COUNCIL_SESSIONS_PATH} JSON 无效`);
      }
      const result = fileSchema.safeParse(parsed);
      if (!result.success) throw new Error(`${COUNCIL_SESSIONS_PATH} 格式错误`);
      return Object.freeze({ value: result.data, content: file.content });
    },
    async save(
      current: LoadedCouncilSessions,
      sessions: readonly CouncilSession[],
    ): Promise<LoadedCouncilSessions> {
      const value = fileSchema.parse({ schemaVersion: 1, sessions });
      const file = await storage.writeText(
        COUNCIL_SESSIONS_PATH,
        `${JSON.stringify(value, null, 2)}\n`,
        { expectedContent: current.content },
      );
      return Object.freeze({ value, content: file.content });
    },
  };
}

