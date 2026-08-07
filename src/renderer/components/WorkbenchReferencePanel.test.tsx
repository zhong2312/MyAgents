import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/types/chat";
import WorkbenchReferencePanel from "./WorkbenchReferencePanel";

vi.mock("@/components/directory-panel/WorkspaceSessionHistory", () => ({
  default: ({
    agentDir,
    currentSessionId,
    onSelectSession,
    defaultExpanded,
  }: {
    agentDir: string;
    currentSessionId?: string | null;
    onSelectSession?: (sessionId: string) => void;
    defaultExpanded?: boolean;
  }) => (
    <button
      type="button"
      data-testid="workspace-session-history"
      data-agent-dir={agentDir}
      data-current-session-id={currentSessionId}
      data-default-expanded={defaultExpanded}
      onClick={() => onSelectSession?.("session-history-1")}
    >
      小说历史会话
    </button>
  ),
}));

function message(content: Message["content"], attachments?: Message["attachments"]): Message {
  return {
    id: "message-1",
    role: "assistant",
    content,
    timestamp: new Date("2026-08-06T00:00:00Z"),
    attachments,
  };
}

describe("WorkbenchReferencePanel", () => {
  it("shows the bound prompt and deduplicated file references", () => {
    render(
      <WorkbenchReferencePanel
        promptId="novel.characters.assist"
        promptTitle="人物设计"
        workspacePath="F:/novels/demo"
        messages={[
          message([{ type: "tool_use", tool: { id: "tool-1", name: "Read", streamIndex: 0, input: { file_path: "F:/novels/demo/characters/hero.md" } } }]),
          message("已读取", [{ id: "file-1", name: "hero.md", size: 10, mimeType: "text/markdown", relativePath: "characters/hero.md" }]),
        ]}
      />,
    );

    expect(screen.getByText("人物设计")).toBeInTheDocument();
    expect(screen.getByText("novel.characters.assist")).toBeInTheDocument();
    expect(screen.getByText("characters/hero.md")).toBeInTheDocument();
    expect(screen.getByText("引用 2 次")).toBeInTheDocument();
    expect(screen.queryByText("对话")).not.toBeInTheDocument();
    expect(screen.getByText("引用资料")).toBeInTheDocument();
  });

  it("keeps empty sections explicit before references arrive", () => {
    render(<WorkbenchReferencePanel messages={[]} />);

    expect(screen.getByText("本会话尚未绑定提示词")).toBeInTheDocument();
    expect(screen.getByText("AI 读取资料后会显示在这里")).toBeInTheDocument();
  });

  it("retains the current novel's grouped session history and selection callback", () => {
    const onSelectSession = vi.fn();
    render(
      <WorkbenchReferencePanel
        messages={[]}
        workspacePath="F:/novels/demo"
        currentSessionId="session-current"
        onSelectSession={onSelectSession}
      />,
    );

    const history = screen.getByTestId("workspace-session-history");
    expect(history).toHaveAttribute("data-agent-dir", "F:/novels/demo");
    expect(history).toHaveAttribute("data-current-session-id", "session-current");
    expect(history).toHaveAttribute("data-default-expanded", "false");
    history.click();
    expect(onSelectSession).toHaveBeenCalledWith("session-history-1");
  });

  it("opens the complete prompt in a dialog and closes with Escape", () => {
    render(
      <WorkbenchReferencePanel
        promptId="novel.characters.assist"
        promptTitle="人物设计"
        promptContent={'你是小说人物设计助手。\n\n必须保留已有事实，并输出可审阅的候选。'}
        messages={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看完整提示词：人物设计" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("你是小说人物设计助手。");
    expect(screen.getByRole("dialog")).toHaveTextContent("必须保留已有事实，并输出可审阅的候选。");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
