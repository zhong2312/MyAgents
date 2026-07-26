import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  CULTIVATION_ECOLOGY_SCHEMA_VERSION,
  cultivationEcologySchema,
  type CultivationEcology,
} from "../../../shared/novel-cultivation-ecology-schema";
import {
  cloneDefaultCultivationEcology,
} from "./cultivationEcologyDefaults";
import { rebuildCultivationAudits } from "./cultivationEcologyAudit";

export const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";

function serialize(value: CultivationEcology): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeResourceGradeEffects(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as { systems?: unknown };
  if (!Array.isArray(root.systems)) return value;

  const normalized = {
    ...root,
    schemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION,
    systems: root.systems.map((system) => {
      if (!system || typeof system !== "object" || Array.isArray(system)) return system;
      const systemValue = system as { resources?: unknown; projection?: unknown; trackInteractions?: unknown };
      const resources = systemValue.resources;

      return {
        ...systemValue,
        trackInteractions: systemValue.trackInteractions,
        projection: normalizeProjection((systemValue as { projection?: unknown }).projection),
        resources: Array.isArray(resources) ? resources.map((resource) => {
          if (!resource || typeof resource !== "object" || Array.isArray(resource)) return resource;
          const resourceValue = resource as { grades?: unknown };
          if (!Array.isArray(resourceValue.grades)) return resource;

          return {
            ...resourceValue,
            grades: resourceValue.grades.map((grade) => {
              if (!grade || typeof grade !== "object" || Array.isArray(grade)) return grade;
              return "effect" in grade ? grade : { ...grade, effect: "" };
            }),
          };
        }) : resources,
      };
    }),
  };
  return normalized;
}

function normalizeProjection(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const projection = value as Record<string, unknown>;
  return {
    ...projection,
    originBindings: projection.originBindings === undefined ? [] : projection.originBindings,
  };
}

function parse(content: string): CultivationEcology {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`修行生态 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const result = cultivationEcologySchema.safeParse(normalizeResourceGradeEffects(parsed));
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；"));
  }
  return result.data;
}

function readSchemaVersion(content: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" ? version : null;
}

export function createCultivationEcologyInitializationFiles(): readonly { readonly path: string; readonly content: string }[] {
  return [{ path: CULTIVATION_ECOLOGY_PATH, content: serialize(cloneDefaultCultivationEcology()) }];
}

export function createCultivationEcologyRepository(storage: WorkbenchStorage) {
  const loadExisting = async () => {
    const file = await storage.readText(CULTIVATION_ECOLOGY_PATH);
    const schemaVersion = readSchemaVersion(file.content);
    if (schemaVersion !== null && schemaVersion > CULTIVATION_ECOLOGY_SCHEMA_VERSION) {
      throw new Error(`修行生态数据版本 ${schemaVersion} 高于当前支持版本 ${CULTIVATION_ECOLOGY_SCHEMA_VERSION}，请先升级应用。`);
    }
    if (schemaVersion === CULTIVATION_ECOLOGY_SCHEMA_VERSION) {
      return { ecology: rebuildCultivationAudits(parse(file.content)), content: file.content };
    }
    if (schemaVersion === null) {
      return { ecology: rebuildCultivationAudits(parse(file.content)), content: file.content };
    }

    // 旧版本只做结构化默认补全，不覆盖现有字段，并用 expectedContent 原子升级版本号。
    const migrated = cultivationEcologySchema.parse(normalizeResourceGradeEffects(JSON.parse(file.content)));
    const migratedWithVersion = { ...migrated, schemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION };
    const auditedMigrated = rebuildCultivationAudits(migratedWithVersion);
    const migratedContent = serialize(auditedMigrated);
    const replacement = await storage.writeText(
      CULTIVATION_ECOLOGY_PATH,
      migratedContent,
      { expectedContent: file.content },
    );
    return { ecology: parse(replacement.content), content: replacement.content };
  };

  return {
    async load() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_PATH]);
      if (!entry?.exists) return null;
      return loadExisting();
    },
    async initialize() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_PATH]);
      if (entry?.exists) return loadExisting();
      const ecology = cloneDefaultCultivationEcology();
      const audited = rebuildCultivationAudits(ecology);
      const content = serialize(audited);
      await storage.createText(CULTIVATION_ECOLOGY_PATH, content, { createParents: true });
      return { ecology: audited, content };
    },
    async save(ecology: CultivationEcology, expectedContent: string) {
      const next = cultivationEcologySchema.parse({
        ...rebuildCultivationAudits(ecology),
        updatedAt: new Date().toISOString(),
      });
      const file = await storage.writeText(CULTIVATION_ECOLOGY_PATH, serialize(next), { expectedContent });
      return { ecology: parse(file.content), content: file.content };
    },
  };
}
