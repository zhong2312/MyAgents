import type {
  PromptDefinition,
  PromptGroup,
  PromptLibraryModel,
  PromptScope,
  PromptSkillPack,
} from "./promptLibrarySchema";
import {
  GENRE_PACK_SEEDS,
  GENRE_PACKS,
} from "./storyforge-prompt-seeds/prompt-seeds-genre-packs";
import { EXTENDED_GENRE_PACK_SEEDS } from "./storyforge-prompt-seeds/prompt-seeds-genre-packs-extended";
import {
  SYSTEM_PROMPT_SEEDS,
  type PromptSeed,
} from "./storyforge-prompt-seeds/prompt-seeds";

export const STORYFORGE_PROMPT_INSTALLATION_ID = "storyforge.prompt-library";
export const STORYFORGE_WORLD_GUIDE_PROMPT_ID = "novel.world.guide";
export const STORYFORGE_PROMPT_COUNT = 89;

const STORYFORGE_VERSION = "3.7.5";
const ROOT_GROUP_ID = `${STORYFORGE_PROMPT_INSTALLATION_ID}:root`;
const PROMPTS_GROUP_ID = `${STORYFORGE_PROMPT_INSTALLATION_ID}:prompts`;
const GENERAL_GROUP_ID = `${STORYFORGE_PROMPT_INSTALLATION_ID}:general`;
const GENRE_PACKS_GROUP_ID = `${STORYFORGE_PROMPT_INSTALLATION_ID}:genre-packs`;

const GENRE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  lishi: [
    "历史",
    "架空历史",
    "秦汉三国",
    "两晋隋唐",
    "宋元明清",
    "民国谍战",
  ],
  xianxia: [
    "仙侠",
    "修真文明",
    "幻想修仙",
    "古典仙侠",
    "现代修真",
    "仙侠奇缘",
  ],
  yanqing: [
    "现代言情",
    "古代言情",
    "青春甜宠",
    "豪门总裁",
    "职场婚恋",
    "宫闱宅斗",
    "玄幻言情",
    "仙侠奇缘",
    "科幻空间",
    "无限快穿",
    "兽世",
  ],
  realism: ["现实生活", "社会纪实", "家庭伦理", "乡土生活"],
  suspense: [
    "悬疑",
    "推理侦探",
    "诡秘悬疑",
    "惊悚恐怖",
    "探险盗墓",
  ],
  xuanhuan: [
    "玄幻",
    "东方玄幻",
    "异世大陆",
    "王朝争霸",
    "高武世界",
    "玄幻言情",
  ],
  wuxia: ["武侠", "传统武侠", "现代武侠", "国术无双", "武侠幻想"],
  dushi: [
    "都市",
    "都市生活",
    "都市异能",
    "青春校园",
    "娱乐明星",
    "商战职场",
  ],
  scifi: ["科幻", "未来世界", "星际文明", "时空穿梭", "科幻空间"],
  moshi: ["末世", "进化变异"],
  chuanyue: ["穿越", "时空穿梭", "无限快穿"],
  chongsheng: ["重生"],
  xitong: ["系统流"],
  wuxian: ["无限流", "无限快穿"],
  cyberpunk: ["赛博朋克"],
  cthulhu: ["克苏鲁", "诡秘悬疑", "惊悚恐怖"],
  zhongtian: ["种田", "乡土生活"],
  zhengba: ["争霸", "王朝争霸", "战争幻想"],
  xifan: ["奇幻", "剑与魔法", "史诗奇幻", "西方奇幻"],
  youxi: ["游戏", "虚拟网游", "电子竞技", "游戏异界"],
};

const DIRECTORY_LABELS: Readonly<Record<string, string>> = {
  general: "通用提示词",
  "genre-packs": "题材包",
  worldview: "世界观",
  dimension: "维度生成",
  character: "角色",
  generate: "生成",
  outline: "大纲",
  volume: "分卷",
  chapter: "章节",
  content: "正文",
  continue: "续写",
  memory: "连续性记忆",
  polish: "润色",
  expand: "扩写",
  "de-ai": "去 AI 味",
  detect: "诊断",
  foreshadow: "伏笔",
  relation: "角色关系",
  extract: "提取",
  geography: "地理与地图",
  "concept-map": "概念地图",
  "world-map": "世界地图",
  "image-map-prompt": "地图图像提示词",
  story: "故事核心",
  rules: "创作规则",
  import: "导入解析",
  "parse-character": "角色解析",
  "parse-worldview": "世界观解析",
  "parse-outline": "大纲解析",
  "parse-all": "统一解析",
  "parse-chunk": "分块解析",
  "merge-characters": "角色合并",
  detail: "细纲",
  scene: "场景",
  plot: "剧情",
  "character-driven": "角色驱动",
  inspiration: "灵感反推",
  reverse: "单世界",
  multiworld: "多世界",
  "world-group": "世界组",
  suggest: "建议",
  codex: "词条",
  location: "地点",
  inventory: "物品",
  "story-timeline": "故事年表",
  verify: "考证",
  style: "文风",
  learn: "学习",
  history: "历史辅助",
  consult: "考据",
  storm: "头脑风暴",
  book: "全书编辑",
  edit: "编辑",
};

