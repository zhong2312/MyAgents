import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: false,
  watchStart: vi.fn(),
  watchStop: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceFileService", () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    workspacePath: "F:\\Novel",
    watchStart: mocks.watchStart,
    watchStop: mocks.watchStop,
  }),
}));

vi.mock("@/utils/browserMock", () => ({
  isTauriEnvironment: () => mocks.isTauri,
}));

vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: vi.fn(),
}));

import { useWorkbenchStorage } from "./useWorkbenchStorage";

describe("useWorkbenchStorage", () => {
  beforeEach(() => {
    mocks.isTauri = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls browser development storage without invoking Tauri watcher commands", async () => {
    const listener = vi.fn();
    const { result } = renderHook(() => useWorkbenchStorage("F:\\Novel"));

    const subscription = await result.current.watch(listener);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(listener).toHaveBeenCalledWith({ kind: "workspace-changed" });
    expect(mocks.watchStart).not.toHaveBeenCalled();

    await subscription.dispose();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
