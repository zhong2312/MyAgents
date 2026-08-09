import { describe, expect, it } from "vitest";

import {
  createEmptyNarrativeEngineering,
  type PlotLine,
} from "./narrativeEngineeringSchema";
import { createNarrativeEngineeringRepository } from "./narrativeEngineeringRepository";
import {
  createNarrativeFileProposalRepository,
  createNarrativeProposalRepository,
  narrativeProposalContentHash,
} from "./narrativeProposalRepository";
import {
  narrativeProposalManifestPath,
  serializeNarrativeProposalManifest,
  type NarrativeProposalManifest,
} from "./narrativeProposalSchema";
import { createEmptyNovelStorage } from "./testStorage";

function line(id: string, title: string, premise: string): PlotLine {
  return {
    id,
    title,
    kind: id === "main-line" ? "main" : "information",
    storyRole: id === "main-line" ? "a" : "none",
    status: "active",
    color: id === "main-line" ? "#b64a3a" : "#3b6f8f",
    premise,
    protagonistCharacterId: null,
    keyNodes: [],
    content: "",
  };
}

async function seedNarrativeProposal() {
  const storage = createEmptyNovelStorage();
  const repository = createNarrativeEngineeringRepository(storage);
  const empty = await repository.load();
  const target = line("main-line", "主线", "旧前提");
  const unrelated = line("clue-line", "线索线", "原始线索");
  const saved = await repository.save(empty, {
    ...createEmptyNarrativeEngineering("2026-07-28T08:00:00.000Z"),
    lines: [target, unrelated],
  });
  const proposalId = "update-main-line";
  const manifest: NarrativeProposalManifest = {
    schemaVersion: 2,
    proposalId,
    title: "调整主线",
    description: "只修改主线前提",
    createdAt: "2026-07-28T08:10:00.000Z",
    source: {
      kind: "agent",
      promptId: "novel.narrative.assist",
      promptVersion: "1.0.0",
    },
    baseSourceHash: await narrativeProposalContentHash(saved.content),
    lines: [
      {
        candidateId: "main-line-candidate",
        summary: "更新线路：主线",
        status: "pending",
        value: { ...target, premise: "提案前提" },
        baseValue: target,
      },
    ],
    arcs: [],
    directories: [],
    chapters: [],
  };
  await storage.createText(
    narrativeProposalManifestPath(proposalId),
    serializeNarrativeProposalManifest(manifest),
    { createParents: true },
  );
  return { storage, repository, saved, proposalId, target, unrelated };
}

