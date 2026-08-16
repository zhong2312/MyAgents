import { describe, expect, it } from "vitest";
import {
  sanitizeCompleteThinkingText,
  ThinkingDeltaNormalizer,
} from "./thinking-delta-normalizer";

describe("ThinkingDeltaNormalizer", () => {
  it("preserves ordinary suffix deltas", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(0);

    expect(normalizer.push(0, "先读取设定。").delta).toBe("先读取设定。");
    expect(normalizer.push(0, "再生成草稿。").delta).toBe("再生成草稿。");
  });

  it("converts cumulative provider snapshots into suffix deltas", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(0);
    const first = "先";
    const second = `${first}读取设定`;
    const third = `${second}，再生成草稿。`;

    expect(normalizer.push(0, first).delta).toBe(first);
    expect(normalizer.push(0, second).delta).toBe("");
    expect(normalizer.push(0, third).delta).toBe("读取设定，再生成草稿。");
    expect(normalizer.push(0, third).delta).toBe("");
    expect(normalizer.push(0, `${third}完成`).delta).toBe("完成");
  });

  it("releases a false snapshot probe without losing ordinary deltas", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(0);

    expect(normalizer.push(0, "计划").delta).toBe("计划");
    expect(normalizer.push(0, "计划下一步").delta).toBe("");
    expect(normalizer.push(0, "，然后执行。").delta).toBe(
      "计划下一步，然后执行。",
    );
  });

  it("flushes an ambiguous two-frame probe when the block ends", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(0);

    expect(normalizer.push(0, "重复").delta).toBe("重复");
    expect(normalizer.push(0, "重复内容").delta).toBe("");
    expect(normalizer.finish(0).delta).toBe("重复内容");
  });

  it("strips ASCII and fullwidth DSML tags while preserving surrounding thought", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(3);

    expect(
      normalizer.push(3, "校验完成。</|DSML|parameter>继续提交。").delta,
    ).toBe("校验完成。继续提交。");
    expect(
      normalizer.push(3, "</｜DSML｜invoke></｜DSML｜tool_calls>").delta,
    ).toBe("");
  });

  it("removes a complete DSML tool payload split across deltas", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(1);

    expect(normalizer.push(1, "准备调用。<｜DS").delta).toBe("准备调用。");
    expect(
      normalizer.push(1, 'ML｜tool_calls><｜DSML｜invoke name="Read">').delta,
    ).toBe("");
    expect(
      normalizer.push(1, '<｜DSML｜parameter name="path">secret.json').delta,
    ).toBe("");
    expect(
      normalizer.push(1, "</｜DSML｜parameter></｜DSML｜invoke>").delta,
    ).toBe("");
    expect(normalizer.push(1, "</｜DSML｜tool_calls>调用完成。").delta).toBe(
      "调用完成。",
    );
  });

  it("keeps non-DSML angle-bracket content and flushes an incomplete tag", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(2);

    expect(normalizer.push(2, "比较 a < b，并保留 <code>。").delta).toBe(
      "比较 a < b，并保留 <code>。",
    );
    expect(normalizer.push(2, "<未完成").delta).toBe("<未完成");
    expect(normalizer.push(2, "<").delta).toBe("");
    expect(normalizer.finish(2).delta).toBe("<");
  });

  it("isolates blocks by parent scope and resets reused indexes", () => {
    const normalizer = new ThinkingDeltaNormalizer();
    normalizer.start(0, "agent-a");
    normalizer.start(0, "agent-b");

    expect(normalizer.push(0, "甲", "agent-a").delta).toBe("甲");
    expect(normalizer.push(0, "乙", "agent-b").delta).toBe("乙");

    normalizer.start(0, "agent-a");
    expect(normalizer.push(0, "重新开始", "agent-a").delta).toBe("重新开始");
  });

  it("sanitizes the repeated closing frames captured in provider transcripts", () => {
    const reminder = "Use the TaskCreate/TaskUpdate tools to record progress.";
    const leakedFrame = [
      "</｜DSML｜parameter>",
      "</｜DSML｜invoke>",
      "</｜DSML｜tool_calls>",
    ].join("\n");

    const sanitized = sanitizeCompleteThinkingText(
      `${reminder}\n${Array.from({ length: 30 }, () => leakedFrame).join("\n")}`,
    );
    expect(sanitized).not.toContain("DSML");
    expect(sanitized.trim()).toBe(reminder);
  });
});
