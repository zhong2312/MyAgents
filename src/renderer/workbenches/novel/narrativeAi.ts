import type { CharacterRecord } from "./characterLibrarySchema";
import type {
  NarrativeAuditFinding,
  NarrativeWorkspaceView,
} from "./NarrativeAudit";
import type { NarrativeEngineering } from "./narrativeEngineeringSchema";
import type { LoadedNovelChapter } from "./repository";

export type NarrativeAiTaskId =
  | "current"
  | "outline"
  | "structure"
  | "weaving"
  | "chapters";

export interface NarrativeAiSelection {
  readonly view: NarrativeWorkspaceView;
  readonly selectedLineId: string;
  readonly selectedArcId: string;
  readonly selectedDirectoryId: string;
  readonly selectedChapterId: string;
}

export interface NarrativeAiAgentRequest {
  readonly task: NarrativeAiTaskId;
  readonly title: string;
  readonly initialMessage: string;
  readonly conversationKey: string;
  readonly historyGroupPath: readonly string[];
}

export const NARRATIVE_AI_TASKS: readonly {
  readonly id: NarrativeAiTaskId;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "current",
    label: "分析当前视图",
    description: "围绕当前选中的线路、故事弧、目录、章节或检查项给出建议。",
  },
  {
    id: "outline",
    label: "大纲结构规划",
    description: "规划卷、篇、组的层级、子主题与章节归属，并识别目录缺口。",
  },
  {
    id: "structure",
    label: "全局结构体检",
    description: "检查主线、支线、故事弧、章节分布和节奏缺口。",
  },
  {
    id: "weaving",
    label: "线路与故事弧编织",
    description: "寻找线路交汇、角色弧拐点和章/节关联的加强机会。",
  },
  {
    id: "chapters",
    label: "章节与节规划",
    description: "为当前目录创建章节候选，并在每章内拆分节与段规划。",
  },
];

const MAX_SNAPSHOT_LENGTH = 42_000;
const MAX_TEXT_LENGTH = 420;

