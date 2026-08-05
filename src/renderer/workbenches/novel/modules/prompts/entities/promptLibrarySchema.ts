import { z } from "zod";

import { normalizeWorkbenchStoragePath } from "@/workbench-sdk";

export const PROMPT_LIBRARY_SCHEMA_VERSION = 1 as const;
export const PROMPT_LIBRARY_REGISTRY_PATH = "prompts/registry.json";

export type PromptScope =
  | { readonly kind: "global" }
  | { readonly kind: "genres"; readonly genres: readonly string[] };

export interface PromptGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly nodeKind: "pack-root" | "directory";
  readonly skillPackId: string;
  readonly sourcePath: string;
  readonly userCreated: boolean;
  readonly modified: boolean;
  readonly enabled: boolean;
  readonly scope: PromptScope;
}

export interface PromptSkillPack {
  readonly id: string;
  readonly packageId: string;
  readonly name: string;
  readonly source: "builtin" | "github" | "project";
  readonly repository?: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly description: string;
  readonly copyNumber: number;
  readonly modified: boolean;
}

export interface PromptDefinition {
  readonly instanceId: string;
  readonly id: string;
  readonly name: string;
  readonly groupId: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly overridden: boolean;
  readonly skillPackId: string;
  readonly scopeOverride: PromptScope | null;
  readonly content: string;
  readonly contentPath?: string;
  readonly sourcePath?: string;
}

export interface PromptLibraryModel {
  readonly packs: readonly PromptSkillPack[];
  readonly groups: readonly PromptGroup[];
  readonly prompts: readonly PromptDefinition[];
}

interface PromptPackRecord {
  readonly installationId: string;
  readonly packageId: string;
  readonly name: string;
  readonly source: PromptSkillPack["source"];
  readonly repository?: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly description: string;
  readonly copyNumber: number;
  readonly modified: boolean;
}

interface PromptGroupRecord extends Omit<PromptGroup, "skillPackId"> {
  readonly installationId: string;
}

interface PromptRecord
  extends Omit<
    PromptDefinition,
    "content" | "contentPath" | "skillPackId" | "id"
  > {
  readonly installationId: string;
  readonly promptId: string;
  readonly contentPath: string;
}

export interface PromptLibraryRegistry {
  readonly schemaVersion: typeof PROMPT_LIBRARY_SCHEMA_VERSION;
  readonly installations: readonly PromptPackRecord[];
  readonly groups: readonly PromptGroupRecord[];
  readonly prompts: readonly PromptRecord[];
}

const identitySchema = z.string().trim().min(1).max(240);
const stableIdSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i);
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

const promptScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("genres"),
      genres: z.array(z.string().trim().min(1)),
    })
    .strict(),
]);

const packRecordSchema = z
  .object({
    installationId: identitySchema,
    packageId: stableIdSchema,
    name: z.string().trim().min(1),
    source: z.enum(["builtin", "github", "project"]),
    repository: z.string().trim().min(1).optional(),
    version: semverSchema,
    enabled: z.boolean(),
    updatedAt: z.string(),
    description: z.string(),
    copyNumber: z.number().int().positive(),
    modified: z.boolean(),
  })
  .strict();

const groupRecordSchema = z
  .object({
    id: identitySchema,
    name: z.string().trim().min(1),
    description: z.string(),
    parentId: identitySchema.nullable(),
    nodeKind: z.enum(["pack-root", "directory"]),
    installationId: identitySchema,
    sourcePath: z.string(),
    userCreated: z.boolean(),
    modified: z.boolean(),
    enabled: z.boolean(),
    scope: promptScopeSchema,
  })
  .strict();

