import { describe, expect, it } from "vitest";

import { createManuscriptAiSettingsRepository } from "./manuscriptAiSettingsRepository";
import { NovelMemoryStorage } from "./testStorage";

describe("createManuscriptAiSettingsRepository", () => {
  it("creates compact review as the default and persists full dialog mode", async () => {
    const storage = new NovelMemoryStorage({});
    const repository = createManuscriptAiSettingsRepository(storage);

    const initial = await repository.load();
    expect(initial.settings.presentation).toBe("compact-review");

    const saved = await repository.save(initial, {
      schemaVersion: 1,
      presentation: "full-dialog",
    });
    expect(saved.settings.presentation).toBe("full-dialog");
    expect(storage.getText("settings/manuscript-ai.json")).toContain(
      '"full-dialog"',
    );
  });
});
