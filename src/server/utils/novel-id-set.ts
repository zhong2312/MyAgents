import { readFile } from "fs/promises";

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 读取单个小说索引文件中的实体 ID；缺失索引代表空集合。 */
export async function readNovelIndexIdSet(
  absolutePath: string,
  field: string,
  sourcePath: string,
): Promise<Set<string>> {
  const content = await readOptional(absolutePath);
  if (!content) return new Set();
  const document = JSON.parse(content) as unknown;
  const record =
    document && typeof document === "object" && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  const entries = record[field];
  if (!Array.isArray(entries)) return new Set();

  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${sourcePath} 的 ${field} 条目必须是 JSON 对象`);
    }
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}
