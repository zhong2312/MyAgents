import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Message, ToolUseSimple } from "@/types/chat";
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
    onSelectSession?: (sessionId: string, title: string) => void;
    defaultExpanded?: boolean;
  }) => (
    <button
      type="button"
      data-testid="workspace-session-history"
      data-agent-dir={agentDir}
      data-current-session-id={currentSessionId}
      data-default-expanded={defaultExpanded}
      onClick={() => onSelectSession?.("session-history-1", "历史会话")}
    >
      小说历史会话
    </button>
  ),
}));

function message(
  content: Message["content"],
  attachments?: Message["attachments"],
): Message {
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
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-1",
                name: "Read",
                streamIndex: 0,
                input: { file_path: "F:/novels/demo/characters/hero.md" },
              },
            },
          ]),
          message("已读取", [
            {
              id: "file-1",
              name: "hero.md",
              size: 10,
              mimeType: "text/markdown",
              relativePath: "characters/hero.md",
            },
          ]),
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

  it("does not crash while a file tool is still missing its input", () => {
    render(
      <WorkbenchReferencePanel
        messages={[
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-streaming-read",
                name: "Read",
                streamIndex: 0,
              } as unknown as ToolUseSimple,
            },
          ]),
        ]}
      />,
    );

    expect(screen.getByText("引用资料")).toBeInTheDocument();
    expect(screen.getByText("AI 读取资料后会显示在这里")).toBeInTheDocument();
  });

  it("does not show failed file reads as reference materials", () => {
    render(
      <WorkbenchReferencePanel
        messages={[
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-failed-read",
                name: "Read",
                streamIndex: 0,
                input: { file_path: "F:/novels/demo/missing.md" },
                result: "File does not exist.",
                isError: true,
              },
            },
          ]),
        ]}
      />,
    );

    expect(screen.queryByText("F:/novels/demo/missing.md")).not.toBeInTheDocument();
    expect(screen.getByText("AI 读取资料后会显示在这里")).toBeInTheDocument();
  });

  it("does not show runtimes that report a failed read without an error flag", () => {
    render(
      <WorkbenchReferencePanel
        messages={[
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-unflagged-failed-read",
                name: "Read",
                streamIndex: 0,
                input: { file_path: "F:/novels/demo/missing.md" },
                result: "File does not exist. Note: your current working directory is C:\\workspace.",
              },
            },
          ]),
        ]}
      />,
    );

    expect(screen.queryByText("F:/novels/demo/missing.md")).not.toBeInTheDocument();
    expect(screen.getByText("AI 读取资料后会显示在这里")).toBeInTheDocument();
  });

  it("records novel workbench file IDs from context tool results and opens their details", () => {
    render(
      <WorkbenchReferencePanel
        workspacePath="F:/novels/demo"
        messages={[
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-world-1",
                name: "mcp__novel-workbench__novel_world_get_context",
                streamIndex: 0,
                input: { paths: ["world/setting-library/meta.json"] },
                result: JSON.stringify({
                  files: {
                    "world/setting-library/meta.json": '{"title":"测试世界"}',
                    "world/setting-library/settings.json": '{"settings":[]}',
                  },
                }),
              },
            },
          ]),
        ]}
      />,
    );

    expect(
      screen.getByText("world/setting-library/meta.json"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("world/setting-library/settings.json"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看资料详情：world/setting-library/meta.json",
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      '{"title":"测试世界"}',
    );
  });

  it("shows references from the active streaming tool message", () => {
    render(
      <WorkbenchReferencePanel
        workspacePath="F:/novels/demo"
        messages={[]}
        streamingMessage={message([
          {
            type: "tool_use",
            tool: {
              id: "tool-streaming-1",
              name: "mcp__novel-workbench__novel_inspiration_get_context",
              streamIndex: 0,
              input: { focusId: "idea-1" },
              result: JSON.stringify({
                sourcePath: "inspiration/library.json",
                data: { item: { id: "idea-1", title: "雨夜相逢" } },
              }),
            },
          },
        ])}
      />,
    );

    expect(screen.getByText("inspiration/library.json")).toBeInTheDocument();
    expect(screen.getByText(/ID: idea-1/)).toBeInTheDocument();
  });

  it("does not classify a failed context tool path as read content", () => {
    render(
      <WorkbenchReferencePanel
        workspacePath="F:/novels/demo"
        messages={[
          message([
            {
              type: "tool_use",
              tool: {
                id: "tool-error-1",
                name: "mcp__novel-workbench__novel_world_get_context",
                streamIndex: 0,
                input: { paths: ["world/cultivation-ecology.md"] },
                result: JSON.stringify({ error: "请改用修行体系工具" }),
                isError: true,
              },
            },
          ]),
        ]}
      />,
    );

    expect(screen.getByText("AI 读取资料后会显示在这里")).toBeInTheDocument();
    expect(
      screen.queryByText("world/cultivation-ecology.md"),
    ).not.toBeInTheDocument();
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
    expect(history).toHaveAttribute(
      "data-current-session-id",
      "session-current",
    );
    expect(history).toHaveAttribute("data-default-expanded", "false");
    history.click();
    expect(onSelectSession).toHaveBeenCalledWith("session-history-1", "历史会话");
  });

  it("opens the complete prompt in a dialog and closes with Escape", () => {
    render(
      <WorkbenchReferencePanel
        promptId="novel.characters.assist"
        promptTitle="人物设计"
        promptContent={
          "你是小说人物设计助手。\n\n必须保留已有事实，并输出可审阅的候选。"
        }
        messages={[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "查看完整提示词：人物设计" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "你是小说人物设计助手。",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "必须保留已有事实，并输出可审阅的候选。",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
