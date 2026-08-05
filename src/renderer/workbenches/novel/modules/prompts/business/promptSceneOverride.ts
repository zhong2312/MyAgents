import type { WorkbenchStorage } from "@/workbench-sdk";

import { createNovelPromptLibraryRepository } from "../data-access/promptLibraryRepository";
import {
  renderPromptTemplate,
  resolvePromptSet,
  selectPromptForExecution,
} from "./promptLibraryResolver";

export type ScenePromptOverride =
  | { readonly status: "ready"; readonly content: string }
  | { readonly status: "fallback" };

/**
 * 解析某 AI 场景的自定义提示词。
 *
 * - 提示词库中该 promptId 存在且启用 → 渲染模板返回 ready；
 * - 未定义（missing）或已停用（inactive）→ fallback，调用方继续使用内置提示词；
 * - 存在多个启用副本（conflict）→ 抛错，要求作者先解决冲突。
 */
export async function resolveScenePromptOverride(
  storage: WorkbenchStorage,
  promptId: string,
  projectGenres: readonly string[],
  variables: Readonly<Record<string, string>>,
): Promise<ScenePromptOverride> {
  const promptLibrary = await createNovelPromptLibraryRepository(storage).load();
  const selection = selectPromptForExecution(
    resolvePromptSet(promptLibrary.model, projectGenres),
    promptId,
  );
  if (selection.status === "missing") return { status: "fallback" };
  if (selection.status === "inactive") return { status: "fallback" };
  if (selection.status === "conflict") {
    throw new Error(
      `场景“${promptId}”存在多个启用副本，请先在提示词管理中解决冲突`,
    );
  }
  return {
    status: "ready",
    content: renderPromptTemplate(
      selection.activation.prompt.content,
      variables,
    ),
  };
}
