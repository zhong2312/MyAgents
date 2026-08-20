import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  WorkbenchNavigationGuard,
  WorkbenchStorage,
} from "@/workbench-sdk";

import type { InspirationLibrary } from "../entities/inspirationSchema";
import InspirationWorkbench, {
  INSPIRATION_DETAIL_DRAWER_MEDIA_QUERY,
} from "./InspirationWorkbench";

vi.mock("../../../NarrativeMarkdownField", () => ({
  default: ({ value }: { readonly value: string }) => (
    <textarea aria-label="灵感正文" value={value} readOnly />
  ),
}));

vi.mock("../../../NarrativeUnsavedChangesGuard", () => ({
  default: () => null,
}));

vi.mock("./InspirationAiAssistant", () => ({
  default: () => <button type="button">AI</button>,
}));

vi.mock("./InspirationHelp", () => ({
  default: () => <button type="button">帮助</button>,
}));

function createLibrary(): InspirationLibrary {
  const timestamp = "2026-08-20T00:00:00.000Z";
  return {
    schemaVersion: 1,
    updatedAt: timestamp,
    items: [
      {
        id: "rain-awakening",
        title: "雨夜醒来",
        body: "主角在陌生的雨夜醒来。",
        state: "inbox",
        source: { kind: "manual", label: "随手记录", uri: "" },
        tags: ["开场"],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

function renderWorkbench() {
  const registerNavigationGuard = vi.fn(
    (_guard: WorkbenchNavigationGuard) => () => undefined,
  );
  return render(
    <InspirationWorkbench
      storage={{} as WorkbenchStorage}
      isActive
      projectTitle="测试项目"
      library={createLibrary()}
      content="snapshot"
      isSaving={false}
      onSave={vi.fn(async () => undefined)}
      registerNavigationGuard={registerNavigationGuard}
    />,
  );
}

describe("InspirationWorkbench responsive detail drawer", () => {
  it("在详情抽屉断点内点击灵感会打开右侧详情", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === INSPIRATION_DETAIL_DRAWER_MEDIA_QUERY,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    const view = renderWorkbench();
    const root = view.container.querySelector(".inspiration-studio");
    expect(root).toHaveAttribute("data-mobile-pane", "content");

    fireEvent.click(screen.getByRole("button", { name: /雨夜醒来/ }));

    expect(root).toHaveAttribute("data-mobile-pane", "detail");
    expect(window.matchMedia).toHaveBeenCalledWith(
      INSPIRATION_DETAIL_DRAWER_MEDIA_QUERY,
    );
  });
});