const extendedSeeds = new Set<PromptSeed>(EXTENDED_GENRE_PACK_SEEDS);
const genreSeeds = new Set<PromptSeed>(GENRE_PACK_SEEDS);
const genreMetadata = new Map(GENRE_PACKS.map((pack) => [pack.id, pack]));

function scopeForGenre(genreId: string | undefined): PromptScope {
  if (!genreId) return { kind: "global" };
  const genres = GENRE_SCOPES[genreId];
  if (!genres) throw new Error(`StoryForge 题材缺少作用域映射：${genreId}`);
  return { kind: "genres", genres };
}

function directoryLabel(segment: string): string {
  return genreMetadata.get(segment)?.label ?? DIRECTORY_LABELS[segment] ?? segment;
}

function groupId(path: string): string {
  return `${STORYFORGE_PROMPT_INSTALLATION_ID}:group:${path.replaceAll("/", ".")}`;
}

function sourceFileFor(seed: PromptSeed): string {
  if (extendedSeeds.has(seed)) {
    return "src/lib/ai/prompt-seeds-genre-packs-extended.ts";
  }
  if (genreSeeds.has(seed)) {
    return "src/lib/ai/prompt-seeds-genre-packs.ts";
  }
  return "src/lib/ai/prompt-seeds.ts";
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderPromptMarkdown(seed: PromptSeed): string {
  const metadata = {
    sourceProject: "StoryForge",
    sourceVersion: STORYFORGE_VERSION,
    sourceFile: sourceFileFor(seed),
    moduleKey: seed.moduleKey,
    promptType: seed.promptType,
    variables: seed.variables,
    genres: seed.genres ?? [],
    isDefault: seed.isDefault ?? false,
    lengthMode: seed.lengthMode ?? null,
    continuityMode: seed.continuityMode ?? null,
    modelOverride: seed.modelOverride ?? null,
  };
  const sections = [
    `# ${seed.name}`,
    seed.description ? `> ${seed.description}` : "",
    "## 系统提示词",
    seed.systemPrompt.trim(),
    "## 用户提示词模板",
    seed.userPromptTemplate.trim(),
    "## 模板元数据",
    jsonBlock(metadata),
  ];
  if (seed.parameters?.length) {
    sections.push("## 可调参数", jsonBlock(seed.parameters));
  }
  if (seed.examples) {
    sections.push("## 示例", jsonBlock(seed.examples));
  }
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

function stablePromptId(
  seed: PromptSeed,
  index: number,
  variant: number,
): string {
  if (index === 0) return STORYFORGE_WORLD_GUIDE_PROMPT_ID;
  const genre = seed.genres?.[0] ?? "general";
  const base = `storyforge.${genre}.${seed.moduleKey}.${seed.promptType}`;
  return variant === 1 ? base : `${base}.variant-${variant}`;
}

function promptSourcePath(
  seed: PromptSeed,
  variant: number,
): { readonly directory: string; readonly path: string } {
  const genre = seed.genres?.[0];
  const category = genre ? `genre-packs/${genre}` : "general";
  const directory = `prompts/${category}/${seed.moduleKey.replaceAll(".", "/")}`;
  const filename = `${seed.promptType}${variant === 1 ? "" : `-${variant}`}.md`;
  return { directory, path: `${directory}/${filename}` };
}

function createGroup(
  id: string,
  name: string,
  parentId: string | null,
  nodeKind: PromptGroup["nodeKind"],
  sourcePath: string,
  scope: PromptScope,
  description = sourcePath,
): PromptGroup {
  return Object.freeze({
    id,
    name,
    description,
    parentId,
    nodeKind,
    skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
    sourcePath,
    userCreated: false,
    modified: false,
    enabled: true,
    scope,
  });
}

function createStoryForgeModel(): PromptLibraryModel {
  if (SYSTEM_PROMPT_SEEDS.length !== STORYFORGE_PROMPT_COUNT) {
    throw new Error(
      `StoryForge 提示词快照数量异常：预期 ${STORYFORGE_PROMPT_COUNT}，实际 ${SYSTEM_PROMPT_SEEDS.length}`,
    );
  }

  const pack: PromptSkillPack = Object.freeze({
    id: STORYFORGE_PROMPT_INSTALLATION_ID,
    packageId: STORYFORGE_PROMPT_INSTALLATION_ID,
    name: "StoryForge 小说提示词库",
    source: "builtin",
    repository: "zhong2312/storyforge",
    version: STORYFORGE_VERSION,
    enabled: true,
    updatedAt: "2026-07-16",
    description: "从 StoryForge 3.7.5 导入的完整小说提示词快照",
    copyNumber: 1,
    modified: false,
  });
  const groups: PromptGroup[] = [
    createGroup(
      ROOT_GROUP_ID,
      pack.name,
      null,
      "pack-root",
      "",
      { kind: "global" },
      pack.description,
    ),
    createGroup(
      PROMPTS_GROUP_ID,
      "prompts",
      ROOT_GROUP_ID,
      "directory",
      "prompts",
      { kind: "global" },
    ),
    createGroup(
      GENERAL_GROUP_ID,
      "通用提示词",
      PROMPTS_GROUP_ID,
      "directory",
      "prompts/general",
      { kind: "global" },
      genreMetadata.get("general")?.description ?? "StoryForge 通用提示词",
    ),
    createGroup(
      GENRE_PACKS_GROUP_ID,
      "题材包",
      PROMPTS_GROUP_ID,
      "directory",
      "prompts/genre-packs",
      { kind: "global" },
      "StoryForge 题材模板，按小说题材决定是否进入启用集",
    ),
  ];
  const groupsByPath = new Map<string, PromptGroup>(
    groups
      .filter((group) => group.sourcePath)
      .map((group) => [group.sourcePath, group]),
  );
  const promptVariants = new Map<string, number>();
  const prompts: PromptDefinition[] = [];

  SYSTEM_PROMPT_SEEDS.forEach((seed, index) => {
    const genreId = seed.genres?.[0];
    const variantKey = `${genreId ?? "general"}:${seed.moduleKey}:${seed.promptType}`;
    const variant = (promptVariants.get(variantKey) ?? 0) + 1;
    promptVariants.set(variantKey, variant);
    const source = promptSourcePath(seed, variant);
    const scope = scopeForGenre(genreId);
    const basePath = genreId
      ? `prompts/genre-packs/${genreId}`
      : "prompts/general";
    if (genreId && !groupsByPath.has(basePath)) {
      const metadata = genreMetadata.get(genreId);
      const group = createGroup(
        groupId(basePath),
        metadata?.label ?? genreId,
        GENRE_PACKS_GROUP_ID,
        "directory",
        basePath,
        scope,
        metadata?.description ?? basePath,
      );
      groups.push(group);
      groupsByPath.set(basePath, group);
    }

    let parent = groupsByPath.get(basePath);
    if (!parent) throw new Error(`StoryForge 目录根节点不存在：${basePath}`);
    const moduleSegments = seed.moduleKey.split(".");
    let currentPath = basePath;
    for (const segment of moduleSegments) {
      currentPath = `${currentPath}/${segment}`;
      let current = groupsByPath.get(currentPath);
      if (!current) {
        current = createGroup(
          groupId(currentPath),
          directoryLabel(segment),
          parent.id,
          "directory",
          currentPath,
          scope,
        );
        groups.push(current);
        groupsByPath.set(currentPath, current);
      }
      parent = current;
    }

    const id = stablePromptId(seed, index, variant);
    prompts.push(
      Object.freeze({
        instanceId: `${STORYFORGE_PROMPT_INSTALLATION_ID}:${id}`,
        id,
        name: seed.name,
        groupId: parent.id,
        version: STORYFORGE_VERSION,
        enabled: seed.isActive,
        overridden: false,
        skillPackId: STORYFORGE_PROMPT_INSTALLATION_ID,
        scopeOverride: null,
        content: renderPromptMarkdown(seed),
        sourcePath: source.path,
      }),
    );
  });

  return Object.freeze({
    packs: Object.freeze([pack]),
    groups: Object.freeze(groups),
    prompts: Object.freeze(prompts),
  });
}

const STORYFORGE_MODEL = createStoryForgeModel();

export function createDefaultPromptLibraryModel(): PromptLibraryModel {
  return STORYFORGE_MODEL;
}
