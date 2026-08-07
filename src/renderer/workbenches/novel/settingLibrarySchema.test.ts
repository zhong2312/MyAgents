import { describe, expect, it } from "vitest";

import {
  parseSettingLibrarySettingsIndex,
  SettingLibraryFormatError,
} from "./settingLibrarySchema";

describe("summarizeZodIssues (via parseSettingLibrarySettingsIndex)", () => {
  it("collapses many array items missing the same fields into one line", () => {
    const emptySettings = {
      schemaVersion: 1,
      settings: Array.from({ length: 36 }, () => ({})),
    };
    let detail = "";
    try {
      parseSettingLibrarySettingsIndex(JSON.stringify(emptySettings));
    } catch (error) {
      expect(error).toBeInstanceOf(SettingLibraryFormatError);
      expect((error as SettingLibraryFormatError).filePath).toBe(
        "world/setting-library/settings.json",
      );
      detail = (error as Error).message;
    }
    // The message stays compact: it must NOT enumerate all 36×4 issues.
    expect(detail).toContain("36 个条目缺少必要字段");
    expect(detail.length).toBeLessThan(400);
    expect(detail).not.toContain("settings.35.name");
  });

  it("keeps a readable summary for a single invalid entry", () => {
    const singleBad = {
      schemaVersion: 1,
      settings: [
        {
          id: "page-a",
          nodeId: "node-a",
          templateId: "tpl-a",
          name: "",
          group: "",
          status: "draft",
          pagePath: "world/setting-library/pages/node-a/page-a.md",
          entriesPath: "world/setting-library/entries/node-a/page-a.json",
        },
      ],
    };
    let message = "";
    try {
      parseSettingLibrarySettingsIndex(JSON.stringify(singleBad));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("settings.json 格式错误");
    expect(message.length).toBeLessThan(300);
  });

  it("collapses repeated illegal-path issues into one counted line", () => {
    const badPaths = {
      schemaVersion: 1,
      settings: Array.from({ length: 36 }, (_, index) => ({
        id: `page-a${index}`,
        nodeId: "node-a",
        templateId: null,
        name: "宇宙总览",
        group: "世界",
        status: "draft",
        pagePath: `world/setting-library/pages/node-a/page-a${index}.md`,
        // kind 混淆：entries 位置放了 pages 的 .md
        entriesPath: `world/setting-library/pages/node-a/page-a${index}.md`,
      })),
    };
    let message = "";
    try {
      parseSettingLibrarySettingsIndex(JSON.stringify(badPaths));
    } catch (error) {
      message = (error as Error).message;
    }
    // 36 条同类路径错误折叠成一行，并保留期望格式说明与一个实例位置。
    expect(message).toContain("36 个条目");
    expect(message).toContain("world/setting-library/entries/");
    expect(message).toContain("例如 settings.0.entriesPath");
    expect(message).not.toContain("settings.5.entriesPath");
    expect(message).not.toContain("另有");
  });

  it("still surfaces structural JSON syntax errors verbatim", () => {
    let message = "";
    try {
      parseSettingLibrarySettingsIndex("{ not valid json");
    } catch (error) {
      expect(error).toBeInstanceOf(SettingLibraryFormatError);
      message = (error as Error).message;
    }
    expect(message).toContain("settings.json 格式错误");
  });
});