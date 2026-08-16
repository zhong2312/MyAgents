import { describe, expect, it } from "vitest";

import { parseModelSceneSettings } from "./modelSceneSettings";
import {
  modelUnavailableErrorMessage,
  unavailableModelFallbackCandidates,
  withoutUnavailableModelSelection,
  withoutSceneModelBinding,
} from "./modelSceneFallback";

describe("小说模型场景失效回退", () => {
  it("识别模型不存在或无权限的服务错误", () => {
    expect(
      modelUnavailableErrorMessage(
        new Error(
          "Claude Code returned an error result: The selected model may not exist or you may not have access.",
        ),
      ),
    ).toContain("selected model");
    expect(modelUnavailableErrorMessage(new Error("请求超时"))).toBeNull();
  });

  it("只移除失效场景的绑定，保留项目默认模型和其他场景", () => {
    const settings = parseModelSceneSettings(
      "settings/ai-model-scenes.json",
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: { providerId: "volcengine", model: "doubao" },
        bindings: {
          "manuscript.brainstorm.agent1": {
            providerId: "openrouter",
            model: "deepseek-v3.2",
          },
          "manuscript.brainstorm.synthesis": {
            providerId: "openrouter",
            model: "qwen3",
          },
        },
      }),
    );

    expect(
      withoutSceneModelBinding(settings, "manuscript.brainstorm.agent1"),
    ).toEqual({
      schemaVersion: 1,
      defaultModel: { providerId: "volcengine", model: "doubao" },
      bindings: {
        "manuscript.brainstorm.synthesis": {
          providerId: "openrouter",
          model: "qwen3",
        },
      },
    });
  });

  it("失效模型会同时从当前场景和项目默认模型中移除", () => {
    const settings = parseModelSceneSettings(
      "settings/ai-model-scenes.json",
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: { providerId: "openrouter", model: "deepseek-v3.2" },
        bindings: {
          "manuscript.brainstorm.agent1": {
            providerId: "openrouter",
            model: "deepseek-v3.2",
          },
          "manuscript.brainstorm.agent2": {
            providerId: "volcengine",
            model: "doubao",
          },
        },
      }),
    );

    expect(
      withoutUnavailableModelSelection(settings, "manuscript.brainstorm.agent1", {
        providerId: "openrouter",
        model: "deepseek-v3.2",
      }),
    ).toEqual({
      schemaVersion: 1,
      bindings: {
        "manuscript.brainstorm.agent2": {
          providerId: "volcengine",
          model: "doubao",
        },
      },
    });
  });

  it("本次指定模型失效时，优先回退场景模型，再回退主模型", () => {
    const settings = parseModelSceneSettings(
      "settings/ai-model-scenes.json",
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: { providerId: "volcengine", model: "doubao" },
        bindings: {
          "manuscript.brainstorm.agent1": {
            providerId: "openrouter",
            model: "qwen3",
          },
        },
      }),
    );

    expect(
      unavailableModelFallbackCandidates({
        settings,
        sceneId: "manuscript.brainstorm.agent1",
        attemptedSelection: { providerId: "anthropic", model: "claude" },
        hasExplicitOverride: true,
      }),
    ).toEqual([
      {
        selection: { providerId: "openrouter", model: "qwen3" },
        source: "scene",
      },
      {
        selection: { providerId: "volcengine", model: "doubao" },
        source: "project-default",
      },
      { selection: undefined, source: "host-default" },
    ]);
  });
});
