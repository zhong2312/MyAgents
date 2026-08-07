import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkspaceSessionHistory from "./WorkspaceSessionHistory";

describe("WorkspaceSessionHistory", () => {
  it("使用正确的本地化标题并支持默认收起", () => {
    render(
      <WorkspaceSessionHistory
        agentDir="F:/novels/demo"
        defaultExpanded={false}
      />,
    );

    const toggle = screen.getByRole("button", { name: "工作区历史记录" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("history.title")).not.toBeInTheDocument();
  });
});
