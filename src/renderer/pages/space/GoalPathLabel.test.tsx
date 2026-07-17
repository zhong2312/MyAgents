import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GoalPathLabel } from "./GoalPathLabel";

describe("GoalPathLabel", () => {
  it("renders a root goal as black text with normal weight", () => {
    render(<GoalPathLabel label="MyAgents社区" leafLabel="MyAgents社区" />);

    const label = screen.getByTitle("MyAgents社区");
    expect(label).toHaveClass("font-normal", "text-[var(--ink)]");
    expect(label).not.toHaveClass("font-semibold");
  });

  it("mutes the ancestor and keeps the leaf black without bolding it", () => {
    render(
      <GoalPathLabel
        label="MyAgents社区 / MyAgents BUGFIX"
        leafLabel="MyAgents BUGFIX"
      />,
    );

    const label = screen.getByTitle("MyAgents社区 / MyAgents BUGFIX");
    expect(within(label).getByText("MyAgents社区")).toHaveClass(
      "text-[var(--ink-muted)]/75",
    );
    const leaf = within(label).getByText("MyAgents BUGFIX");
    expect(leaf).toHaveClass("font-normal", "text-[var(--ink)]");
    expect(leaf).not.toHaveClass("font-semibold");
  });

  it("applies the same hierarchy to Cloud compact deep paths", () => {
    const fullLabel = "../MyAgents BUGFIX/Windows 系统兼容性优化";
    render(
      <GoalPathLabel
        label={fullLabel}
        leafLabel="Windows 系统兼容性优化"
      />,
    );

    const label = screen.getByTitle(fullLabel);
    expect(within(label).getByText("../MyAgents BUGFIX")).toHaveClass(
      "text-[var(--ink-muted)]/75",
    );
    expect(within(label).getByText("Windows 系统兼容性优化")).toHaveClass(
      "font-normal",
      "text-[var(--ink)]",
    );
  });

  it("does not split an ordinary goal title that contains a slash", () => {
    render(
      <GoalPathLabel label="Docs/API polish" leafLabel="Docs/API polish" />,
    );

    const label = screen.getByTitle("Docs/API polish");
    expect(label).toHaveTextContent("Docs/API polish");
    expect(label).toHaveClass("font-normal", "text-[var(--ink)]");
    expect(label.childElementCount).toBe(0);
  });

  it("uses the structured leaf when a root title contains path delimiters", () => {
    render(<GoalPathLabel label="Docs / API" leafLabel="Docs / API" />);

    const label = screen.getByTitle("Docs / API");
    expect(label).toHaveTextContent("Docs / API");
    expect(label.childElementCount).toBe(0);
  });

  it("keeps slashes inside a compact path leaf", () => {
    const fullLabel = "../Platform/Docs/API polish";
    render(
      <GoalPathLabel label={fullLabel} leafLabel="Docs/API polish" />,
    );

    const label = screen.getByTitle(fullLabel);
    expect(within(label).getByText("../Platform")).toHaveClass(
      "text-[var(--ink-muted)]/75",
    );
    expect(within(label).getByText("Docs/API polish")).toHaveClass(
      "font-normal",
      "text-[var(--ink)]",
    );
  });
});
