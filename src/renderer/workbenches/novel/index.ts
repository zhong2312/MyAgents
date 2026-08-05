import { defineWorkbench } from "@/workbench-sdk";

const novelWorkbenchDefinition = defineWorkbench(
  {
    manifestVersion: 1,
    id: "io.myagents.novel",
    name: "小说工作台",
    description: "面向长篇与短篇小说创作的本地工作台",
    version: "0.3.0",
    api: {
      major: 1,
      minMinor: 8,
      maxMinor: 8,
    },
    entry: {
      renderer: "builtin-novel",
      defaultRoute: "overview",
    },
    navigation: [
      { id: "overview", label: "总览", icon: "layout-dashboard", order: 10 },

      { id: "worldbuilding", label: "设定", icon: "layers-3", order: 20 },
      { id: "lore", label: "世界架构", parentId: "worldbuilding", order: 10 },
      { id: "powers", label: "修炼体系", parentId: "worldbuilding", order: 20 },
      { id: "items", label: "物品", parentId: "worldbuilding", order: 30 },
      { id: "map", label: "世界地图", parentId: "worldbuilding", order: 40 },

      { id: "creation", label: "创作", icon: "clapperboard", order: 30 },
      { id: "characters", label: "人物", parentId: "creation", order: 10 },
      { id: "factions", label: "势力组织", parentId: "creation", order: 20 },
      { id: "timeline", label: "时间线", parentId: "creation", order: 30 },
      { id: "narrative", label: "剧情规划", parentId: "creation", order: 40 },
      { id: "inspiration", label: "灵感", parentId: "creation", order: 50 },

      { id: "manuscript", label: "正文", icon: "file-text", order: 40 },

      { id: "utilities", label: "辅助", icon: "boxes", order: 50 },
      { id: "knowledge", label: "知识库", parentId: "utilities", order: 10 },
      { id: "research", label: "资料", parentId: "utilities", order: 20 },
      { id: "simulation", label: "世界推演", icon: "orbit", order: 55 },
      { id: "simulation-console", label: "运行控制台", parentId: "simulation", order: 10 },
      { id: "simulation-lab", label: "世界实验室", parentId: "simulation", order: 20 },
      { id: "simulation-council", label: "立场会商", parentId: "simulation", order: 30 },

      { id: "settings", label: "设置", icon: "settings-2", order: 60 },
      { id: "ai-prompts", label: "提示词", parentId: "settings", order: 10 },
      { id: "lore-config", label: "设定模板", parentId: "settings", order: 20 },
      { id: "model-scenes", label: "模型场景", parentId: "settings", order: 30 },
    ],
    capabilities: [
      "storage",
      "agent-session",
      "agent-dialog",
    ],
  },
  () => import("./renderer"),
  {
    shell: {
      defaultNavigationCollapsed: true,
    },
    loadAgentCompanion: () => import("./ManuscriptAgentCompanion"),
    launcher: {
      createLabel: "新建小说",
      projectTypeLabel: "小说",
      icon: "book-open",
      order: 10,
      loadProjectCreator: () => import("./NovelProjectCreator"),
    },
  },
);

export default novelWorkbenchDefinition;
