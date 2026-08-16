import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  createNovelSettingLibraryRepository,
  SETTING_LIBRARY_PATHS,
} from "./settingLibraryRepository";
import SettingLibrary from "./SettingLibrary";
import { createEmptyNovelStorage } from "./testStorage";

describe("SettingLibrary", () => {
  it("重载期间忽略较早的设定库读取结果", async () => {
    const storage = createEmptyNovelStorage();
    const repository = createNovelSettingLibraryRepository(storage);
    const initial = await repository.load("测试小说");
    const updatedTree = {
      ...initial.spatialTree,
      nodes: [
        ...initial.spatialTree.nodes,
        {
          id: "proposal-continent",
          parentId: "world-root",
          name: "提案新增大陆",
          typeId: "continent",
          order: 1,
        },
      ],
    };
    const originalReadText = storage.readText.bind(storage);
    let delayFirstTreeRead = true;
    let notifyBlocked: () => void = () => undefined;
    let releaseBlockedRead: () => void = () => undefined;
    const firstTreeReadBlocked = new Promise<void>((resolve) => {
      notifyBlocked = resolve;
    });
    const releaseFirstTreeRead = new Promise<void>((resolve) => {
      releaseBlockedRead = resolve;
    });
    storage.readText = async (path) => {
      const result = await originalReadText(path);
      if (path === SETTING_LIBRARY_PATHS.spatialTree && delayFirstTreeRead) {
        delayFirstTreeRead = false;
        notifyBlocked();
        await releaseFirstTreeRead;
      }
      return result;
    };

    const { rerender } = render(
      <SettingLibrary
        storage={storage}
        projectTitle="测试小说"
        mode="library"
        reloadKey={0}
      />,
    );
    await firstTreeReadBlocked;

    storage.setExternalText(
      SETTING_LIBRARY_PATHS.spatialTree,
      `${JSON.stringify(updatedTree, null, 2)}\n`,
    );
    rerender(
      <SettingLibrary
        storage={storage}
        projectTitle="测试小说"
        mode="library"
        reloadKey={1}
      />,
    );

    expect(await screen.findByText("提案新增大陆")).toBeInTheDocument();
    releaseBlockedRead();
    await waitFor(() => {
      expect(screen.getByText("提案新增大陆")).toBeInTheDocument();
    });
  });
});
