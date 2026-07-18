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
      minMinor: 4,
      maxMinor: 4,
    },
    entry: {
      renderer: "builtin-novel",
      defaultRoute: "overview",
    },
    navigation: [
      { id: "overview", label: "总览", icon: "layout-dashboard", order: 10 },
      { id: "manuscript", label: "正文", icon: "file-text", order: 20 },
      { id: "outline", label: "大纲", icon: "list-tree", order: 30 },
      { id: "lore", label: "世界架构", icon: "network", order: 40 },
      {
        id: "lore-config",
        label: "模板配置",
        icon: "layout-template",
        order: 45,
      },
      { id: "knowledge", label: "知识库", icon: "database-search", order: 47 },
      { id: "map", label: "世界地图", icon: "map", order: 50 },
      { id: "timeline", label: "时间线", icon: "clock-3", order: 60 },
      { id: "research", label: "资料", icon: "library", order: 70 },
      { id: "ai-prompts", label: "提示词", icon: "code-2", order: 80 },
    ],
    capabilities: ["storage", "agent-session", "agent-dialog"],
  },
  () => import("./renderer"),
  {
    shell: {
      defaultNavigationCollapsed: true,
    },
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
