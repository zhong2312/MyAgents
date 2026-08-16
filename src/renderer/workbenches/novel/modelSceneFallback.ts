import type { WorkbenchModelSelection } from "@/workbench-sdk";

import type { ModelSceneSettings, NovelModelSceneId } from "./modelSceneSettings";

export function modelSelectionsEqual(
  left: WorkbenchModelSelection | undefined,
  right: WorkbenchModelSelection | undefined,
): boolean {
  return (
    left?.providerId === right?.providerId && left?.model === right?.model
  );
}

export function modelUnavailableErrorMessage(cause: unknown): string | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  const indicators = [
    "selected model",
    "may not exist",
    "may not have access",
    "model_not_found",
    "model_not_available",
    "model does not exist",
    "model not found",
    "model unavailable",
    "场景绑定的模型当前不可用",
    "模型不存在",
    "模型不可用",
    "无权访问模型",
    "没有权限访问模型",
  ];
  return indicators.some((indicator) => normalized.includes(indicator))
    ? message
    : null;
}

export function withoutSceneModelBinding(
  settings: ModelSceneSettings,
  sceneId: NovelModelSceneId,
): ModelSceneSettings {
  const { [sceneId]: _, ...bindings } = settings.bindings;
  return {
    schemaVersion: settings.schemaVersion,
    ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
    bindings,
  };
}

export function withoutUnavailableModelSelection(
  settings: ModelSceneSettings,
  sceneId: NovelModelSceneId,
  unavailable: WorkbenchModelSelection,
): ModelSceneSettings {
  const { [sceneId]: sceneBinding, ...remainingBindings } = settings.bindings;
  const bindings = modelSelectionsEqual(sceneBinding, unavailable)
    ? remainingBindings
    : settings.bindings;
  const defaultModel = modelSelectionsEqual(settings.defaultModel, unavailable)
    ? undefined
    : settings.defaultModel;
  return {
    schemaVersion: settings.schemaVersion,
    ...(defaultModel ? { defaultModel } : {}),
    bindings,
  };
}

export interface ModelFallbackCandidate {
  readonly selection: WorkbenchModelSelection | undefined;
  readonly source: "scene" | "project-default" | "host-default";
}

export function unavailableModelFallbackCandidates(input: {
  readonly settings: ModelSceneSettings;
  readonly sceneId: NovelModelSceneId;
  readonly attemptedSelection: WorkbenchModelSelection | undefined;
  readonly hasExplicitOverride: boolean;
}): readonly ModelFallbackCandidate[] {
  const sceneSelection = getSceneSelection(input.settings, input.sceneId);
  const candidates: ModelFallbackCandidate[] = [];
  const add = (
    selection: WorkbenchModelSelection | undefined,
    source: ModelFallbackCandidate["source"],
  ) => {
    if (
      modelSelectionsEqual(selection, input.attemptedSelection) ||
      candidates.some((candidate) =>
        modelSelectionsEqual(candidate.selection, selection),
      )
    ) {
      return;
    }
    candidates.push({ selection, source });
  };

  if (input.hasExplicitOverride) {
    add(
      sceneSelection,
      input.settings.bindings[input.sceneId] ? "scene" : "project-default",
    );
  }
  add(input.settings.defaultModel, "project-default");
  add(undefined, "host-default");
  return candidates;
}

function getSceneSelection(
  settings: ModelSceneSettings,
  sceneId: NovelModelSceneId,
): WorkbenchModelSelection | undefined {
  return settings.bindings[sceneId] ?? settings.defaultModel;
}
