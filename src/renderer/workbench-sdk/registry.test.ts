import { describe, expect, it } from "vitest";

import { defineWorkbench } from "./defineWorkbench";
import { createWorkbenchRegistry, DuplicateWorkbenchError } from "./registry";

const manifest = {
  manifestVersion: 1,
  id: "io.myagents.testbench",
  name: "Testbench",
  description: "Test workbench",
  version: "1.2.0",
  api: { major: 1, minMinor: 0 },
  entry: { renderer: "testbench", defaultRoute: "home" },
  navigation: [{ id: "home", label: "Home" }],
};

const load = async () => ({ default: () => null });

describe("WorkbenchRegistry", () => {
  it("seals definitions and records host compatibility", () => {
    const definition = defineWorkbench(manifest, load);
    const registry = createWorkbenchRegistry([definition], {
      major: 1,
      minor: 0,
    });
    expect(registry.get(manifest.id)?.definition).toBe(definition);
    expect(registry.get(manifest.id)?.compatibility).toEqual({
      compatible: true,
    });
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("keeps incompatible workbenches discoverable for an actionable shell state", () => {
    const definition = defineWorkbench(
      { ...manifest, api: { major: 2, minMinor: 0 } },
      load,
    );
    const registration = createWorkbenchRegistry([definition], {
      major: 1,
      minor: 0,
    }).get(manifest.id);
    expect(registration?.compatibility).toMatchObject({
      compatible: false,
      reason: "major-mismatch",
    });
  });

  it("registers an optional launcher project creator without importing it into the host", () => {
    const definition = defineWorkbench(manifest, load, {
      launcher: {
        createLabel: "New testbench",
        projectTypeLabel: "Testbench",
        loadProjectCreator: async () => ({ default: () => null }),
      },
    });
    const registration = createWorkbenchRegistry([definition], {
      major: 1,
      minor: 0,
    }).get(manifest.id);

    expect(registration?.ProjectCreator).toBeDefined();
    expect(registration?.definition.launcher?.createLabel).toBe(
      "New testbench",
    );
    expect(Object.isFrozen(registration?.definition.launcher)).toBe(true);
  });

  it("freezes optional shell defaults as part of the workbench definition", () => {
    const definition = defineWorkbench(manifest, load, {
      shell: { defaultNavigationCollapsed: true },
    });

    expect(definition.shell).toEqual({ defaultNavigationCollapsed: true });
    expect(Object.isFrozen(definition.shell)).toBe(true);
  });

  it("rejects duplicate ids before the app starts", () => {
    const definition = defineWorkbench(manifest, load);
    expect(() => createWorkbenchRegistry([definition, definition])).toThrow(
      DuplicateWorkbenchError,
    );
  });
});