const promptContentPathSchema = z.string().transform((path, context) => {
  try {
    const normalized = normalizeWorkbenchStoragePath(path);
    if (
      !normalized.startsWith("prompts/installations/") ||
      !normalized.endsWith(".md")
    ) {
      context.addIssue({
        code: "custom",
        message: "提示词正文必须位于 prompts/installations/ 下并使用 .md",
      });
      return z.NEVER;
    }
    return normalized;
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});

const promptRecordSchema = z
  .object({
    instanceId: identitySchema,
    promptId: stableIdSchema,
    name: z.string().trim().min(1),
    groupId: identitySchema,
    version: semverSchema,
    enabled: z.boolean(),
    overridden: z.boolean(),
    installationId: identitySchema,
    scopeOverride: promptScopeSchema.nullable(),
    contentPath: promptContentPathSchema,
    sourcePath: z.string().optional(),
  })
  .strict();

export const promptLibraryRegistrySchema = z
  .object({
    schemaVersion: z.literal(PROMPT_LIBRARY_SCHEMA_VERSION),
    installations: z.array(packRecordSchema).min(1),
    groups: z.array(groupRecordSchema).min(1),
    prompts: z.array(promptRecordSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const installationIds = new Set<string>();
    const groupIds = new Set<string>();
    const instanceIds = new Set<string>();
    const contentPaths = new Set<string>();

    registry.installations.forEach((pack, index) => {
      if (installationIds.has(pack.installationId)) {
        context.addIssue({
          code: "custom",
          path: ["installations", index, "installationId"],
          message: "installationId 不得重复",
        });
      }
      installationIds.add(pack.installationId);
    });

    registry.groups.forEach((group, index) => {
      if (groupIds.has(group.id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "id"],
          message: "目录 id 不得重复",
        });
      }
      groupIds.add(group.id);
      if (!installationIds.has(group.installationId)) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "installationId"],
          message: "目录关联的安装副本不存在",
        });
      }
    });

    registry.groups.forEach((group, index) => {
      if (group.parentId === null) {
        if (group.nodeKind !== "pack-root") {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "nodeKind"],
            message: "只有技能包根节点可以没有父目录",
          });
        }
        return;
      }
      if (group.nodeKind === "pack-root") {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "nodeKind"],
          message: "技能包根节点不能挂在其他目录下",
        });
      }
      const parent = registry.groups.find((item) => item.id === group.parentId);
      if (!parent || parent.installationId !== group.installationId) {
        context.addIssue({
          code: "custom",
          path: ["groups", index, "parentId"],
          message: "父目录必须存在于同一安装副本",
        });
      }
      const visited = new Set([group.id]);
      let parentId: string | null = group.parentId;
      while (parentId !== null) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "parentId"],
            message: "目录树不得包含循环引用",
          });
          break;
        }
        visited.add(parentId);
        parentId =
          registry.groups.find((item) => item.id === parentId)?.parentId ??
          null;
      }
    });

    registry.installations.forEach((pack, index) => {
      const roots = registry.groups.filter(
        (group) =>
          group.installationId === pack.installationId &&
          group.parentId === null,
      );
      if (roots.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["installations", index, "installationId"],
          message: "每个安装副本必须且只能有一个根节点",
        });
      }
    });

    registry.prompts.forEach((prompt, index) => {
      if (instanceIds.has(prompt.instanceId)) {
        context.addIssue({
          code: "custom",
          path: ["prompts", index, "instanceId"],
          message: "instanceId 不得重复",
        });
      }
      instanceIds.add(prompt.instanceId);
      if (contentPaths.has(prompt.contentPath)) {
        context.addIssue({
          code: "custom",
          path: ["prompts", index, "contentPath"],
          message: "每个提示词必须使用独立 Markdown 文件",
        });
      }
      contentPaths.add(prompt.contentPath);
      const group = registry.groups.find((item) => item.id === prompt.groupId);
      if (!group || group.installationId !== prompt.installationId) {
        context.addIssue({
          code: "custom",
          path: ["prompts", index, "groupId"],
          message: "提示词目录必须存在于同一安装副本",
        });
      }
    });
  });

export class PromptLibraryFormatError extends Error {
  constructor(detail: string) {
    super(`${PROMPT_LIBRARY_REGISTRY_PATH} 格式错误：${detail}`);
    this.name = "PromptLibraryFormatError";
  }
}

export function parsePromptLibraryRegistry(
  content: string,
): PromptLibraryRegistry {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new PromptLibraryFormatError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const result = promptLibraryRegistrySchema.safeParse(value);
  if (!result.success) {
    throw new PromptLibraryFormatError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

export function serializePromptLibraryRegistry(
  registry: PromptLibraryRegistry,
): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function registryToPromptLibraryModel(
  registry: PromptLibraryRegistry,
  contents: ReadonlyMap<string, string>,
): PromptLibraryModel {
  return Object.freeze({
    packs: Object.freeze(
      registry.installations.map((pack) =>
        Object.freeze({
          id: pack.installationId,
          packageId: pack.packageId,
          name: pack.name,
          source: pack.source,
          ...(pack.repository ? { repository: pack.repository } : {}),
          version: pack.version,
          enabled: pack.enabled,
          updatedAt: pack.updatedAt,
          description: pack.description,
          copyNumber: pack.copyNumber,
          modified: pack.modified,
        }),
      ),
    ),
    groups: Object.freeze(
      registry.groups.map((group) => {
        const { installationId, ...rest } = group;
        return Object.freeze({ ...rest, skillPackId: installationId });
      }),
    ),
    prompts: Object.freeze(
      registry.prompts.map((prompt) => {
        const { installationId, promptId, ...rest } = prompt;
        return Object.freeze({
          ...rest,
          id: promptId,
          skillPackId: installationId,
          content: contents.get(prompt.instanceId) ?? "",
        });
      }),
    ),
  });
}
