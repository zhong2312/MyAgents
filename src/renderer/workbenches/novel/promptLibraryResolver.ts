import type {
  PromptDefinition,
  PromptGroup,
  PromptLibraryModel,
  PromptScope,
  PromptSkillPack,
} from "./promptLibrarySchema";

export interface PromptActivation {
  readonly prompt: PromptDefinition;
  readonly group: PromptGroup;
  readonly pack: PromptSkillPack;
  readonly effectiveScope: PromptScope;
  readonly scopeSource: "prompt" | "group";
  readonly active: boolean;
  readonly reason: string;
}

export interface PromptConflict {
  readonly promptId: string;
  readonly activations: readonly PromptActivation[];
}

export interface ResolvedPromptSet {
  readonly activations: readonly PromptActivation[];
  readonly conflicts: readonly PromptConflict[];
  readonly executable: readonly PromptActivation[];
  readonly excluded: readonly PromptActivation[];
}

export type PromptExecutionSelection =
  | { readonly status: "ready"; readonly activation: PromptActivation }
  | { readonly status: "missing"; readonly promptId: string }
  | {
      readonly status: "inactive";
      readonly promptId: string;
      readonly activations: readonly PromptActivation[];
    }
  | {
      readonly status: "conflict";
      readonly promptId: string;
      readonly activations: readonly PromptActivation[];
    };

function formatScope(scope: PromptScope): string {
  return scope.kind === "global"
    ? "全局"
    : scope.genres.length > 0
      ? scope.genres.join("、")
      : "未选择题材";
}

function scopesIntersect(
  scope: PromptScope,
  projectGenres: readonly string[],
): boolean {
  return (
    scope.kind === "global" ||
    scope.genres.some((genre) => projectGenres.includes(genre))
  );
}

function findDisabledGroupInLineage(
  group: PromptGroup,
  groups: readonly PromptGroup[],
): PromptGroup | null {
  const groupsById = new Map(
    groups.map((candidate) => [candidate.id, candidate]),
  );
  const visited = new Set<string>();
  let current: PromptGroup | undefined = group;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (!current.enabled) return current;
    current = current.parentId ? groupsById.get(current.parentId) : undefined;
  }
  return null;
}

export function resolvePromptActivation(
  prompt: PromptDefinition,
  groups: readonly PromptGroup[],
  packs: readonly PromptSkillPack[],
  projectGenres: readonly string[],
): PromptActivation {
  const group = groups.find((candidate) => candidate.id === prompt.groupId);
  if (!group) {
    throw new Error(`提示词 ${prompt.id} 引用了不存在的分组 ${prompt.groupId}`);
  }
  const pack = packs.find((candidate) => candidate.id === prompt.skillPackId);
  if (!pack) {
    throw new Error(
      `提示词 ${prompt.instanceId} 引用了不存在的安装副本 ${prompt.skillPackId}`,
    );
  }
  const effectiveScope = prompt.scopeOverride ?? group.scope;
  const scopeSource = prompt.scopeOverride ? "prompt" : "group";
  const base = { prompt, group, pack, effectiveScope, scopeSource } as const;

  if (!prompt.enabled) {
    return { ...base, active: false, reason: "提示词已停用" };
  }
  const disabledGroup = findDisabledGroupInLineage(group, groups);
  if (disabledGroup) {
    return {
      ...base,
      active: false,
      reason: `分组“${disabledGroup.name}”已停用`,
    };
  }
  if (!pack.enabled) {
    return {
      ...base,
      active: false,
      reason: `安装副本“${pack.name}”已停用`,
    };
  }
  if (!scopesIntersect(effectiveScope, projectGenres)) {
    return {
      ...base,
      active: false,
      reason: `作用域“${formatScope(effectiveScope)}”与当前题材不匹配`,
    };
  }
  return {
    ...base,
    active: true,
    reason:
      scopeSource === "prompt" ? "提示词作用域覆盖分组" : "继承分组作用域",
  };
}

export function detectPromptConflicts(
  activations: readonly PromptActivation[],
): readonly PromptConflict[] {
  const activeByPromptId = new Map<string, PromptActivation[]>();
  for (const activation of activations) {
    if (!activation.active) continue;
    const matches = activeByPromptId.get(activation.prompt.id) ?? [];
    matches.push(activation);
    activeByPromptId.set(activation.prompt.id, matches);
  }
  return Array.from(activeByPromptId.entries())
    .filter(([, matches]) => matches.length > 1)
    .map(([promptId, matches]) => ({ promptId, activations: matches }));
}

export function resolvePromptSet(
  model: PromptLibraryModel,
  projectGenres: readonly string[],
): ResolvedPromptSet {
  const activations = model.prompts.map((prompt) =>
    resolvePromptActivation(prompt, model.groups, model.packs, projectGenres),
  );
  const conflicts = detectPromptConflicts(activations);
  const conflictingIds = new Set(
    conflicts.flatMap((conflict) =>
      conflict.activations.map((activation) => activation.prompt.instanceId),
    ),
  );
  return {
    activations,
    conflicts,
    executable: activations.filter(
      (activation) =>
        activation.active && !conflictingIds.has(activation.prompt.instanceId),
    ),
    excluded: activations.filter(
      (activation) =>
        !activation.active || conflictingIds.has(activation.prompt.instanceId),
    ),
  };
}

export function selectPromptForExecution(
  resolved: ResolvedPromptSet,
  promptId: string,
): PromptExecutionSelection {
  const matches = resolved.activations.filter(
    (activation) => activation.prompt.id === promptId,
  );
  if (matches.length === 0) return { status: "missing", promptId };
  const active = matches.filter((activation) => activation.active);
  if (active.length === 0) {
    return { status: "inactive", promptId, activations: matches };
  }
  if (active.length > 1) {
    return { status: "conflict", promptId, activations: active };
  }
  return { status: "ready", activation: active[0]! };
}

const PROMPT_VARIABLE_PATTERN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const PROMPT_CONDITION_PATTERN =
  /\{\{#if\s+([A-Za-z][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;

export function renderPromptTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  const withConditions = template.replace(
    PROMPT_CONDITION_PATTERN,
    (_placeholder, name: string, block: string) =>
      variables[name]?.trim() ? block : "",
  );
  const missing = new Set<string>();
  const rendered = withConditions.replace(
    PROMPT_VARIABLE_PATTERN,
    (placeholder, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        missing.add(name);
        return placeholder;
      }
      return variables[name] ?? "";
    },
  );
  if (missing.size > 0) {
    throw new Error(`提示词缺少变量：${Array.from(missing).join("、")}`);
  }
  return rendered;
}
