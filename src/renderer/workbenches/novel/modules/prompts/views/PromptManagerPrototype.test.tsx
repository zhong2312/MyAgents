import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PromptManagerPrototype, {
  resolvePromptActivation,
  type PromptDefinition,
  type PromptGroup,
  type PromptSkillPack,
} from "./PromptManagerPrototype";
import { createDefaultPromptLibraryModel } from "../business/promptLibraryDefaults";

const GROUP: PromptGroup = {
  id: "generate",
  name: "局部生成",
  description: "",
  parentId: null,
  nodeKind: "pack-root",
  skillPackId: "pack.base",
  sourcePath: "",
  userCreated: false,
  modified: false,
  enabled: true,
  scope: { kind: "genres", genres: ["玄幻"] },
};

const PACK: PromptSkillPack = {
  id: "pack.base",
  packageId: "pack.base",
  name: "基础包",
  source: "builtin",
  version: "1.0.0",
  enabled: true,
  updatedAt: "内置",
  description: "",
  copyNumber: 1,
  modified: false,
};

const PROMPT: PromptDefinition = {
  instanceId: "pack.base:novel.test",
  id: "novel.test",
  name: "测试提示词",
  groupId: GROUP.id,
  version: "1.0.0",
  enabled: true,
  overridden: false,
  skillPackId: PACK.id,
  scopeOverride: { kind: "genres", genres: ["悬疑"] },
  content: "测试正文",
};

