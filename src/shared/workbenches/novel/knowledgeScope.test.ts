import { describe, expect, it } from "vitest";

import {
  isKnowledgeSourcePath,
  normalizeKnowledgePath,
} from "./knowledgeScope";

describe("knowledge source scope", () => {
  it("keeps renderer and server on the same formal fact boundary", () => {
    expect(isKnowledgeSourcePath("characters/index.json")).toBe(true);
    expect(isKnowledgeSourcePath("world/setting-library/pages/a.md")).toBe(true);
    expect(isKnowledgeSourcePath("knowledge/derived/graph.json")).toBe(false);
    expect(isKnowledgeSourcePath("proposals/character.json")).toBe(false);
    expect(isKnowledgeSourcePath("world/factions/proposals/a.json")).toBe(false);
    expect(isKnowledgeSourcePath("trash/old.md")).toBe(false);
    expect(isKnowledgeSourcePath("simulation/runs/run-1.json")).toBe(false);
  });

  it("normalizes Windows paths before applying scope rules", () => {
    expect(normalizeKnowledgePath(".\\characters\\index.json")).toBe(
      "characters/index.json",
    );
    expect(isKnowledgeSourcePath(".\\proposals\\draft.json")).toBe(false);
  });
});
