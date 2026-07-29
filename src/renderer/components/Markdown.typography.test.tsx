import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import Markdown from "./Markdown";

const markdownStyles = readFileSync(
  resolve(process.cwd(), "src/renderer/components/Markdown.css"),
  "utf8",
);

describe("Markdown typography contract", () => {
  it("uses one default rhythm for normal chat and document rendering", () => {
    const { container } = render(
      <Markdown raw>
        {[
          "# Release notes",
          "",
          "A paragraph with **important context**.",
          "",
          "- First item",
          "- Second item",
          "  - Nested item",
          "",
          "> Quoted guidance",
          "",
          "| Name | State |",
          "| --- | --- |",
          "| Renderer | Ready |",
        ].join("\n")}
      </Markdown>,
    );

    const root = container.querySelector(".markdown-content");
    expect(root).toBeInTheDocument();
    expect(root).not.toHaveClass("markdown-content--compact");
    expect(root?.querySelector("h1")).toHaveClass(
      "markdown-heading",
      "markdown-h1",
    );
    expect(root?.querySelector("p")).toHaveClass("markdown-paragraph");
    expect(root?.querySelector("strong")).toHaveClass("markdown-strong");
    expect(root?.querySelector("ul")).toHaveClass(
      "markdown-list",
      "markdown-list-unordered",
    );
    expect(root?.querySelector("li")).toHaveClass("markdown-list-item");
    expect(root?.querySelector("blockquote")).toHaveClass(
      "markdown-blockquote",
    );
    expect(root?.querySelector("table")?.parentElement).toHaveClass(
      "markdown-table",
    );
  });

  it("makes compact a whole-system density variant", () => {
    const { container } = render(
      <Markdown compact raw>
        {"## Compact heading\n\nCompact paragraph.\n\n1. First\n2. Second"}
      </Markdown>,
    );

    expect(container.querySelector(".markdown-content")).toHaveClass(
      "markdown-content--compact",
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content--compact\s*\{[\s\S]*?--markdown-font-size:\s*var\(--text-sm\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content--compact\s*\{[\s\S]*?--markdown-line-height:\s*1\.55/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content--compact\s*\{[\s\S]*?--markdown-list-item-gap:\s*var\(--space-1\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content--compact\s*\{[\s\S]*?--markdown-list-indent:\s*var\(--space-6\)/,
    );
  });

  it("pins the default readable-but-clustered rhythm", () => {
    expect(markdownStyles).toMatch(
      /\.markdown-content\s*\{[\s\S]*?--markdown-line-height:\s*1\.625/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content\s*\{[\s\S]*?--markdown-flow-gap:\s*var\(--space-3\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content\s*\{[\s\S]*?--markdown-list-block-gap:\s*var\(--space-2\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content\s*\{[\s\S]*?--markdown-list-item-gap:\s*var\(--space-1-5\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-content\s*\{[\s\S]*?--markdown-list-indent:\s*var\(--space-8\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-list\s*\{[\s\S]*?margin-inline-start:\s*var\(--markdown-list-indent\)/,
    );
    expect(markdownStyles).toMatch(
      /\.markdown-strong\s*\{[\s\S]*?font-weight:\s*600/,
    );
  });

  it("preserves GFM task-list classes so checkboxes replace list markers", () => {
    const { container } = render(
      <Markdown raw>
        {"- [x] Typography reviewed\n- [ ] Visual QA pending"}
      </Markdown>,
    );

    const list = container.querySelector("ul");
    const items = container.querySelectorAll("li");
    expect(list).toHaveClass("markdown-list", "contains-task-list");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveClass("markdown-list-item", "task-list-item");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
  });
});
