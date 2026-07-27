import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalRegisteredAgent } from "@/api/spaceCloud";
import { ToastProvider } from "@/components/Toast";
import { i18n } from "@/i18n";
import type { SpaceActions } from "@/pages/space/spaceStore";
import { AgentsWorkspace, RegisterAgentDialog } from "./AgentsWorkspace";

function renderWorkspace(
  refreshRegisteredAgents = vi.fn().mockResolvedValue(undefined),
  agents: LocalRegisteredAgent[] = [],
  admin = false,
  actionOverrides: Partial<SpaceActions> = {},
) {
  const actions = {
    refreshRegisteredAgents,
    ...actionOverrides,
  } as unknown as SpaceActions;
  render(
    <ToastProvider>
      <AgentsWorkspace
        admin={admin}
        agents={agents}
        goals={[]}
        projects={[]}
        actions={actions}
        avatarPresets={{
          people: [],
          agents: [],
          lastFetchedAt: 0,
          isLoading: false,
          error: null,
        }}
        onRegister={vi.fn()}
        isActive
        onAgentConnecting={vi.fn()}
      />
    </ToastProvider>,
  );
  return refreshRegisteredAgents;
}

function expectViewportSafeAgentDialog(dialog: HTMLElement) {
  expect(dialog).toHaveClass(
    "grid",
    "max-h-[calc(100dvh-48px)]",
    "grid-rows-[auto_minmax(0,1fr)_auto]",
    "overflow-hidden",
  );
  expect(dialog.children.item(1)).toHaveClass(
    "min-h-0",
    "overflow-y-auto",
    "overscroll-contain",
  );
}

