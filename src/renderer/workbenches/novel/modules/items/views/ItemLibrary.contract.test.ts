import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../../../..");

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("物品库提案审阅入口", () => {
  it("使用统一的图标加文字次级按钮样式", () => {
    const library = source(
      "src/renderer/workbenches/novel/modules/items/views/ItemLibrary.tsx",
    );

    expect(library).toContain('aria-label="审阅物品提案"');
    expect(library).toContain('title="审阅 AI 提交的物品提案"');
    expect(library).toContain(
      "flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] px-2.5 text-sm font-medium text-[var(--ink-muted)]",
    );
    expect(library).toContain(
      '<span className="max-lg:hidden">审阅提案</span>',
    );
  });
});
