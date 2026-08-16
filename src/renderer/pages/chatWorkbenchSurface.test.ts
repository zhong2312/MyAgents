import { describe, expect, it } from "vitest";

import {
  shouldRenderWorkbenchReferencePanel,
} from "./chatWorkbenchSurface";

describe("shouldRenderWorkbenchReferencePanel", () => {
  it("keeps the reference panel for ordinary workbench sessions", () => {
    expect(shouldRenderWorkbenchReferencePanel({})).toBe(true);
  });

  it("leaves the companion area to an embedded workbench", () => {
    expect(shouldRenderWorkbenchReferencePanel({ embedded: true })).toBe(false);
  });
});
