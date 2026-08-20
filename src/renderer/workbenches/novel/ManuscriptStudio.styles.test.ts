import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  resolve(import.meta.dirname, "ManuscriptStudio.css"),
  "utf8",
);

describe("正文工作台样式契约", () => {
  it("只在差异标题栏设置 span 和 strong，避免覆盖 Monaco 正文 token", () => {
    expect(styles).not.toContain(".ms-room-inline-diff span");
    expect(styles).not.toContain(".ms-room-inline-diff strong");
    expect(styles).toContain(".ms-room-inline-diff > header span");
    expect(styles).toContain(".ms-room-inline-diff > header strong");
  });

  it("桌面右侧栏增加百分之三十并同步避让即时 AI 候选", () => {
    expect(styles).toContain(
      "grid-template-columns: 17rem minmax(0, 1fr) 23.4rem",
    );
    expect(styles).toContain(
      "grid-template-columns: 15rem minmax(0, 1fr) 22.1rem",
    );
    expect(styles).toContain(
      "grid-template-columns: 14rem minmax(0, 1fr) 20.8rem",
    );
    expect(styles).toContain("right: calc(23.4rem + 0.75rem)");
    expect(styles).toContain("right: 22.85rem");
    expect(styles).toContain("right: 21.55rem");
  });

  it("正文提炼按钮在左栏内边距容器中铺满且不越过分栏", () => {
    expect(styles).toContain(".ms-extraction-run-action {");
    expect(styles).toContain("padding: 0.75rem 1rem 1rem;");
    expect(styles).toContain(".ms-extraction-run-action > .ns-button {");
    expect(styles).not.toContain(".ms-extraction-sources > .ns-button {");
  });
});
