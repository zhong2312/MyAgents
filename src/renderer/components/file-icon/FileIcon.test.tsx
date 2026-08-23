// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileIcon } from "./FileIcon";

describe("FileIcon", () => {
  it("renders a fixed-size decorative local asset by default", () => {
    const { container } = render(<FileIcon name="report.pdf" size="regular" />);
    const icon = container.querySelector("img");

    expect(icon).toHaveAttribute("alt", "");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveAttribute("width", "20");
    expect(icon).toHaveAttribute("height", "20");
    expect(icon).toHaveAttribute("data-file-icon-id", "pdf");
    expect(icon?.getAttribute("src")).not.toMatch(/^https?:/);
  });

  it("supports an accessible label when the icon stands alone", () => {
    render(<FileIcon name="report.pdf" label="PDF 文件" />);

    expect(screen.getByRole("img", { name: "PDF 文件" })).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("uses the expanded folder asset without consumer branching", () => {
    const { container } = render(
      <FileIcon name="docs" nodeKind="directory" expanded />,
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "data-file-icon-id",
      "folder-open",
    );
  });
});
