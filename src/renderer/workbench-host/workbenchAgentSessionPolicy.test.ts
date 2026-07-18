import { describe, expect, it } from "vitest";

import { isEmptyOrBrokenSession } from "./workbenchAgentSessionPolicy";

describe("isEmptyOrBrokenSession", () => {
  it("treats missing metadata as broken", () => {
    expect(isEmptyOrBrokenSession(null)).toBe(true);
    expect(isEmptyOrBrokenSession(undefined)).toBe(true);
  });

  it("treats zero-turn sessions without preview as empty", () => {
    expect(
      isEmptyOrBrokenSession({
        stats: { turnCount: 0 },
      }),
    ).toBe(true);
    expect(isEmptyOrBrokenSession({ stats: undefined })).toBe(true);
  });

  it("keeps sessions that already have turns", () => {
    expect(
      isEmptyOrBrokenSession({
        stats: { turnCount: 1 },
      }),
    ).toBe(false);
  });

  it("keeps sessions that only have a last-message preview", () => {
    expect(
      isEmptyOrBrokenSession({
        stats: { turnCount: 0 },
        lastMessagePreview: "先用一句话描述世界",
      }),
    ).toBe(false);
  });

  it("ignores whitespace-only previews", () => {
    expect(
      isEmptyOrBrokenSession({
        stats: { turnCount: 0 },
        lastMessagePreview: "   ",
      }),
    ).toBe(true);
  });
});
