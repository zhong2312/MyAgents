import { describe, expect, it } from "vitest";

import {
  estimateChapterRange,
  parseNovelPlanningInput,
} from "./projectPlanning";

describe("novel project planning", () => {
  it("converts total words in wan and estimates a chapter range", () => {
    const planning = parseNovelPlanningInput("80", "120", "3000");

    expect(planning).toEqual({
      targetWordCountMin: 800_000,
      targetWordCountMax: 1_200_000,
      chapterWordCount: 3_000,
    });
    expect(estimateChapterRange(planning!)).toEqual({ min: 267, max: 400 });
  });

  it("rejects reversed ranges and invalid chapter sizes", () => {
    expect(parseNovelPlanningInput("120", "80", "3000")).toBeNull();
    expect(parseNovelPlanningInput("80", "120", "12.5")).toBeNull();
  });
});
