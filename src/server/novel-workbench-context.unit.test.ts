import { afterEach, describe, expect, it } from "vitest";

import {
  clearNovelWorkbenchContext,
  configureNovelWorkbenchRequest,
  isNovelWorkbenchToolAllowed,
} from "./novel-workbench-context";

describe("novel manuscript workbench context", () => {
  afterEach(() => clearNovelWorkbenchContext());

  it("allows manuscript proposals and every supported cross-domain read", () => {
    configureNovelWorkbenchRequest(
      {
        mode: "manuscript",
        promptId: "novel.manuscript.generate",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-1", workspace: "F:/novels/test" },
    );

    expect(
      isNovelWorkbenchToolAllowed(
        "manuscript",
        "mcp__novel-workbench__novel_manuscript_submit_draft",
      ),
    ).toBe(true);
    for (const toolName of [
      "novel_world_get_context",
      "novel_narrative_get_context",
      "novel_timeline_get_context",
      "novel_items_get_context",
      "novel_characters_get_context",
      "novel_cultivation_get_context",
      "novel_factions_get_context",
      "novel_continuity_get_context",
    ]) {
      expect(isNovelWorkbenchToolAllowed("manuscript", toolName)).toBe(true);
    }
    expect(
      isNovelWorkbenchToolAllowed(
        "manuscript",
        "novel_narrative_submit_draft",
      ),
    ).toBe(false);
  });
});
