import { afterEach, describe, expect, it } from "vitest";

import {
  clearNovelWorkbenchContext,
  configureNovelWorkbenchRequest,
  isNovelWorkbenchToolAllowed,
  NOVEL_WORKBENCH_SDK_INSTRUCTIONS,
  novelWorkbenchToolDenyMessage,
  shouldBlockNovelWorkbenchTool,
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
      "novel_inspiration_get_context",
    ]) {
      expect(isNovelWorkbenchToolAllowed("manuscript", toolName)).toBe(true);
    }
    expect(
      isNovelWorkbenchToolAllowed("manuscript", "novel_narrative_submit_draft"),
    ).toBe(false);
  });

  it("allows ordinary command and file tools in a novel workbench session", () => {
    configureNovelWorkbenchRequest(
      {
        mode: "world",
        promptId: "novel.world.architecture",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-raw-read", workspace: "F:/novels/test" },
    );

    for (const toolName of [
      "Bash",
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "Agent",
    ]) {
      expect(shouldBlockNovelWorkbenchTool(toolName)).toBe(false);
    }
    expect(NOVEL_WORKBENCH_SDK_INSTRUCTIONS).toContain(
      "普通 SDK 命令和文件工具仍然可用",
    );
    expect(NOVEL_WORKBENCH_SDK_INSTRUCTIONS).toContain(
      "不得声称受控小说工作台会话没有文件系统访问权限",
    );
  });

  it("keeps novel domain writes scoped without blocking ordinary tools", () => {
    configureNovelWorkbenchRequest(
      {
        mode: "world",
        promptId: "novel.world.architecture",
        promptVersion: "1.0.0",
      },
      { sessionId: "session-domain-write", workspace: "F:/novels/test" },
    );

    const crossDomainWrite =
      "mcp__novel-workbench__novel_cultivation_submit_draft";
    expect(shouldBlockNovelWorkbenchTool(crossDomainWrite)).toBe(true);
    expect(novelWorkbenchToolDenyMessage(crossDomainWrite)).toContain(
      "跨领域写入",
    );
    expect(
      shouldBlockNovelWorkbenchTool(
        "mcp__novel-workbench__novel_cultivation_get_context",
      ),
    ).toBe(false);
  });
});