const testAgent: LocalRegisteredAgent = {
  id: "rag-1",
  baseUrl: "https://space.myagents.test",
  spaceId: "space-1",
  displayName: "Build Agent",
  instruction: "Build assigned issues.",
  instructionRevision: 1,
  subscriptions: [
    {
      id: "subscription-1",
      spaceId: "space-1",
      actorType: "registered_agent",
      actorId: "rag-1",
      goalId: "goal-1",
      includeSubtree: true,
      stateFilter: ["todo"],
      goalPathLabel: "Engineering / Bug fixes",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
  ],
  goalId: "goal-1",
  goalPathLabel: "Engineering / Bug fixes",
  workspacePath: "/tmp/build",
  stateFilter: ["todo"],
  issueSubscriptionRunMode: "single_session",
  status: "active",
  presence: "offline",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("AgentsWorkspace", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("preserves card order when the app returns to the foreground", async () => {
    const refresh = renderWorkspace();
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith({ force: true, silent: false }),
    );

    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(refresh).toHaveBeenLastCalledWith({
        force: true,
        silent: true,
      }),
    );
  });

  it("offers an actionable hint and a native details button for never-online Agents", () => {
    renderWorkspace(undefined, [testAgent]);

    expect(
      screen.getByText(
        "Make sure the MyAgents client is running and can reach Space Cloud.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    ).toBeInTheDocument();
  });

  it("replaces Agent details with the editor when settings is opened", () => {
    renderWorkspace(undefined, [testAgent], true);

    fireEvent.click(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    );
    expect(screen.getByText("Registration info")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Agent Build Agent" }),
    );

    expect(
      screen.getByRole("heading", { name: "Edit Agent" }),
    ).toBeInTheDocument();
    expectViewportSafeAgentDialog(
      screen.getByRole("dialog", { name: "Edit Agent" }),
    );
    expect(screen.queryByText("Registration info")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Edit Agent" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Registration info")).not.toBeInTheDocument();
  });

  it("edits the standing goal below the name with optimistic revision control", async () => {
    const updateRegisteredAgent = vi.fn().mockResolvedValue(testAgent);
    renderWorkspace(undefined, [testAgent], true, { updateRegisteredAgent });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Agent Build Agent" }),
    );

    const name = screen.getByDisplayValue("Build Agent");
    const instruction = screen.getByDisplayValue("Build assigned issues.");
    expect(screen.getAllByText("Goal and instructions")).toHaveLength(2);
    expect(name.compareDocumentPosition(instruction)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.change(instruction, {
      target: { value: "Assess each Issue and implement it when ready." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateRegisteredAgent).toHaveBeenCalledWith({
        id: "rag-1",
        displayName: "Build Agent",
        instruction: "Assess each Issue and implement it when ready.",
        expectedInstructionRevision: 1,
        issueSubscriptionRunMode: "single_session",
      }),
    );
  });

  it("keeps a conflicting instruction draft and explains legacy missing instructions", async () => {
    const updateRegisteredAgent = vi
      .fn()
      .mockRejectedValue(new Error("REGISTERED_AGENT_INSTRUCTION_CONFLICT"));
    const legacyAgent: LocalRegisteredAgent = {
      ...testAgent,
      instruction: null,
      instructionRevision: 0,
    };
    renderWorkspace(undefined, [legacyAgent], true, { updateRegisteredAgent });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Agent Build Agent" }),
    );
    expect(
      screen.getAllByText(
        /legacy Agent does not have a goal and instructions yet/i,
      ),
    ).toHaveLength(2);

    const instruction = screen.getByLabelText("Goal and instructions");
    fireEvent.change(instruction, {
      target: { value: "Preserve this concurrent draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        screen.getByText(/goal and instructions changed elsewhere/i),
      ).toBeInTheDocument(),
    );
    expect(instruction).toHaveValue("Preserve this concurrent draft.");
  });

  it("edits exactly one visible subscription without exposing multi-subscription controls", async () => {
    const hiddenSubscription = {
      ...testAgent.subscriptions[0],
      id: "subscription-hidden",
      goalId: "goal-hidden",
      goalPathLabel: "Engineering / Feature work",
    };
    const agentWithHiddenSubscription = {
      ...testAgent,
      subscriptions: [...testAgent.subscriptions, hiddenSubscription],
    };
    const updateRegisteredAgent = vi.fn().mockResolvedValue(testAgent);
    const deleteRegisteredAgentSubscription = vi
      .fn()
      .mockResolvedValue(undefined);
    const createRegisteredAgentSubscription = vi.fn().mockResolvedValue({
      ...testAgent.subscriptions[0],
      id: "subscription-2",
      stateFilter: ["todo", "open"],
    });
    renderWorkspace(undefined, [agentWithHiddenSubscription], true, {
      updateRegisteredAgent,
      deleteRegisteredAgentSubscription,
      createRegisteredAgentSubscription,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View registration settings · Build Agent",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Agent Build Agent" }),
    );

    expect(
      screen.queryByRole("button", { name: "Add subscription" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Re-evaluate current scope" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(deleteRegisteredAgentSubscription).toHaveBeenCalledWith(
        "subscription-1",
      );
      expect(deleteRegisteredAgentSubscription).toHaveBeenCalledTimes(1);
      expect(createRegisteredAgentSubscription).toHaveBeenCalledWith({
        registeredAgentId: "rag-1",
        goalId: "goal-1",
        stateFilter: ["todo", "open"],
      });
    });
  });

  it("places the standing goal directly after the name and sends it on registration", async () => {
    const registerAgent = vi.fn().mockResolvedValue(testAgent);
    const onRegistered = vi.fn();
    render(
      <ToastProvider>
        <RegisterAgentDialog
          projects={
            [
              {
                id: "workspace-1",
                name: "MyAgents",
                path: "/tmp/myagents",
              },
            ] as never
          }
          goals={
            [
              {
                id: "goal-1",
                title: "Bug fixes",
                goalPathLabel: "Engineering / Bug fixes",
              },
            ] as never
          }
          actions={{ registerAgent } as unknown as SpaceActions}
          onClose={vi.fn()}
          onRegistered={onRegistered}
        />
      </ToastProvider>,
    );

    const name = screen.getByPlaceholderText("Agent display name");
    expect(screen.getByText("Goal and instructions")).toBeInTheDocument();
    const instruction = screen.getByPlaceholderText(
      "Describe how this Agent instance should respond to and handle incoming Issues, including its standing focus and decision direction.",
    );
    expect(instruction).toHaveAttribute(
      "placeholder",
      "Describe how this Agent instance should respond to and handle incoming Issues, including its standing focus and decision direction.",
    );
    expect(
      screen.queryByText(
        "This is the standing intent for this Agent instance. It will still decide the specific action from the current Issue.",
      ),
    ).not.toBeInTheDocument();
    expectViewportSafeAgentDialog(
      screen.getByRole("dialog", { name: "Add local Agent workspace" }),
    );
    expect(
      screen.queryByRole("button", { name: "Add subscription" }),
    ).not.toBeInTheDocument();
    const newConversation = screen.getByRole("button", {
      name: "New conversation",
    });
    const continuousConversation = screen.getByRole("button", {
      name: "Continuous conversation",
    });
    expect(newConversation).toHaveAttribute("aria-pressed", "true");
    expect(
      newConversation.compareDocumentPosition(continuousConversation),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(name.compareDocumentPosition(instruction)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.change(name, { target: { value: "Bug triage" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Add local Agent workspace" }),
    );
    expect(
      screen.getByText("Enter a goal and instructions."),
    ).toBeInTheDocument();
    expect(instruction).toHaveFocus();

    fireEvent.change(instruction, {
      target: { value: "界".repeat(20_001) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add local Agent workspace" }),
    );
    expect(
      screen.getByText(
        "Goal and instructions can contain at most 20,000 characters.",
      ),
    ).toBeInTheDocument();
    expect(registerAgent).not.toHaveBeenCalled();

    fireEvent.change(instruction, {
      target: {
        value:
          "Assess reproducibility and identify missing acceptance criteria.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add local Agent workspace" }),
    );

    await waitFor(() =>
      expect(registerAgent).toHaveBeenCalledWith({
        displayName: "Bug triage",
        instruction:
          "Assess reproducibility and identify missing acceptance criteria.",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/myagents",
        workspaceLabel: "MyAgents",
        goalId: "goal-1",
        stateFilter: ["todo"],
        issueSubscriptionRunMode: "new_session",
      }),
    );
    expect(onRegistered).toHaveBeenCalledWith(testAgent);
  });

  it("shows the same registration instruction contract in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <ToastProvider>
        <RegisterAgentDialog
          projects={
            [
              {
                id: "workspace-1",
                name: "MyAgents",
                path: "/tmp/myagents",
              },
            ] as never
          }
          goals={
            [
              {
                id: "goal-1",
                title: "Bug fixes",
                goalPathLabel: "Engineering / Bug fixes",
              },
            ] as never
          }
          actions={{} as SpaceActions}
          onClose={vi.fn()}
          onRegistered={vi.fn()}
        />
      </ToastProvider>,
    );

    expect(screen.getByText("目标与指令")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        "填写你希望该 Agent 实例收到 Issue 后如何响应与处理，并为它设定长期关注目标和判断方向。",
      ),
    ).toBeInTheDocument();
  });
});
