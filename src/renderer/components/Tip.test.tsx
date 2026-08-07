import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Tip from "./Tip";

describe("Tip", () => {
  it("portals an immediate theme-owned tooltip above clipped surfaces", () => {
    render(
      <Tip label="任务" position="right">
        <button type="button">trigger</button>
      </Tip>,
    );

    const trigger = screen.getByRole("button", { name: "trigger" });
    expect(screen.queryByRole("tooltip", { name: "任务" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger.parentElement!);

    const tooltip = screen.getByRole("tooltip", { name: "任务" });
    expect(tooltip).toHaveClass(
      "bg-[var(--button-dark-bg)]/90",
      "text-[var(--button-dark-text)]",
    );
    expect(tooltip).not.toHaveClass("delay-500", "transition-opacity");
    expect(trigger.parentElement).not.toContainElement(tooltip);
    expect(tooltip.parentElement).toHaveStyle({ zIndex: "280" });
  });

  it("suppresses its label while the trigger owns an open popover", () => {
    render(
      <Tip label="更多" disabled>
        <button type="button">trigger</button>
      </Tip>,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "trigger" }).parentElement!);

    expect(
      screen.queryByRole("tooltip", { name: "更多" }),
    ).not.toBeInTheDocument();
  });

  it("stays visible while either hover or focus remains active", () => {
    render(
      <Tip label="组合状态">
        <button type="button">trigger</button>
      </Tip>,
    );

    const trigger = screen.getByRole("button", { name: "trigger" });
    const wrapper = trigger.parentElement!;

    fireEvent.focus(trigger);
    fireEvent.mouseEnter(wrapper);
    fireEvent.mouseLeave(wrapper);
    expect(screen.getByRole("tooltip", { name: "组合状态" })).toBeInTheDocument();

    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip", { name: "组合状态" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(wrapper);
    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    expect(screen.getByRole("tooltip", { name: "组合状态" })).toBeInTheDocument();

    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole("tooltip", { name: "组合状态" })).not.toBeInTheDocument();
  });
});
