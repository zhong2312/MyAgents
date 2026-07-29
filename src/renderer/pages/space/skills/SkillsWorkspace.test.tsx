import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceSkill } from "@/api/spaceCloud";
import { ToastProvider } from "@/components/Toast";
import type { Project } from "@/config/types";
import { i18n } from "@/i18n";
import type { SpaceActions } from "@/pages/space/spaceStore";
import { SkillsWorkspace } from "./SkillsWorkspace";

const skill: SpaceSkill = {
  id: "skill-1",
  name: "Shared Skill",
  slug: "shared-skill",
  description: "A shared team Skill",
  currentRevision: 2,
  latestRevision: 2,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T01:00:00.000Z",
};

function renderSkill(
  installSkill: SpaceActions["installSkill"],
  projects: Project[] = [],
) {
  const actions = {
    refreshSkillDetail: vi.fn().mockResolvedValue(undefined),
    refreshSkillFile: vi.fn().mockResolvedValue(undefined),
    refreshSkillRevisions: vi.fn().mockResolvedValue(undefined),
    installSkill,
  } as unknown as SpaceActions;

  render(
    <ToastProvider>
      <SkillsWorkspace
        admin={false}
        skills={[skill]}
        loading={false}
        error={null}
        selectedSkillId={skill.id}
        projects={projects}
        actions={actions}
        skillDetailState={{
          detail: { skill, files: [] },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        }}
        isActive
        remoteUpdateAvailable={false}
        onSelectSkill={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onApplyRemoteUpdate={vi.fn().mockResolvedValue(undefined)}
        onUploaded={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe("Space Skill overwrite install", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("defaults a same-name conflict to cancellation", async () => {
    const installSkill = vi
      .fn<SpaceActions["installSkill"]>()
      .mockRejectedValue("SKILL_INSTALL_CONFLICT");
    renderSkill(installSkill);

    fireEvent.click(screen.getByRole("button", { name: "Install globally" }));

    expect(await screen.findByText("Overwrite local Skill?")).toBeInTheDocument();
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(installSkill).toHaveBeenCalledWith({
      skillId: "skill-1",
      skillName: "Shared Skill",
      target: "global",
      workspacePath: undefined,
      overwrite: false,
    });

    fireEvent.keyDown(document, { key: "Enter" });
    expect(installSkill).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Overwrite local Skill?")).not.toBeInTheDocument(),
    );
    expect(installSkill).toHaveBeenCalledTimes(1);
  });

  it("retries the exact install target only after explicit overwrite confirmation", async () => {
    const installSkill = vi
      .fn<SpaceActions["installSkill"]>()
      .mockRejectedValueOnce("SKILL_INSTALL_CONFLICT")
      .mockResolvedValueOnce({
        installedName: "shared-skill",
        installedPath: "/tmp/skills/shared-skill",
        target: "global",
      });
    renderSkill(installSkill);

    fireEvent.click(screen.getByRole("button", { name: "Install globally" }));
    expect(await screen.findByText("Overwrite local Skill?")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Overwrite and install" }),
    );

    await waitFor(() => expect(installSkill).toHaveBeenCalledTimes(2));
    expect(installSkill).toHaveBeenLastCalledWith({
      skillId: "skill-1",
      skillName: "Shared Skill",
      target: "global",
      workspacePath: undefined,
      overwrite: true,
    });
    await waitFor(() =>
      expect(screen.queryByText("Overwrite local Skill?")).not.toBeInTheDocument(),
    );
  });

  it("preserves the selected project path when overwrite is confirmed", async () => {
    const installSkill = vi
      .fn<SpaceActions["installSkill"]>()
      .mockRejectedValueOnce("SKILL_INSTALL_CONFLICT")
      .mockResolvedValueOnce({
        installedName: "shared-skill",
        installedPath: "/workspace/project-a/.claude/skills/shared-skill",
        target: "project",
      });
    renderSkill(installSkill, [
      {
        id: "project-a",
        name: "Project A",
        path: "/workspace/project-a",
        lastOpened: "2026-07-26T00:00:00.000Z",
        providerId: null,
        permissionMode: null,
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "Install to workspace" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Project A/ }));
    expect(await screen.findByText("Overwrite local Skill?")).toBeInTheDocument();
    expect(screen.getByText(/\/workspace\/project-a/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Overwrite and install" }),
    );

    await waitFor(() => expect(installSkill).toHaveBeenCalledTimes(2));
    expect(installSkill).toHaveBeenLastCalledWith({
      skillId: "skill-1",
      skillName: "Shared Skill",
      target: "project",
      workspacePath: "/workspace/project-a",
      overwrite: true,
    });
  });
});
