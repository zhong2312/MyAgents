import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  watchStart: vi.fn(),
  watchStop: vi.fn(),
  listener: null as null | (() => void),
}));

vi.mock("./useWorkspaceFileService", () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    watchStart: mocks.watchStart,
    watchStop: mocks.watchStop,
  }),
}));

vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: vi.fn(async (_eventName: string, handler: () => void) => {
    mocks.listener = handler;
    return {
      unlisten: vi.fn(),
      isRegistered: () => true,
    };
  }),
}));

vi.mock("@/utils/browserMock", () => ({
  isTauriEnvironment: () => mocks.isTauri,
}));

import { useWorkspaceChangeSignal } from "./useWorkspaceChangeSignal";

describe("useWorkspaceChangeSignal", () => {
  beforeEach(() => {
    mocks.isTauri = true;
    mocks.watchStop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.listener = null;
  });

  it("increments when the workspace watcher emits and releases its token on unmount", async () => {
    mocks.watchStart.mockResolvedValue({
      token: "token-1",
      eventKey: "event-1",
    });

    const { result, unmount } = renderHook(() =>
      useWorkspaceChangeSignal("/workspace", true),
    );

    await waitFor(() => expect(mocks.listener).toBeTruthy());
    expect(result.current).toBe(0);

    act(() => {
      mocks.listener?.();
    });

    expect(result.current).toBe(1);

    unmount();

    await waitFor(() => {
      expect(mocks.watchStop).toHaveBeenCalledWith({ token: "token-1" });
    });
  });

  it("does not start a watcher when disabled", () => {
    renderHook(() => useWorkspaceChangeSignal("/workspace", false));

    expect(mocks.watchStart).not.toHaveBeenCalled();
  });

  it("polls browser development storage without requesting a Tauri watcher", () => {
    mocks.isTauri = false;
    vi.useFakeTimers();

    const { result, unmount } = renderHook(() =>
      useWorkspaceChangeSignal("/workspace", true),
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current).toBe(1);
    expect(mocks.watchStart).not.toHaveBeenCalled();
    unmount();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(1);
  });
});
