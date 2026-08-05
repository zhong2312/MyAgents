import { describe, expect, it } from "vitest";

import { createNovelProjectInitialization } from "./projectInitialization";

describe("createNovelProjectInitialization", () => {
  it("builds a versioned Markdown and JSON project layout", () => {
    const initialization = createNovelProjectInitialization({
      projectId: "project-1",
      projectName: "novel-2026-01",
      title: "长夜行",
      genres: ["玄幻", "东方玄幻"],
      targetWordCountMin: 800_000,
      targetWordCountMax: 1_200_000,
      chapterWordCount: 3_000,
      createdAt: "2026-07-14T12:00:00.000Z",
    });

    const paths = initialization.files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(initialization.version).toBe(1);
    expect(initialization.initializeGit).toBe(false);
    expect(initialization.directories).toEqual(
      expect.arrayContaining([
        "manuscript/chapters",
        "characters",
        "characters/records",
        "world/setting-library/pages",
        "world/setting-library/entries",
        "world/setting-library/proposals",
        "world/maps",
        "timeline",
        "simulation",
        "simulation/runs",
        "research/notes",
        "knowledge",
        "prompts/installations",
      ]),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "novel.json",
        "README.md",
        "manuscript/index.json",
        "inspiration/index.json",
        "characters/index.json",
        "characters/records/.gitkeep",
        "world/setting-library/meta.json",
        "world/setting-library/spatial-tree.json",
        "world/setting-library/settings.json",
        "world/locations/index.json",
        "timeline/index.json",
        "simulation/scenarios.json",
        "simulation/runs/index.json",
        "knowledge/entities.json",
        "knowledge/relations.json",
        "knowledge/facts.json",
        "prompts/registry.json",
      ]),
    );
    expect(
      paths.some(
        (path) =>
          path.startsWith(
            "prompts/installations/storyforge.prompt-library/content/",
          ) && path.endsWith(".md"),
      ),
    ).toBe(true);
    expect(
      initialization.files.find((file) => file.path === ".gitignore")?.content,
    ).toContain(".cache/");
    expect(
      paths.filter((path) =>
        path.startsWith(
          "prompts/installations/storyforge.prompt-library/content/",
        ),
      ),
    ).toHaveLength(89);
    const encodedSizes = initialization.files.map(
      (file) => new TextEncoder().encode(file.content).byteLength,
    );
    const registrySize = new TextEncoder().encode(
      initialization.files.find((file) => file.path === "prompts/registry.json")
        ?.content ?? "",
    ).byteLength;
    expect(registrySize).toBeGreaterThan(64 * 1024);
    expect(Math.max(...encodedSizes)).toBeLessThanOrEqual(256 * 1024);
    expect(
      encodedSizes.reduce((total, size) => total + size, 0),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    for (const file of initialization.files.filter((entry) =>
      entry.path.endsWith(".json"),
    )) {
      expect(() => JSON.parse(file.content), file.path).not.toThrow();
    }
    expect(JSON.parse(initialization.files.find((file) => file.path === "simulation/scenarios.json")?.content ?? "{}").schemaVersion).toBe(3);
    expect(JSON.parse(initialization.files.find((file) => file.path === "simulation/runs/index.json")?.content ?? "{}").schemaVersion).toBe(3);

    const metadata = initialization.files.find(
      (file) => file.path === "novel.json",
    );
    expect(JSON.parse(metadata?.content ?? "")).toEqual({
      schemaVersion: 1,
      projectId: "project-1",
      workbenchId: "io.myagents.novel",
      projectName: "novel-2026-01",
      title: "长夜行",
      genres: ["玄幻", "东方玄幻"],
      targetWordCountMin: 800_000,
      targetWordCountMax: 1_200_000,
      chapterWordCount: 3_000,
      status: "planning",
      language: "zh-CN",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
  });

  it("does not initialize retired story planning files", () => {
    const initialization = createNovelProjectInitialization({
      projectId: "project-2",
      projectName: "echo-short",
      title: "回声",
      genres: ["悬疑"],
      targetWordCountMin: 20_000,
      targetWordCountMax: 30_000,
      chapterWordCount: 2_000,
      createdAt: "2026-07-14T12:00:00.000Z",
    });
    expect(
      initialization.files.some(
        (file) =>
          file.path.startsWith("story/") ||
          file.path.startsWith("outline/") ||
          file.path === "settings/creative-profile.json",
      ),
    ).toBe(false);
    expect(initialization.directories).not.toContain("story");
    expect(initialization.initializeGit).toBe(false);
  });

  it("does not initialize retired worldview files (worldview.md / rules.json / codex)", () => {
    const initialization = createNovelProjectInitialization({
      projectId: "project-3",
      projectName: "legacy-check",
      title: "旧轨",
      genres: ["玄幻"],
      targetWordCountMin: 100_000,
      targetWordCountMax: 200_000,
      chapterWordCount: 3_000,
      createdAt: "2026-07-14T12:00:00.000Z",
    });
    const paths = initialization.files.map((file) => file.path);
    expect(paths).not.toContain("world/worldview.md");
    expect(paths).not.toContain("world/rules.json");
    expect(paths).not.toContain("world/codex/index.json");
    expect(initialization.directories).not.toContain("world/codex");
  });
});
