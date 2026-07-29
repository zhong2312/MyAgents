import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Tip from "./Tip";

describe("Tip", () => {
  it("renders an immediate theme-owned tooltip beside rail controls", () => {
    render(
      <Tip label="任务" position="right">
        <button type="button">trigger</button>
      </Tip>,
    );

    const tooltip = screen.getByRole("tooltip", { name: "任务" });
    expect(tooltip).toHaveClass(
      "left-full",
      "top-1/2",
      "bg-[var(--button-dark-bg)]/90",
      "text-[var(--button-dark-text)]",
      "group-hover/tip:opacity-100",
      "group-focus-within/tip:opacity-100",
    );
    expect(tooltip).not.toHaveClass("delay-500", "transition-opacity");
  });

  it("suppresses its label while the trigger owns an open popover", () => {
    render(
      <Tip label="更多" disabled>
        <button type="button">trigger</button>
      </Tip>,
    );

    expect(
      screen.queryByRole("tooltip", { name: "更多" }),
    ).not.toBeInTheDocument();
  });
});
