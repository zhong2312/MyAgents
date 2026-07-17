import { describe, expect, it } from "vitest";

import {
  createNovelSettingLibraryRepository,
  getNodeSettingReferences,
} from "./settingLibraryRepository";
import { createEmptyNovelStorage } from "./testStorage";

describe("createNovelSettingLibraryRepository", () => {
  it("bootstraps metadata and a project-specific root without materializing pages", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);

    const library = await repository.load("长夜行");

    expect(library.spatialTree.nodes).toEqual([
      expect.objectContaining({
        id: "world-root",
        name: "长夜行世界根",
        typeId: "world-root",
      }),
    ]);
    expect(library.meta.levelTypes.some((type) => type.id === "universe")).toBe(
      true,
    );
    expect(storage.getText("world/setting-library/meta.json")).toBeDefined();
    expect(
      storage.getText("world/setting-library/settings.json"),
    ).toBeDefined();
    expect(
      storage.getText(
        "world/setting-library/pages/world-root/page-world-root-universe-overview.md",
      ),
    ).toBeUndefined();
  });

  it("materializes a virtual default page only on its first save", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    const library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    expect(reference.kind).toBe("virtual");

    const page = await repository.loadPage(reference);
    const result = await repository.savePage(
      library,
      page,
      "# 世界总览\n\n这里是事实源。\n",
    );

    expect(result.page.reference.kind).toBe("instance");
    expect(result.library.settingsIndex.settings).toHaveLength(1);
    expect(
      storage.getText(
        "world/setting-library/pages/world-root/page-world-root-universe-overview.md",
      ),
    ).toBe("# 世界总览\n\n这里是事实源。\n");
    expect(
      JSON.parse(
        storage.getText(
          "world/setting-library/entries/world-root/page-world-root-universe-overview.json",
        ) ?? "",
      ),
    ).toEqual({ schemaVersion: 1, entries: [] });
  });

  it("retains materialized pages when the node type and profile change", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const page = await repository.loadPage(reference);
    ({ library } = await repository.savePage(library, page, "# 已填写正文\n"));

    library = await repository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: library.spatialTree.nodes.map((node) => ({
        ...node,
        typeId: "country",
      })),
    });
    const countryReferences = getNodeSettingReferences(library, "world-root");
    expect(
      countryReferences.some(
        (item) =>
          item.kind === "instance" &&
          item.instance.templateId === "universe-overview",
      ),
    ).toBe(true);

    library = await repository.saveMeta(library, {
      ...library.meta,
      profiles: library.meta.profiles.map((profile) =>
        profile.levelTypeId === "country"
          ? { ...profile, templateIds: [] }
          : profile,
      ),
    });
    expect(getNodeSettingReferences(library, "world-root")).toEqual([
      expect.objectContaining({ kind: "instance" }),
    ]);
    expect(
      storage.getText(
        "world/setting-library/pages/world-root/page-world-root-universe-overview.md",
      ),
    ).toBe("# 已填写正文\n");
  });

  it("stores editable entries next to a materialized Markdown page", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const virtualPage = await repository.loadPage(reference);
    const saved = await repository.savePage(
      library,
      virtualPage,
      virtualPage.content,
    );
    library = saved.library;

    const page = await repository.saveEntries(saved.page, [
      {
        id: "entry-sky-river",
        name: "天河",
        category: "地理现象",
        aliases: ["界河"],
        definition: "周期性连接不同世界的水路。",
      },
    ]);

    expect(page.entries[0]?.name).toBe("天河");
    expect(library.settingsIndex.settings).toHaveLength(1);
    expect(JSON.parse(page.entriesContent ?? "").entries).toHaveLength(1);
  });
});
