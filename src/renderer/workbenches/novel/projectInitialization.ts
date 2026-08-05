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
import { createCultivationEcologyInitializationFiles } from "./cultivationEcologyRepository";
import { createInspirationInitializationFile } from "./inspirationRepository";
import { createNarrativeEngineeringInitializationFiles } from "./narrativeEngineeringRepository";
import { createWorldSimulationV2InitializationFiles } from "./worldSimulationRepositoryV2";
import {
  createEmptyFactionLibrary,
  serializeFactionLibrary,
} from "./factionLibrarySchema";
import {
  createEmptyNovelChapterIndex,
  serializeNovelChapterIndex,
} from "./projectSchema";
import {
  createEmptyManuscriptTrackingLedger,
  createEmptyManuscriptContinuityState,
  MANUSCRIPT_CONTINUITY_PATH,
  MANUSCRIPT_TRACKING_PATH,
  serializeManuscriptContinuityState,
  serializeManuscriptTrackingLedger,
} from "./manuscriptTrackingSchema";

export interface NovelProjectInitializationInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly genres: readonly string[];
  readonly targetWordCountMin: number;
  readonly targetWordCountMax: number;
  readonly chapterWordCount: number;
  readonly createdAt: string;
  /** 创作语言，如 zh-CN / en-US；默认 zh-CN。 */
  readonly language?: string;
}

const DIRECTORIES = [
  "manuscript/chapters",
  "manuscript/trash",
  "narrative",
  "inspiration",
  "settings",
  "characters",
  "characters/records",
  "characters/proposals",
  "world/locations",
  "world/factions",
  "world/items",
  "world/items/records",
  "world/items/pages",
  "world/items/proposals",
  "world/cultivation-ecology",
  "world/setting-library/pages",
  "world/setting-library/entries",
  "world/setting-library/proposals",
  "world/maps",
  "world/maps/records",
  "world/maps/proposals",
  "world/maps/trash",
  "world/cultivation-proposals",
  "timeline",
  "simulation",
  "simulation/runs",
  "research/notes",
  "assets/images",
  "assets/references",
  "knowledge",
  "prompts/installations",
] as const;

const EMPTY_DIRECTORY_MARKERS = [
  "manuscript/chapters/.gitkeep",
  "characters/records/.gitkeep",
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

function createFiles(
  input: NovelProjectInitializationInput,
): WorkbenchProjectTextFile[] {
  const projectName = markdownTitle(input.projectName);
  const files: WorkbenchProjectTextFile[] = [
    {
      path: "novel.json",
      content: json({
        schemaVersion: 1,
        projectId: input.projectId,
        workbenchId: "io.myagents.novel",
        projectName: input.projectName.trim(),
        title: input.title.trim(),
        genres: input.genres,
        targetWordCountMin: input.targetWordCountMin,
        targetWordCountMax: input.targetWordCountMax,
        chapterWordCount: input.chapterWordCount,
        status: "planning",
        language: input.language?.trim() || "zh-CN",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }),
    },
    {
      path: "README.md",
      content: `# ${projectName}

本目录是小说项目的完整根目录，当前书名与创作目标以 \`novel.json\` 为准。Markdown 与 JSON 是可人工编辑、可由 Git 管理的事实源；向量索引和派生检索图谱由 MyAgents 在工作区外重建。
`,
    },
    {
      path: ".gitignore",
      content: `# Operating system and editor files
.DS_Store
Thumbs.db
*.swp
*.tmp

# 可从项目事实源重新构建的派生投影。
.cache/
`,
    },
    {
      path: "manuscript/index.json",
      content: serializeNovelChapterIndex(createEmptyNovelChapterIndex()),
    },
    {
      path: MANUSCRIPT_TRACKING_PATH,
      content: serializeManuscriptTrackingLedger(
        createEmptyManuscriptTrackingLedger(input.createdAt),
      ),
    },
    {
      path: MANUSCRIPT_CONTINUITY_PATH,
      content: serializeManuscriptContinuityState(
        createEmptyManuscriptContinuityState(input.createdAt),
      ),
    },
    ...createNarrativeEngineeringInitializationFiles(input.createdAt),
    ...createCharacterLibraryInitializationFiles(),
    ...createCultivationEcologyInitializationFiles(),
    ...createLocationLibraryInitializationFiles(),
    {
      path: "world/factions/index.json",
      content: serializeFactionLibrary(createEmptyFactionLibrary()),
    },
    ...createItemLibraryInitializationFiles(),
    ...createSettingLibraryInitializationFiles(input.title),
    ...createPromptLibraryInitializationFiles(),
    ...createTimelineLibraryInitializationFiles(input.createdAt),
    ...createWorldSimulationV2InitializationFiles(),
    createInspirationInitializationFile(input.createdAt),
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
