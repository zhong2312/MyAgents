import { z } from "zod";

import {
  powerSystemIndexSchema,
  powerSystemInteractionsSchema,
  powerSystemMetaSchema,
  powerSystemRecordSchema,
  type PowerSystemIndex,
  type PowerSystemInteractions,
  type PowerSystemMeta,
  type PowerSystemRecord,
} from "../../../shared/novel-power-system-schema";
import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export * from "../../../shared/novel-power-system-schema";

export class PowerSystemFormatError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath} 格式错误：${detail}`);
    this.name = "PowerSystemFormatError";
  }
}

function parseFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  content: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new PowerSystemFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PowerSystemFormatError(
      filePath,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function parsePowerSystemMeta(content: string): PowerSystemMeta {
  return parseFile(
    "world/power-systems/meta.json",
    powerSystemMetaSchema,
    content,
  );
}

export function parsePowerSystemIndex(content: string): PowerSystemIndex {
  const index = parseFile(
    "world/power-systems/index.json",
    powerSystemIndexSchema,
    content,
  );
  index.systems.forEach((entry) => {
    const recordPath = normalizeWorkbenchStoragePath(entry.recordPath);
    const pagePath = normalizeWorkbenchStoragePath(entry.pagePath);
    if (recordPath !== `world/power-systems/records/${entry.id}.json`) {
      throw new PowerSystemFormatError(
        entry.recordPath,
        "体系记录路径与 id 不一致",
      );
    }
    if (pagePath !== `world/power-systems/pages/${entry.id}.md`) {
      throw new PowerSystemFormatError(
        entry.pagePath,
        "体系说明路径与 id 不一致",
      );
    }
  });
  return index;
}

export function parsePowerSystemRecord(
  path: string,
  content: string,
): PowerSystemRecord {
  return parseFile(path, powerSystemRecordSchema, content);
}

export function parsePowerSystemInteractions(
  content: string,
): PowerSystemInteractions {
  return parseFile(
    "world/power-systems/interactions.json",
    powerSystemInteractionsSchema,
    content,
  );
}

export function serializePowerSystemFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