describe("createNarrativeProposalRepository", () => {
  it("keeps legacy v1 line and arc proposals readable without directory candidates", async () => {
    const storage = createEmptyNovelStorage();
    const current = await createNarrativeEngineeringRepository(storage).load();
    const proposalId = "legacy-narrative-proposal";
    await storage.createText(
      narrativeProposalManifestPath(proposalId),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          proposalId,
          title: "旧版剧情提案",
          description: "没有 directories 字段",
          createdAt: "2026-07-28T07:00:00.000Z",
          source: {
            kind: "agent",
            promptId: "novel.narrative.assist",
            promptVersion: "1.0.0",
          },
          baseSourceHash: await narrativeProposalContentHash(current.content),
          lines: [],
          arcs: [],
        },
        null,
        2,
      )}\n`,
      { createParents: true },
    );

    const listed = await createNarrativeProposalRepository(storage).list();
    expect(listed.errors).toEqual([]);
    expect(listed.proposals[0]?.manifest.directories).toEqual([]);
  });

  it("does not mark an object-level proposal conflicted when another line changes", async () => {
    const { storage, repository, saved, proposalId, target, unrelated } =
      await seedNarrativeProposal();
    await repository.save(saved, {
      ...saved.library,
      lines: [target, { ...unrelated, premise: "人工补充线索" }],
    });

    const listed = await createNarrativeFileProposalRepository(storage).list();
    expect(listed.proposals[0]?.changes[0]?.conflict).toBe(false);

    await createNarrativeProposalRepository(storage).apply(proposalId, [
      "main-line-candidate",
    ]);
    const current = await repository.load();
    expect(current.library.lines).toHaveLength(2);
    expect(
      current.library.lines.find((item) => item.id === "main-line")?.premise,
    ).toBe("提案前提");
    expect(
      current.library.lines.find((item) => item.id === "clue-line")?.premise,
    ).toBe("人工补充线索");
  });

  it("marks the proposal conflicted only when its target object changes", async () => {
    const { storage, repository, saved, proposalId, target, unrelated } =
      await seedNarrativeProposal();
    await repository.save(saved, {
      ...saved.library,
      lines: [{ ...target, premise: "人工调整主线" }, unrelated],
    });

    const listed = await createNarrativeFileProposalRepository(storage).list();
    expect(listed.proposals[0]?.changes[0]).toMatchObject({
      id: "main-line-candidate",
      conflict: true,
      baseContentAvailable: true,
    });
    await expect(
      createNarrativeProposalRepository(storage).apply(proposalId, [
        "main-line-candidate",
      ]),
    ).rejects.toThrow("正式内容已变化");
  });

  it("applies volume, part and group candidates to the outline directory tree", async () => {
    const storage = createEmptyNovelStorage();
    const engineeringRepository = createNarrativeEngineeringRepository(storage);
    const current = await engineeringRepository.load();
    const proposalId = "create-outline-tree";
    const manifest: NarrativeProposalManifest = {
      schemaVersion: 3,
      proposalId,
      title: "创建卷篇组目录",
      description: "目录候选必须进入大纲，而不是故事弧",
      createdAt: "2026-07-28T09:00:00.000Z",
      source: {
        kind: "agent",
        promptId: "novel.narrative.assist",
        promptVersion: "1.0.0",
      },
      baseSourceHash: await narrativeProposalContentHash(current.content),
      lines: [],
      arcs: [],
      directories: [
        {
          candidateId: "directory-volume-one",
          summary: "新增目录：第一卷",
          status: "pending",
          baseValue: null,
          value: {
            id: "directory-volume-one",
            parentId: null,
            kind: "volume",
            title: "第一卷",
            description: "主角踏入棋局",
            status: "planned",
            order: 0,
          },
        },
        {
          candidateId: "directory-part-one",
          summary: "新增目录：第一篇",
          status: "pending",
          baseValue: null,
          value: {
            id: "directory-part-one",
            parentId: "directory-volume-one",
            kind: "part",
            title: "第一篇",
            description: "龙胆初鸣",
            status: "planned",
            order: 0,
          },
        },
        {
          candidateId: "directory-group-one",
          summary: "新增目录：第一组",
          status: "pending",
          baseValue: null,
          value: {
            id: "directory-group-one",
            parentId: "directory-part-one",
            kind: "group",
            title: "第一组",
            description: "荒城开局",
            status: "planned",
            order: 0,
          },
        },
      ],
      chapters: [],
    };
    await storage.createText(
      narrativeProposalManifestPath(proposalId),
      serializeNarrativeProposalManifest(manifest),
      { createParents: true },
    );

    const listed = await createNarrativeFileProposalRepository(storage).list();
    expect(
      listed.proposals[0]?.changes.map((change) => change.targetPath),
    ).toEqual([
      "narrative/directories/records/directory-volume-one.json",
      "narrative/directories/records/directory-part-one.json",
      "narrative/directories/records/directory-group-one.json",
    ]);
    await createNarrativeProposalRepository(storage).apply(proposalId, [
      "directory-volume-one",
      "directory-part-one",
      "directory-group-one",
    ]);

    const applied = await engineeringRepository.load();
    expect(applied.library.directories).toEqual(
      manifest.directories.map((candidate) => candidate.value),
    );
    expect(applied.library.arcs).toEqual([]);
  });

  it("applies a chapter candidate with nested sections and paragraphs", async () => {
    const storage = createEmptyNovelStorage();
    const engineeringRepository = createNarrativeEngineeringRepository(storage);
    const empty = await engineeringRepository.load();
    const directory = {
      id: "directory-part-one",
      parentId: null,
      kind: "group" as const,
      title: "第一组",
      description: "开篇",
      status: "planned" as const,
      order: 0,
    };
    const current = await engineeringRepository.save(empty, {
      ...empty.library,
      directories: [directory],
    });
    const proposalId = "create-chapter-plan";
    const chapter = {
      id: "chapter-opening",
      directoryId: directory.id,
      manuscriptChapterId: null,
      title: "黑市擂台",
      description: "凌霄第一次被迫亮枪。",
      status: "planned" as const,
      order: 0,
      updatedAt: "2026-07-29T08:00:00.000Z",
      lineIds: [],
      arcIds: [],
      sections: [
        {
          id: "section-arena",
          order: 0,
          title: "擂台开局",
          description: "建立赌局与压迫感。",
          povCharacterId: null,
          lineIds: [],
          arcIds: [],
          paragraphs: [
            {
              id: "paragraph-bet",
              order: 0,
              content: "凌霄押上仅剩的枪。",
            },
          ],
        },
      ],
    };
    const manifest: NarrativeProposalManifest = {
      schemaVersion: 4,
      proposalId,
      title: "创建章节与节",
      description: "章节候选应进入章节页面",
      createdAt: "2026-07-29T08:05:00.000Z",
      source: {
        kind: "agent",
        promptId: "novel.narrative.assist",
        promptVersion: "1.0.0",
      },
      baseSourceHash: await narrativeProposalContentHash(current.content),
      lines: [],
      arcs: [],
      directories: [],
      chapters: [
        {
          candidateId: "chapter-opening-candidate",
          summary: "新增章节：黑市擂台",
          status: "pending",
          baseValue: null,
          value: chapter,
        },
      ],
    };
    await storage.createText(
      narrativeProposalManifestPath(proposalId),
      serializeNarrativeProposalManifest(manifest),
      { createParents: true },
    );

    const listed = await createNarrativeFileProposalRepository(storage).list();
    expect(listed.proposals[0]?.changes[0]?.targetPath).toBe(
      "narrative/chapters/records/chapter-opening.json",
    );
    await createNarrativeProposalRepository(storage).apply(proposalId, [
      "chapter-opening-candidate",
    ]);

    const applied = await engineeringRepository.load();
    expect(applied.library.chapters).toEqual([chapter]);
    expect(applied.library.directories).toEqual([directory]);
  });

  it("does not apply a child directory without its proposed parent", async () => {
    const storage = createEmptyNovelStorage();
    const engineeringRepository = createNarrativeEngineeringRepository(storage);
    const current = await engineeringRepository.load();
    const proposalId = "orphan-outline-directory";
    const manifest: NarrativeProposalManifest = {
      schemaVersion: 3,
      proposalId,
      title: "孤立目录",
      description: "验证目录引用闭合",
      createdAt: "2026-07-28T09:10:00.000Z",
      source: {
        kind: "agent",
        promptId: "novel.narrative.assist",
        promptVersion: "1.0.0",
      },
      baseSourceHash: await narrativeProposalContentHash(current.content),
      lines: [],
      arcs: [],
      directories: [
        {
          candidateId: "directory-parent",
          summary: "新增目录：父卷",
          status: "pending",
          baseValue: null,
          value: {
            id: "directory-parent",
            parentId: null,
            kind: "volume",
            title: "父卷",
            description: "",
            status: "planned",
            order: 0,
          },
        },
        {
          candidateId: "directory-child",
          summary: "新增目录：子篇",
          status: "pending",
          baseValue: null,
          value: {
            id: "directory-child",
            parentId: "directory-parent",
            kind: "part",
            title: "子篇",
            description: "",
            status: "planned",
            order: 0,
          },
        },
      ],
      chapters: [],
    };
    await storage.createText(
      narrativeProposalManifestPath(proposalId),
      serializeNarrativeProposalManifest(manifest),
      { createParents: true },
    );

    await expect(
      createNarrativeProposalRepository(storage).apply(proposalId, [
        "directory-child",
      ]),
    ).rejects.toThrow("父目录不存在");
    expect((await engineeringRepository.load()).library.directories).toEqual(
      [],
    );
  });
});