describe("PromptManagerPrototype", () => {
  it("uses prompt scope before group scope when resolving the active set", () => {
    const overridden = resolvePromptActivation(
      PROMPT,
      [GROUP],
      [PACK],
      ["玄幻"],
    );
    expect(overridden.active).toBe(false);
    expect(overridden.scopeSource).toBe("prompt");

    const inherited = resolvePromptActivation(
      { ...PROMPT, scopeOverride: null },
      [GROUP],
      [PACK],
      ["玄幻"],
    );
    expect(inherited.active).toBe(true);
    expect(inherited.scopeSource).toBe("group");
  });

  it("excludes a prompt when every providing skill pack is disabled", () => {
    const activation = resolvePromptActivation(
      { ...PROMPT, scopeOverride: { kind: "global" } },
      [GROUP],
      [{ ...PACK, enabled: false }],
      ["玄幻"],
    );
    expect(activation.active).toBe(false);
    expect(activation.reason).toBe("安装副本“基础包”已停用");
  });

  it("applies a disabled parent group to the whole group subtree", () => {
    const parent: PromptGroup = {
      ...GROUP,
      id: "parent",
      name: "父分组",
      enabled: false,
    };
    const child: PromptGroup = {
      ...GROUP,
      id: "child",
      parentId: parent.id,
      nodeKind: "directory",
      userCreated: true,
    };
    const activation = resolvePromptActivation(
      { ...PROMPT, groupId: child.id, scopeOverride: { kind: "global" } },
      [parent, child],
      [PACK],
      ["玄幻"],
    );
    expect(activation.active).toBe(false);
    expect(activation.reason).toBe("分组“父分组”已停用");
  });

  it("switches between overview and current active set by project genres", async () => {
    const defaults = createDefaultPromptLibraryModel();
    const targetName = "悬疑推理包-伏笔建议";
    render(
      <PromptManagerPrototype
        initialModel={{
          ...defaults,
          prompts: defaults.prompts.map((prompt) =>
            prompt.name === targetName ? { ...prompt, enabled: true } : prompt,
          ),
        }}
      />,
    );

    expect(await screen.findByLabelText("提示词正文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /当前启用集/ }));
    expect(screen.getByText("最终启用顺序")).toBeInTheDocument();
    expect(screen.queryByText(targetName)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "悬疑" }));
    expect(screen.getByText(targetName)).toBeInTheDocument();

    fireEvent.click(screen.getByText(targetName));
    expect(await screen.findByLabelText("提示词正文")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: `停用提示词 ${targetName}`,
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("creates a prompt and opens the full markdown editor with ordered metadata", async () => {
    render(<PromptManagerPrototype />);

    fireEvent.click(screen.getByRole("button", { name: "新增提示词" }));
    fireEvent.change(screen.getByLabelText("提示词名称"), {
      target: { value: "章节续写" },
    });
    fireEvent.change(screen.getByLabelText("稳定 ID"), {
      target: { value: "novel.chapter.continue" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并编辑" }));

    const title = screen.getByRole("heading", { name: "章节续写" });
    const titleRow = title.parentElement;
    expect(titleRow).not.toBeNull();
    const metadataText = titleRow!.textContent ?? "";
    expect(metadataText.indexOf("章节续写")).toBeLessThan(
      metadataText.indexOf("v1.0.0"),
    );
    expect(metadataText.indexOf("v1.0.0")).toBeLessThan(
      metadataText.indexOf("My Novel Studio 小说提示词库"),
    );

    expect(screen.getByLabelText("完整分组路径")).toHaveTextContent(
      "My Novel Studio 小说提示词库",
    );
    expect(screen.getByLabelText("完整分组路径")).toHaveTextContent(
      "novel.chapter.continue",
    );
    const editor = await screen.findByLabelText("提示词正文");
    expect(editor).toHaveClass("novel-markdown-content--full");
    expect(screen.getByRole("button", { name: "继承" })).toBeInTheDocument();
  });

  it("creates a skill pack before creating and editing its directory", () => {
    render(
      <PromptManagerPrototype
        initialModel={{ packs: [], groups: [], prompts: [] }}
      />,
    );

    const skillPackButtons = screen.getAllByRole("button", { name: "技能包" });
    fireEvent.click(skillPackButtons[skillPackButtons.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: "新建本地技能包" }));
    fireEvent.change(screen.getByLabelText("技能包名称"), {
      target: { value: "章节写作包" },
    });
    fireEvent.change(screen.getByLabelText("技能包说明"), {
      target: { value: "管理章节规划与续写提示词" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建技能包" }));
    expect(screen.getAllByText("章节写作包").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "目录" }));
    expect(screen.getAllByText("目录管理").length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "在 章节写作包 下新建目录" }),
    );
    fireEvent.change(screen.getByLabelText("目录名称"), {
      target: { value: "章节规划" },
    });
    fireEvent.change(screen.getByLabelText("目录说明"), {
      target: { value: "这里是目录的详细说明" },
    });
    expect(
      screen.getByRole("button", { name: "所属技能包" }),
    ).toHaveTextContent("章节写作包");
    fireEvent.click(screen.getByRole("button", { name: "创建目录" }));

    const directoryName = screen.getByText("章节规划");
    const packSection = directoryName.closest("section");
    expect(packSection).not.toBeNull();
    expect(within(packSection!).getByText("章节写作包")).toBeInTheDocument();
    expect(screen.queryByText("这里是目录的详细说明")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "编辑目录 章节规划" }));
    expect(
      screen.getByRole("heading", { name: "编辑目录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("这里是目录的详细说明"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭目录弹窗" }));

    fireEvent.click(
      screen.getByRole("button", { name: "技能包", pressed: false }),
    );
    expect(
      screen.getByRole("button", { name: "从 GitHub 安装技能包" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "从 GitHub 安装技能包" }),
    );
    expect(screen.getByDisplayValue(/github\.com\/author/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "读取清单" }));
    expect(
      screen.getByText("目录层级将一对一复制，安装后可自由编辑"),
    ).toBeInTheDocument();
    expect(screen.getByText("power-system")).toBeInTheDocument();
  });

  it("reinstalls a skill pack as a new copy and blocks prompt conflicts", () => {
    render(<PromptManagerPrototype />);

    const skillPackButtons = screen.getAllByRole("button", { name: "技能包" });
    fireEvent.click(skillPackButtons[skillPackButtons.length - 1]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "重新安装为新副本" })[0],
    );
    expect(
      screen.getAllByText("My Novel Studio 小说提示词库 · 副本 2").length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: /当前启用集/ }));
    expect(screen.getByText("检测到 40 组提示词冲突")).toBeInTheDocument();
    const executableLabel = screen.getByText(/项可执行/);
    expect(executableLabel.parentElement).toHaveTextContent("1 项可执行");

    fireEvent.click(
      screen.getByRole("button", {
        name: "保留 My Novel Studio 小说提示词库 · 副本 2，处理 novel.world.guide 冲突",
      }),
    );
    expect(screen.getByText("检测到 39 组提示词冲突")).toBeInTheDocument();
  });
});
