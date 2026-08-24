import { describe, expect, it } from "vitest";

import {
  buildChatFlipPatch,
  buildHistoryChatFlipPatch,
  createNewTab,
  type Tab,
} from "./tab";

describe("buildChatFlipPatch — chat-flip invariants (instant-nav D1)", () => {
  const base: Tab = { ...createNewTab(), id: "tab-1" };

  it("flips view to chat and always carries a truthy sessionId (D1)", () => {
    const patch = buildChatFlipPatch(base, {
      agentDir: "/ws/a",
      sessionId: "pending-tab-1",
      title: "A",
      sidecarConfigDisposition: "push",
    });
    expect(patch.view).toBe("chat");
    expect(patch.sessionId).toBe("pending-tab-1");
    expect(patch.sessionId).toBeTruthy(); // D1: never null → SSE connect effect fires
    expect(patch.agentDir).toBe("/ws/a");
    expect(patch.title).toBe("A");
  });

  it("preserves unrelated tab fields (id, isGenerating, hasUnread)", () => {
    const patch = buildChatFlipPatch(
      { ...base, isGenerating: true, hasUnread: true },
      {
        agentDir: "/ws/a",
        sessionId: "s1",
        title: "A",
        sidecarConfigDisposition: "push",
      },
    );
    expect(patch.id).toBe("tab-1");
    expect(patch.isGenerating).toBe(true);
    expect(patch.hasUnread).toBe(true);
  });

  it("omits initialMessage when not provided (no undefined clobber)", () => {
    const patch = buildChatFlipPatch(
      { ...base, initialMessage: { text: "keep" } },
      {
        agentDir: "/ws/a",
        sessionId: "s1",
        title: "A",
        sidecarConfigDisposition: "push",
      },
    );
    // Not provided → the key is not written, so a prior value survives.
    expect(patch.initialMessage).toEqual({ text: "keep" });
  });

  it("attaches initialMessage when provided", () => {
    const patch = buildChatFlipPatch(base, {
      agentDir: "/ws/a",
      sessionId: "s1",
      title: "A",
      initialMessage: { text: "hi" },
      sidecarConfigDisposition: "push",
    });
    expect(patch.initialMessage).toEqual({ text: "hi" });
  });

  it("requires and sets sidecarConfigDisposition (push | adopt | pending)", () => {
    for (const d of ["push", "adopt", "pending"] as const) {
      const patch = buildChatFlipPatch(base, {
        agentDir: "/ws/a",
        sessionId: "s1",
        title: "A",
        sidecarConfigDisposition: d,
      });
      expect(patch.sidecarConfigDisposition).toBe(d);
    }
  });

  it("OVERWRITES a stale prior disposition (config-stomping guard)", () => {
    // A reused tab may carry a prior 'adopt'/'pending'. The flip MUST overwrite it
    // with the flip's value — otherwise a new-session 'push' flip on a tab that had
    // adopted a sidecar would wrongly keep 'adopt' → Chat skips MCP/agents/model push
    // and adopts disk config over the user's picks (#300/#301 config-stomp class).
    const patch = buildChatFlipPatch(
      { ...base, sidecarConfigDisposition: "adopt" },
      {
        agentDir: "/ws/a",
        sessionId: "s1",
        title: "A",
        sidecarConfigDisposition: "push",
      },
    );
    expect(patch.sidecarConfigDisposition).toBe("push");
  });

  it("createNewTab defaults disposition to push (benign launcher default)", () => {
    expect(createNewTab().sidecarConfigDisposition).toBe("push");
  });

  it("clears source-session runtime state when replacing a workbench surface with history", () => {
    const source: Tab = {
      ...base,
      view: "chat",
      sessionId: "workbench-source",
      title: "工作台任务",
      isGenerating: true,
      hasUnread: true,
      initialMessage: { text: "不应发送到历史会话" },
      pendingFilePreview: { id: "preview-1", path: "manuscript/chapter-01.md" },
      sessionHistoryGroupPath: ["小说提示词库", "审查"],
      workbenchAgentSurface: {
        presentation: "dialog",
        sourceTabId: "novel-workbench-tab",
        workbenchId: "io.myagents.novel",
        workspacePath: "/ws/a",
        conversationKey: "review-1",
      },
    };

    const patch = buildHistoryChatFlipPatch(source, {
      agentDir: "/ws/a",
      sessionId: "persisted-history",
      title: "已保存的历史会话",
      sidecarConfigDisposition: "pending",
    });

    expect(patch).toMatchObject({
      id: "tab-1",
      view: "chat",
      agentDir: "/ws/a",
      sessionId: "persisted-history",
      title: "已保存的历史会话",
      sidecarConfigDisposition: "pending",
      isGenerating: false,
      hasUnread: false,
    });
    for (const field of [
      "workbenchAgentSurface",
      "sessionHistoryGroupPath",
      "initialMessage",
      "pendingFilePreview",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(patch, field)).toBe(false);
    }
  });
});
