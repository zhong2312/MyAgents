import { describe, expect, it } from "vitest";

import {
  getEffectiveModelSceneSelection,
  NOVEL_MODEL_SCENES,
  parseModelSceneSettings,
} from "./modelSceneSettings";

describe("novel model scene selection", () => {
  it("registers the world simulation one-shot scene", () => {
    expect(NOVEL_MODEL_SCENES).toContainEqual(
      expect.objectContaining({
        id: "simulation.advance",
        execution: "run",
      }),
    );
  });

  it("uses the manuscript scene binding before the novel default model", () => {
    const settings = parseModelSceneSettings(
      "settings/ai-model-scenes.json",
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: {
          providerId: "volcengine",
          model: "deepseek-v4-flash-260425",
        },
        bindings: {
          "manuscript.generate": {
            providerId: "openrouter",
            model: "anthropic/claude-sonnet-4",
          },
        },
      }),
    );

    expect(
      getEffectiveModelSceneSelection(settings, "manuscript.generate"),
    ).toEqual({
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("falls back to the novel default model for an unbound manuscript scene", () => {
    const settings = parseModelSceneSettings(
      "settings/ai-model-scenes.json",
      JSON.stringify({
        schemaVersion: 1,
        defaultModel: {
          providerId: "volcengine",
          model: "deepseek-v4-flash-260425",
        },
        bindings: {},
      }),
    );

    expect(
      getEffectiveModelSceneSelection(settings, "manuscript.continue"),
    ).toEqual({
      providerId: "volcengine",
      model: "deepseek-v4-flash-260425",
    });
  });
});
