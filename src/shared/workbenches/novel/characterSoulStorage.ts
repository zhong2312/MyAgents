import { z } from "zod";

import {
  characterSoulDefinitionSchema,
  type CharacterSoulDefinition,
} from "./characterLibrarySchema";

export const CHARACTER_SOUL_DIRECTORY = "characters/souls";
export const CHARACTER_SOUL_INDEX_PATH = "characters/souls/index.json";
export const CHARACTER_SOUL_RECORDS_DIRECTORY = "characters/souls/records";
export const CHARACTER_SOUL_STORAGE_VERSION = 1 as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

const characterSoulIndexEntrySchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    name: z.string().trim().min(1),
    category: z.string(),
    builtIn: z.boolean(),
    path: z.string().min(1),
  })
  .strict();

const characterSoulIndexSchema = z
  .object({
    schemaVersion: z.literal(CHARACTER_SOUL_STORAGE_VERSION),
    entries: z.array(characterSoulIndexEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const ids = new Set<string>();
    index.entries.forEach((entry, position) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          path: ["entries", position, "id"],
          message: "角色灵魂 id 不得重复",
        });
      }
      ids.add(entry.id);
    });
  });

const characterSoulRecordFileSchema = characterSoulDefinitionSchema.safeExtend({
  schemaVersion: z.literal(CHARACTER_SOUL_STORAGE_VERSION),
});

export interface CharacterSoulTextFile {
  readonly path: string;
  readonly content: string;
}

export interface LoadedCharacterSoulFiles {
  readonly souls: readonly CharacterSoulDefinition[];
  readonly files: ReadonlyMap<string, string>;
}

export type ReadCharacterSoulText = (path: string) => Promise<string>;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new Error(
      `${path} 不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function parseValue<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${path} 格式错误：${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；")}`,
    );
  }
  return result.data;
}

export function characterSoulRecordPath(id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error("角色灵魂 id 只能使用小写字母、数字和连字符");
  }
  return `${CHARACTER_SOUL_RECORDS_DIRECTORY}/${id}.json`;
}

/** 将角色灵魂聚合拆成轻量索引与独立记录；索引固定最后返回。 */
export function createCharacterSoulFiles(
  souls: readonly CharacterSoulDefinition[],
): readonly CharacterSoulTextFile[] {
  const ids = new Set<string>();
  const entries: Array<z.infer<typeof characterSoulIndexEntrySchema>> = [];
  const files: CharacterSoulTextFile[] = [];
  souls.forEach((value, position) => {
    const soul = parseValue(
      `角色灵魂.${position}`,
      characterSoulDefinitionSchema,
      value,
    );
    if (ids.has(soul.id)) throw new Error(`角色灵魂包含重复 id：${soul.id}`);
    ids.add(soul.id);
    const path = characterSoulRecordPath(soul.id);
    entries.push({
      id: soul.id,
      name: soul.name,
      category: soul.category,
      builtIn: soul.builtIn,
      path,
    });
    files.push({
      path,
      content: json({ schemaVersion: CHARACTER_SOUL_STORAGE_VERSION, ...soul }),
    });
  });
  files.push({
    path: CHARACTER_SOUL_INDEX_PATH,
    content: json({
      schemaVersion: CHARACTER_SOUL_STORAGE_VERSION,
      entries,
    }),
  });
  return files;
}

/** 从索引递归读取全部角色灵魂，并拒绝索引摘要与正式记录漂移。 */
export async function loadCharacterSoulFiles(
  readText: ReadCharacterSoulText,
): Promise<LoadedCharacterSoulFiles> {
  const files = new Map<string, string>();
  const read: ReadCharacterSoulText = async (path) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = await readText(path);
    files.set(path, content);
    return content;
  };
  const index = parseValue(
    CHARACTER_SOUL_INDEX_PATH,
    characterSoulIndexSchema,
    parseJson(CHARACTER_SOUL_INDEX_PATH, await read(CHARACTER_SOUL_INDEX_PATH)),
  );
  const souls = await Promise.all(
    index.entries.map(async (entry, position) => {
      const expectedPath = characterSoulRecordPath(entry.id);
      if (entry.path !== expectedPath) {
        throw new Error(
          `${CHARACTER_SOUL_INDEX_PATH}.entries.${position}.path 必须是 ${expectedPath}`,
        );
      }
      const record = parseValue(
        entry.path,
        characterSoulRecordFileSchema,
        parseJson(entry.path, await read(entry.path)),
      );
      if (record.id !== entry.id) {
        throw new Error(`${entry.path}.id 与角色灵魂索引不一致`);
      }
      if (
        record.name !== entry.name ||
        record.category !== entry.category ||
        record.builtIn !== entry.builtIn
      ) {
        throw new Error(`${entry.path} 与角色灵魂索引摘要不一致`);
      }
      const { schemaVersion: _schemaVersion, ...soul } = record;
      return soul;
    }),
  );
  return { souls, files };
}

export function characterSoulFileMap(
  files: readonly CharacterSoulTextFile[],
): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file.path, file.content] as const));
}

export function serializeCharacterSoulSnapshot(
  files: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}
