import { describe, expect, it } from "vitest";

import {
  joinWorkbenchStoragePath,
  normalizeWorkbenchStoragePath,
  WorkbenchStoragePathError,
} from "./storage";

describe("workbench storage paths", () => {
  it("normalizes workspace-relative paths to portable separators", () => {
    expect(
      normalizeWorkbenchStoragePath(" planning\\chapters//./one.md "),
    ).toBe("planning/chapters/one.md");
    expect(joinWorkbenchStoragePath("planning", "chapters", "one.md")).toBe(
      "planning/chapters/one.md",
    );
    expect(normalizeWorkbenchStoragePath("  ", true)).toBe("");
  });

  it.each([
    "../outside.md",
    "notes/../../outside.md",
    "/absolute/path.md",
    "C:\\absolute\\path.md",
    "\\\\server\\share\\path.md",
    "bad\0name.md",
  ])("rejects paths outside the workspace contract: %s", (path) => {
    expect(() => normalizeWorkbenchStoragePath(path)).toThrow(
      WorkbenchStoragePathError,
    );
  });
});