function clip(value: string, limit = MAX_TEXT_LENGTH): string {
  const normalized = value.trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}…`;
}

function cap<T>(values: readonly T[], limit: number): T[] {
  return values.length <= limit ? [...values] : [...values.slice(0, limit)];
}

function selectedEntityLabel(
  library: NarrativeEngineering,
  selection: NarrativeAiSelection,
): string {
  if (selection.view === "lines") {
    return (
      library.lines.find((line) => line.id === selection.selectedLineId)
        ?.title ?? "未选择线路"
    );
  }
  if (selection.view === "arcs") {
    return (
      library.arcs.find((arc) => arc.id === selection.selectedArcId)?.title ??
      "未选择故事弧"
    );
  }
  if (selection.view === "outline") {
    return (
      library.directories.find(
        (directory) => directory.id === selection.selectedDirectoryId,
      )?.title ?? "未选择目录"
    );
  }
  if (selection.view === "chapters") {
    const chapter = library.chapters.find(
      (candidate) => candidate.id === selection.selectedChapterId,
    );
    if (chapter) return chapter.title;
    const directory = library.directories.find(
      (candidate) => candidate.id === selection.selectedDirectoryId,
    );
    return directory ? `目录：${directory.title}` : "未选择章节目录";
  }
  return selection.view === "audit" ? "叙事检查" : "全书剧情工程";
}

function buildSnapshot(
  library: NarrativeEngineering,
  characters: readonly CharacterRecord[],
  manuscriptChapters: readonly LoadedNovelChapter[],
  findings: readonly NarrativeAuditFinding[],
  selection: NarrativeAiSelection,
  hasUnsavedChanges: boolean,
): string {
  const selectedChapter = library.chapters.find(
    (chapter) => chapter.id === selection.selectedChapterId,
  );
  const snapshot = {
    schemaVersion: library.schemaVersion,
    currentView: selection.view,
    selectedEntity: selectedEntityLabel(library, selection),
    hasUnsavedChanges,
    counts: {
      lines: library.lines.length,
      arcs: library.arcs.length,
      directories: library.directories.length,
      plannedChapters: library.chapters.length,
      manuscriptChapters: manuscriptChapters.length,
      characters: characters.length,
      findings: findings.length,
    },
    lines: cap(library.lines, 120).map((line) => ({
      id: line.id,
      title: line.title,
      kind: line.kind,
      storyRole: line.storyRole,
      status: line.status,
      premise: clip(line.premise),
      protagonistCharacterId: line.protagonistCharacterId,
      content: clip(line.content, 240),
      keyNodes: cap(line.keyNodes, 20).map((node) => ({
        id: node.id,
        title: node.title,
        content: clip(node.content, 260),
        locations: node.locations,
      })),
    })),
    arcs: cap(library.arcs, 120).map((arc) => ({
      id: arc.id,
      title: arc.title,
      kind: arc.kind,
      characterId: arc.characterId,
      characterArcStageId: arc.characterArcStageId,
      characterArcStageTitle: clip(arc.characterArcStageTitle, 160),
      lineIds: arc.lineIds,
      content: clip(arc.content, 240),
      keyNodes: cap(arc.keyNodes, 20).map((node) => ({
        id: node.id,
        title: node.title,
        content: clip(node.content, 260),
        locations: node.locations,
      })),
    })),
    directories: cap(library.directories, 160).map((directory) => ({
      id: directory.id,
      parentId: directory.parentId,
      kind: directory.kind,
      title: directory.title,
      description: clip(directory.description, 220),
      order: directory.order,
    })),
    chapters: cap(library.chapters, 180).map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      directoryId: chapter.directoryId,
      manuscriptChapterId: chapter.manuscriptChapterId,
      status: chapter.status,
      order: chapter.order,
      description: clip(chapter.description),
      lineIds: chapter.lineIds,
      arcIds: chapter.arcIds,
      sections: cap(chapter.sections, 18).map((section) => ({
        id: section.id,
        title: clip(section.title, 140),
        description: clip(section.description, 260),
        povCharacterId: section.povCharacterId,
        lineIds: section.lineIds,
        arcIds: section.arcIds,
        paragraphCount: section.paragraphs.length,
        paragraphs: cap(section.paragraphs, 5).map((paragraph) =>
          clip(paragraph.content, 180),
        ),
      })),
    })),
    selectedChapter: selectedChapter
      ? {
          id: selectedChapter.id,
          title: selectedChapter.title,
          description: clip(selectedChapter.description, 1_200),
          sectionCount: selectedChapter.sections.length,
        }
      : null,
    characters: cap(characters, 160).map((character) => ({
      id: character.id,
      name: character.name,
      alias: character.alias,
      archetype: character.archetype,
      arc: clip(character.arc, 260),
      arcStages: cap(character.arcStages, 12).map((stage, index) => ({
        id: stage.id ?? `${character.id}-arc-stage-${index + 1}`,
        title: clip(stage.title, 120),
        state: clip(stage.state, 160),
      })),
    })),
    diagnostics: cap(findings, 80).map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      view: finding.view,
      entityId: finding.entityId ?? null,
    })),
    manuscriptIndex: cap(manuscriptChapters, 180).map((chapter) => ({
      id: chapter.id,
      number: chapter.displayNumber,
      title: chapter.title,
      words: chapter.words,
    })),
    omitted: {
      lines: Math.max(0, library.lines.length - 120),
      arcs: Math.max(0, library.arcs.length - 120),
      directories: Math.max(0, library.directories.length - 160),
      chapters: Math.max(0, library.chapters.length - 180),
      characters: Math.max(0, characters.length - 160),
      manuscriptChapters: Math.max(0, manuscriptChapters.length - 180),
    },
  };
  const serialized = JSON.stringify(snapshot, null, 2);
  if (serialized.length <= MAX_SNAPSHOT_LENGTH) return serialized;

  const compactSnapshot = {
    schemaVersion: library.schemaVersion,
    currentView: selection.view,
    selectedEntity: selectedEntityLabel(library, selection),
    hasUnsavedChanges,
    counts: snapshot.counts,
    lines: cap(library.lines, 80).map((line) => ({
      id: line.id,
      title: line.title,
      kind: line.kind,
      storyRole: line.storyRole,
      keyNodeCount: line.keyNodes.length,
    })),
    arcs: cap(library.arcs, 80).map((arc) => ({
      id: arc.id,
      title: arc.title,
      kind: arc.kind,
      characterId: arc.characterId,
      lineIds: arc.lineIds,
      keyNodeCount: arc.keyNodes.length,
    })),
    directories: cap(library.directories, 100).map((directory) => ({
      id: directory.id,
      parentId: directory.parentId,
      kind: directory.kind,
      title: directory.title,
    })),
    chapters: cap(library.chapters, 100).map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      directoryId: chapter.directoryId,
      order: chapter.order,
      lineIds: chapter.lineIds,
      arcIds: chapter.arcIds,
      sections: cap(chapter.sections, 8).map((section) => ({
        id: section.id,
        title: clip(section.title, 100),
        lineIds: section.lineIds,
        arcIds: section.arcIds,
      })),
    })),
    focus: {
      line:
        snapshot.lines.find((line) => line.id === selection.selectedLineId) ??
        null,
      arc:
        snapshot.arcs.find((arc) => arc.id === selection.selectedArcId) ?? null,
      directory:
        snapshot.directories.find(
          (directory) => directory.id === selection.selectedDirectoryId,
        ) ?? null,
      chapter:
        snapshot.chapters.find(
          (chapter) => chapter.id === selection.selectedChapterId,
        ) ?? null,
    },
    diagnostics: snapshot.diagnostics,
    omitted: snapshot.omitted,
    contextNote: "完整快照超过上下文预算，已保留全局索引和当前选中对象。",
  };
  return JSON.stringify(compactSnapshot, null, 2);
}

export function buildNarrativeAiAgentRequest({
  task,
  projectTitle,
  library,
  characters,
  manuscriptChapters,
  findings,
  selection,
  userInstruction,
  hasUnsavedChanges = false,
}: {
  readonly task: NarrativeAiTaskId;
  readonly projectTitle: string;
  readonly library: NarrativeEngineering;
  readonly characters: readonly CharacterRecord[];
  readonly manuscriptChapters: readonly LoadedNovelChapter[];
  readonly findings: readonly NarrativeAuditFinding[];
  readonly selection: NarrativeAiSelection;
  readonly userInstruction: string;
  readonly hasUnsavedChanges?: boolean;
}): NarrativeAiAgentRequest {
  const taskMeta = NARRATIVE_AI_TASKS.find(
    (candidate) => candidate.id === task,
  )!;
  const target = selectedEntityLabel(library, selection);
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const context = buildSnapshot(
    library,
    characters,
    manuscriptChapters,
    findings,
    selection,
    hasUnsavedChanges,
  );
  const proposalMutationRule =
    "更新已有线路、故事弧、目录或章节时，必须在对应 upsert 工具中填写 targetId，且 targetId 必须是上下文中已有对象的稳定 ID。更新章节时，既有节和段也必须分别用 targetId 保留稳定 ID；只有明确新增对象时才省略 targetId。不得仅因标题相同而新建副本。";
  const outlineTaskRule =
    task === "outline"
      ? '\n\n本次是大纲结构规划：只处理卷、篇、组的层级、每层的主题或时空边界和排序。若快照不足以判断已保存的目录状态，可按需调用 novel_narrative_get_context({ scope: "outline" })。作者要求实际创建或调整大纲时，必须用 novel_narrative_upsert_draft_directories 写入目录候选：父目录引用同一草稿的 candidateId 或已有目录稳定 ID，根卷使用 null。卷、篇、组属于目录，不得创建同名故事弧代替目录；本任务不得用章节候选代替目录。'
      : "";
  const chapterTaskRule =
    task === "chapters"
      ? '\n\n本次是章节与节规划：目标是创建或更新正式可审阅的章节候选，而不是修改大纲目录说明。先按需调用 novel_narrative_get_context({ scope: "chapters" }) 和 novel_narrative_get_context({ scope: "outline" }) 获取完整章节与目录事实，再调用 novel_narrative_upsert_draft_chapters。每章必须归属当前选中目录（或作者指定目录），至少包含一个有标题和简述的节；节内可按需要提供多个段规划。章和节可关联线路、故事弧，段不关联。新建章、节、段省略 targetId；更新既有章时必须提交完整章节结构，并为保留的章、节、段填写各自 targetId。不得创建或修改正文 Markdown。'
      : "";
  const defaultInstruction =
    task === "chapters"
      ? "请为当前选中的目录规划并创建章节与节候选；根据已有线路和故事弧拆分每章的节，必要时补充段规划。"
      : "请先给出最值得优先处理的三项建议。";
  const instruction = `${
    userInstruction.trim() || defaultInstruction
  }\n\n${proposalMutationRule}${outlineTaskRule}${chapterTaskRule}`;
  return {
    task,
    title: `剧情工程 · ${taskMeta.label}`,
    conversationKey: `novel.narrative.assist:${task}:${runId}`,
    historyGroupPath: ["剧情工程", taskMeta.label],
    initialMessage: `你是 MyAgents 小说工作台的“剧情工程 AI 助手”。\n\n项目：${projectTitle}\n当前视图：${selection.view}\n当前对象：${target}\n本次任务：${taskMeta.label}\n任务说明：${taskMeta.description}\n作者补充要求：${instruction}\n\n下面是剧情工程的结构化快照（可能包含尚未保存的页面草稿）：\n<narrative-context>\n${context}\n</narrative-context>\n\n请按以下规则工作：\n1. 只基于快照和作者补充要求分析，不要假设未提供的事实。根据实际需要，自主选择 novel_narrative_get_context、novel_characters_get_context、novel_world_get_context、novel_items_get_context 获取补充事实；不要为了遍历模块而机械调用全部工具。\n2. 作者明确要求创建或更新线路、故事弧、卷篇组目录、章节或节时，必须先调用 novel_narrative_get_context 获取最新 sourceHash，再调用 novel_narrative_create_draft；随后分别使用 novel_narrative_upsert_draft_lines、novel_narrative_upsert_draft_story_arcs、novel_narrative_upsert_draft_directories 或 novel_narrative_upsert_draft_chapters 写入对应候选。线路和故事弧必须包含关键节点；目录必须提供正确的父目录、类型和顺序；章节必须包含至少一个节。\n3. 草稿完成后必须调用 novel_narrative_validate_draft，再使用这次返回的 validationToken 调用 novel_narrative_submit_draft。最后调用 novel_narrative_get_proposal_status 回查提案。工具只会生成待审提案，不会直接创建正式对象；只能向作者报告“提案已提交，请在剧情工程中审阅”，不得声称已经写入正式事实源。\n4. sourceHash 不匹配时，重新读取剧情工程事实并创建新草稿，不能用旧 hash 重试。若快照中的 hasUnsavedChanges 为 true，禁止继续创建草稿覆盖未保存页面；应请作者先保存页面或明确放弃草稿。\n5. 工具只能创建剧情规划提案，绝不修改正文。不得使用原始文件工具或向作者建议手工编辑项目文件。目录通过目录候选写入；章、节和段规划通过章节候选写入，节和段始终嵌套在章内。节点关联只能使用已有章节/节 id，不得假装完成不支持的写入。\n6. 非创建请求以分析和建议为主。每条建议使用“发现 / 原因 / 建议动作 / 影响范围”结构，并引用具体线路、故事弧、章节或节的标题；优先尊重非线性创作，不要把检查提示当成硬性写作规则。\n7. 结合人物库的角色弧关联，明确区分角色弧事实与剧情工程中的章节投影。\n\n先判断作者是否要求实际创建；需要创建时先调用工具并报告真实返回结果，否则给出简洁诊断摘要和按优先级排序的建议。`,
  };
}
