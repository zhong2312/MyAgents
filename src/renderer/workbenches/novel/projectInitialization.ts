import {
  WORKBENCH_PROJECT_INITIALIZATION_VERSION,
  type WorkbenchProjectInitialization,
  type WorkbenchProjectTextFile,
} from "@/workbench-sdk";

import { createSettingLibraryInitializationFiles } from "./settingLibraryRepository";
import { createPromptLibraryInitializationFiles } from "./promptLibraryRepository";
import { createItemLibraryInitializationFiles } from "./itemLibraryRepository";
import { createCharacterLibraryInitializationFiles } from "./characterLibraryRepository";
import { createLocationLibraryInitializationFiles } from "./locationLibraryRepository";
import { createTimelineLibraryInitializationFiles } from "./timelineLibraryRepository";
import { createPowerSystemInitializationFiles } from "./powerSystemRepository";
import { createNarrativeStudioInitializationFiles } from "./narrativeStudioRepository";
import {
  createEmptyFactionLibrary,
  serializeFactionLibrary,
} from "./factionLibrarySchema";

export interface NovelProjectInitializationInput {
  readonly projectId: string;
  readonly title: string;
  readonly genres: readonly string[];
  readonly targetWordCount: number;
  readonly createdAt: string;
}

const DIRECTORIES = [
  "manuscript/chapters",
  "outline/volumes",
  "outline/scenes",
  "story",
  "inspiration",
  "settings",
  "characters",
  "characters/proposals",
  "world/locations",
  "world/factions",
  "world/items",
  "world/items/records",
  "world/items/pages",
  "world/items/proposals",
  "world/power-systems/records",
  "world/power-systems/pages",
  "world/power-systems/proposals",
  "world/codex",
  "world/setting-library/pages",
  "world/setting-library/entries",
  "world/setting-library/proposals",
  "timeline",
  "research/notes",
  "assets/images",
  "assets/references",
  "knowledge",
  "prompts/installations",
] as const;

const EMPTY_DIRECTORY_MARKERS = [
  "manuscript/chapters/.gitkeep",
  "outline/volumes/.gitkeep",
  "outline/scenes/.gitkeep",
  "research/notes/.gitkeep",
  "assets/images/.gitkeep",
  "assets/references/.gitkeep",
] as const;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function createIndex(key: string): string {
  return json({ schemaVersion: 1, [key]: [] });
}

function createOutline(): string {
  return `# 故事大纲

## 故事总纲

## 核心冲突

## 主线与支线

## 分卷规划

## 场景规划
`;
}

function createFiles(
  input: NovelProjectInitializationInput,
): WorkbenchProjectTextFile[] {
  const title = markdownTitle(input.title);
  const files: WorkbenchProjectTextFile[] = [
    {
      path: "novel.json",
      content: json({
        schemaVersion: 1,
        projectId: input.projectId,
        workbenchId: "io.myagents.novel",
        title: input.title.trim(),
        genres: input.genres,
        targetWordCount: input.targetWordCount,
        status: "planning",
        language: "zh-CN",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }),
    },
    {
      path: "README.md",
      content: `# ${title}

本目录是《${title}》的完整项目根目录。Markdown 与 JSON 是可人工编辑、可由 Git 管理的事实源；向量索引和派生检索图谱由 MyAgents 在工作区外重建。
`,
    },
    {
      path: ".gitignore",
      content: `# Operating system and editor files
.DS_Store
Thumbs.db
*.swp
*.tmp
`,
    },
    {
      path: "manuscript/index.json",
      content: json({ schemaVersion: 1, nextChapterNumber: 1, chapters: [] }),
    },
    { path: "outline/outline.md", content: createOutline() },
    {
      path: "outline/volumes.json",
      content: json({ schemaVersion: 1, nextVolumeNumber: 1, volumes: [] }),
    },
    { path: "outline/plotlines.json", content: createIndex("plotlines") },
    {
      path: "story/core.md",
      content: `# 故事核心

## 一句话故事

## 核心冲突

## 主角目标

## 故事承诺
`,
    },
    {
      path: "story/themes.md",
      content: `# 主题与表达

## 核心主题

## 情绪基调

## 叙事视角
`,
    },
    ...createCharacterLibraryInitializationFiles(),
    {
      path: "world/worldview.md",
      content: `# 世界观

## 时空背景

## 社会结构

## 地理与环境

## 历史与事件
`,
    },
    {
      path: "world/power-system.md",
      content: `# 力量体系

## 基本规则

## 等级与代价

## 边界与例外
`,
    },
    ...createPowerSystemInitializationFiles(),
    { path: "world/rules.json", content: createIndex("rules") },
    ...createLocationLibraryInitializationFiles(),
    {
      path: "world/factions/index.json",
      content: serializeFactionLibrary(createEmptyFactionLibrary()),
    },
    ...createItemLibraryInitializationFiles(),
    { path: "world/codex/index.json", content: createIndex("entries") },
    ...createSettingLibraryInitializationFiles(input.title),
    ...createPromptLibraryInitializationFiles(),
    ...createTimelineLibraryInitializationFiles(input.createdAt),
    ...createNarrativeStudioInitializationFiles({
      title: input.title,
      genres: input.genres,
      createdAt: input.createdAt,
    }),
    { path: "research/index.json", content: createIndex("sources") },
    { path: "knowledge/entities.json", content: createIndex("entities") },
    { path: "knowledge/relations.json", content: createIndex("relations") },
    { path: "knowledge/facts.json", content: createIndex("facts") },
    {
      path: "assets/README.md",
      content: `# 素材

- \`images/\`：封面、插图和地图等项目图片。
- \`references/\`：项目需要随 Git 保存的参考附件。
`,
    },
  ];

  for (const path of EMPTY_DIRECTORY_MARKERS) files.push({ path, content: "" });
  return files;
}

export function createNovelProjectInitialization(
  input: NovelProjectInitializationInput,
): WorkbenchProjectInitialization {
  return Object.freeze({
    version: WORKBENCH_PROJECT_INITIALIZATION_VERSION,
    directories: Object.freeze([...DIRECTORIES]),
    files: Object.freeze(createFiles(input).map((file) => Object.freeze(file))),
    initializeGit: false,
  });
}
