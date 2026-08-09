import { describe, expect, it } from "vitest";

import {
  createNovelSettingLibraryRepository,
  getNodeSettingReferences,
} from "./settingLibraryRepository";
import { createEmptyNovelStorage } from "./testStorage";
import {
  createLocationFiles,
  type LocationStorageRecord,
} from "../../../shared/workbenches/novel/locationStorage";

function replaceLocationFiles(
  storage: ReturnType<typeof createEmptyNovelStorage>,
  locations: readonly LocationStorageRecord[],
): void {
  for (const file of createLocationFiles({ schemaVersion: 1, locations })) {
    storage.setExternalText(file.path, file.content);
  }
}

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

  it("records the template version when materializing a page", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    const library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const page = await repository.loadPage(reference);
    const saved = await repository.savePage(library, page, "# 已填写正文\n");

    expect(saved.library.settingsIndex.settings[0]?.templateVersion).toBe(
      "1.3.0",
    );
  });

  it("deletes a materialized page and lets the virtual page reappear", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const page = await repository.loadPage(reference);
    ({ library } = await repository.savePage(library, page, "# 已填写正文\n"));
    const instance = library.settingsIndex.settings[0];
    expect(instance).toBeDefined();

    library = await repository.deleteSettingPage(library, instance!);

    expect(library.settingsIndex.settings).toHaveLength(0);
    expect(storage.getText(instance!.pagePath)).toBeUndefined();
    expect(storage.getText(instance!.entriesPath)).toBeUndefined();
    const [reappeared] = getNodeSettingReferences(library, "world-root");
    expect(reappeared?.kind).toBe("virtual");
  });

  it("toggles setting page status between draft and completed", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const page = await repository.loadPage(reference);
    ({ library } = await repository.savePage(library, page, "# 正文\n"));
    const instance = library.settingsIndex.settings[0];
    expect(instance?.status).toBe("draft");

    library = await repository.updateSettingStatus(
      library,
      instance!.id,
      "completed",
    );
    expect(
      library.settingsIndex.settings.find(
        (setting) => setting.id === instance!.id,
      )?.status,
    ).toBe("completed");

    library = await repository.updateSettingStatus(
      library,
      instance!.id,
      "draft",
    );
    expect(
      library.settingsIndex.settings.find(
        (setting) => setting.id === instance!.id,
      )?.status,
    ).toBe("draft");
  });

  it("blocks deleting a spatial node that still has children or materialized settings", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    const [reference] = getNodeSettingReferences(library, "world-root");
    const page = await repository.loadPage(reference);
    ({ library } = await repository.savePage(library, page, "# 正文\n"));

    await expect(
      repository.deleteSpatialNode(library, "world-root"),
    ).rejects.toThrow("已落盘设定页面");

    library = await repository.deleteSettingPage(
      library,
      library.settingsIndex.settings[0]!,
    );
    library = await repository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: [
        ...library.spatialTree.nodes,
        {
          id: "planet-1",
          parentId: "world-root",
          name: "青云星",
          typeId: "planet",
          order: 0,
        },
      ],
    });

    await expect(
      repository.deleteSpatialNode(library, "world-root"),
    ).rejects.toThrow("下级空间节点");
  });

  it("blocks deleting a spatial node referenced by locations or factions", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    library = await repository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: [
        ...library.spatialTree.nodes,
        {
          id: "continent-1",
          parentId: "world-root",
          name: "东玄大陆",
          typeId: "continent",
          order: 0,
        },
      ],
    });
    replaceLocationFiles(storage, [
      {
        id: "loc-1",
        nodeId: "continent-1",
        parentLocationId: null,
        name: "山门",
        aliases: [],
        type: "建筑",
        status: "planned",
        summary: "",
        appearanceNote: "",
        description: "",
        order: 0,
      },
    ]);

    await expect(
      repository.deleteSpatialNode(library, "continent-1"),
    ).rejects.toThrow("地点库");

    replaceLocationFiles(storage, []);
    storage.setExternalText(
      "world/factions/index.json",
      `${JSON.stringify(
        {
          schemaVersion: 2,
          storageVersion: 1,
          factions: [
            {
              id: "faction-sect",
              path: "world/factions/records/faction-sect.json",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    storage.setExternalText(
      "world/factions/records/faction-sect.json",
      `${JSON.stringify(
        {
          id: "faction-sect",
          name: "青云宗",
          type: "宗门",
          status: "active",
          summary: "",
          state: {
            governance: "",
            military: "",
            economy: "",
            publicSupport: "",
            territorialIntegrity: "",
          },
          territories: [
            {
              id: "territory-1",
              name: "山门",
              worldNodeId: "continent-1",
              description: "",
            },
          ],
          members: [],
          assets: [],
          resources: [],
          organizationUnits: [],
          relations: [],
          rights: [],
          links: [],
          createdAt: "2026-07-14T12:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      repository.deleteSpatialNode(library, "continent-1"),
    ).rejects.toThrow("势力库");
  });

  it("deletes a clean spatial node", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    let library = await repository.load("长夜行");
    library = await repository.saveSpatialTree(library, {
      ...library.spatialTree,
      nodes: [
        ...library.spatialTree.nodes,
        {
          id: "planet-1",
          parentId: "world-root",
          name: "青云星",
          typeId: "planet",
          order: 0,
        },
      ],
    });

    library = await repository.deleteSpatialNode(library, "planet-1");

    expect(
      library.spatialTree.nodes.some((node) => node.id === "planet-1"),
    ).toBe(false);
    expect(
      library.spatialTree.nodes.some((node) => node.id === "world-root"),
    ).toBe(true);
  });
});
