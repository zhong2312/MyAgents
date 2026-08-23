import { describe, expect, it } from "vitest";

import novelWorkbenchDefinition from "./index";

describe("novel workbench manifest", () => {
  it("uses My Novel Studio as the user-facing project name", () => {
    expect(novelWorkbenchDefinition.manifest.name).toBe("My Novel Studio");
  });

  it("places world simulation under the auxiliary navigation group", () => {
    const simulation = novelWorkbenchDefinition.manifest.navigation.find(
      (item) => item.id === "simulation",
    );

    expect(simulation).toMatchObject({
      label: "世界推演",
      parentId: "utilities",
      order: 30,
    });
  });
});
