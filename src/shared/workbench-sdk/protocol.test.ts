import { describe, expect, it } from "vitest";

import {
  WORKBENCH_HOST_API_VERSION,
  checkWorkbenchApiCompatibility,
} from "./protocol";

describe("checkWorkbenchApiCompatibility", () => {
  it("publishes the SQLite projection capability as host API 1.8", () => {
    expect(WORKBENCH_HOST_API_VERSION).toEqual({ major: 1, minor: 8 });
  });

  it("accepts the same major when the host satisfies the minor floor", () => {
    expect(
      checkWorkbenchApiCompatibility(
        { major: 1, minMinor: 0 },
        { major: 1, minor: 2 },
      ),
    ).toEqual({ compatible: true });
  });

  it("rejects major mismatches and unsupported minor ranges", () => {
    expect(
      checkWorkbenchApiCompatibility(
        { major: 2, minMinor: 0 },
        { major: 1, minor: 5 },
      ),
    ).toMatchObject({ compatible: false, reason: "major-mismatch" });
    expect(
      checkWorkbenchApiCompatibility(
        { major: 1, minMinor: 3 },
        { major: 1, minor: 2 },
      ),
    ).toMatchObject({ compatible: false, reason: "host-too-old" });
    expect(
      checkWorkbenchApiCompatibility(
        { major: 1, minMinor: 0, maxMinor: 1 },
        { major: 1, minor: 2 },
      ),
    ).toMatchObject({ compatible: false, reason: "host-too-new" });
  });
});
