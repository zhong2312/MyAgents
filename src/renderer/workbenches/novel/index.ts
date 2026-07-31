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
      minMinor: 7,
      maxMinor: 7,
    },
    entry: {
      renderer: "builtin-novel",
      defaultRoute: "overview",
    },
    navigation: [
      { id: "overview", label: "总览", icon: "layout-dashboard", order: 10 },
      { id: "inspiration", label: "灵感", icon: "lightbulb", order: 20 },
      { id: "manuscript", label: "正文", icon: "file-text", order: 30 },
      { id: "narrative", label: "剧情工程", icon: "route", order: 40 },
      { id: "characters", label: "人物库", icon: "users", order: 50 },
      { id: "items", label: "物品库", icon: "package-open", order: 55 },
      { id: "factions", label: "势力组织", icon: "building-2", order: 57 },
      { id: "powers", label: "修炼体系", icon: "waypoints", order: 59 },
      { id: "lore", label: "世界架构", icon: "network", order: 60 },
      {
        id: "lore-config",
        label: "模板配置",
        icon: "layout-template",
        order: 45,
      },
      { id: "knowledge", label: "知识库", icon: "database-search", order: 47 },
      { id: "map", label: "世界地图", icon: "map", order: 50 },
      { id: "simulation", label: "世界推演", icon: "orbit", order: 55 },
      {
        id: "simulation-lab",
        label: "世界实验室",
        parentId: "simulation",
        order: 10,
      },
      { id: "timeline", label: "时间线", icon: "clock-3", order: 60 },
      { id: "research", label: "资料", icon: "library", order: 70 },
      {
        id: "ai-prompts",
        label: "提示词",
        icon: "code-2",
        parentId: "settings",
        order: 20,
      },
      { id: "settings", label: "设置", icon: "settings-2", order: 90 },
      {
        id: "model-scenes",
        label: "模型场景",
        parentId: "settings",
        order: 10,
      },
    ],
    capabilities: [
      "storage",
      "agent-session",
      "agent-dialog",
      "world-simulation",
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
