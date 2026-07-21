import { describe, expect, it } from "vitest";

import { createNovelProjectInitialization } from "./projectInitialization";

describe("createNovelProjectInitialization", () => {
  it("builds a versioned Markdown and JSON project layout", () => {
    const initialization = createNovelProjectInitialization({
      projectId: "project-1",
      title: "长夜行",
      genres: ["玄幻", "东方玄幻"],
      targetWordCount: 800_000,
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
        "world/codex",
        "world/setting-library/pages",
        "world/setting-library/entries",
        "world/setting-library/proposals",
        "timeline",
        "simulation",
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
        "world/worldview.md",
        "world/setting-library/meta.json",
        "world/setting-library/spatial-tree.json",
        "world/setting-library/settings.json",
        "timeline/index.json",
        "simulation/scenarios.json",
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

    const metadata = initialization.files.find(
      (file) => file.path === "novel.json",
    );
    expect(JSON.parse(metadata?.content ?? "")).toEqual({
      schemaVersion: 1,
      projectId: "project-1",
      workbenchId: "io.myagents.novel",
      title: "长夜行",
      genres: ["玄幻", "东方玄幻"],
      targetWordCount: 800_000,
      status: "planning",
      language: "zh-CN",
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
  });

  it("does not initialize retired story planning files", () => {
    const initialization = createNovelProjectInitialization({
      projectId: "project-2",
      title: "回声",
      genres: ["悬疑"],
      targetWordCount: 20_000,
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
});
