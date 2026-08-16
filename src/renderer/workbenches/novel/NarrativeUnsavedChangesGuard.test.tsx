import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkbenchNavigationGuard } from "@/workbench-sdk";

import NarrativeUnsavedChangesGuard from "./NarrativeUnsavedChangesGuard";

describe("NarrativeUnsavedChangesGuard", () => {
  it("任务运行时仅允许等待，完成后允许确认离开", async () => {
    const navigationGuardRef: { current: WorkbenchNavigationGuard | null } = {
      current: null,
    };
    const registerNavigationGuard = vi.fn((guard: WorkbenchNavigationGuard) => {
      navigationGuardRef.current = guard;
      return () => {
        navigationGuardRef.current = null;
      };
    });
    const props = {
      dirty: false,
      blockLeave: true,
      label: "正文",
      registerNavigationGuard,
      onSave: async () => true,
    };
    const view = render(<NarrativeUnsavedChangesGuard {...props} />);

    await waitFor(() => expect(navigationGuardRef.current).not.toBeNull());
    const guard = navigationGuardRef.current;
    if (!guard) throw new Error("导航守卫未注册");
    const pending = guard.confirmLeave();

    expect(await screen.findByRole("heading", { name: "正文任务正在运行" })).toBeVisible();
    expect(screen.getByRole("button", { name: "继续等待" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "放弃修改" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存并离开" })).not.toBeInTheDocument();

    await act(async () => {
      view.rerender(
        <NarrativeUnsavedChangesGuard {...props} blockLeave={false} />,
      );
    });
    expect(await screen.findByRole("heading", { name: "离开正文" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "离开正文" }));
    await expect(pending).resolves.toBe(true);
    const restoredGuard = navigationGuardRef.current;
    if (!restoredGuard) throw new Error("导航守卫在重新渲染后丢失");
    await expect(restoredGuard.confirmLeave()).resolves.toBe(true);
  });

  it("任务完成后保留脏草稿并转入保存或放弃确认", async () => {
    const navigationGuardRef: { current: WorkbenchNavigationGuard | null } = {
      current: null,
    };
    const props = {
      dirty: true,
      blockLeave: true,
      label: "正文",
      registerNavigationGuard: (guard: WorkbenchNavigationGuard) => {
        navigationGuardRef.current = guard;
        return () => {
          navigationGuardRef.current = null;
        };
      },
      onSave: async () => true,
    };
    const view = render(<NarrativeUnsavedChangesGuard {...props} />);

    await waitFor(() => expect(navigationGuardRef.current).not.toBeNull());
    const guard = navigationGuardRef.current;
    if (!guard) throw new Error("导航守卫未注册");
    const pending = guard.confirmLeave();
    expect(await screen.findByRole("heading", { name: "正文任务正在运行" })).toBeVisible();

    await act(async () => {
      view.rerender(
        <NarrativeUnsavedChangesGuard {...props} blockLeave={false} />,
      );
    });
    expect(await screen.findByRole("heading", { name: "正文有未保存修改" })).toBeVisible();
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await expect(pending).resolves.toBe(true);
  });
});
