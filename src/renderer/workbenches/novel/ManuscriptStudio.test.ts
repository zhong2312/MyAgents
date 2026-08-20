import { describe, expect, it, vi } from "vitest";

import {
  BRAINSTORM_FONT_SCALE_OPTIONS,
  buildBrainstormSystemPrompt,
  buildBrainstormFontScaleStyle,
  buildBrainstormControllerPrompt,
  buildBrainstormCouncilPrompt,
  buildBrainstormCouncilSystemPrompt,
  buildBrainstormDesignerSystemPrompt,
  buildBrainstormDesignerPrompt,
  buildBrainstormContextDigest,
  buildBrainstormDesignerBatchPrompt,
  buildBrainstormSynthesisPrompt,
  buildSimulationCandidateDraft,
  formatBrainstormPlanContent,
  parseBrainstormCompletePlan,
  parseBrainstormCouncilNote,
  parseBrainstormContribution,
  parseBrainstormContributionBatch,
  parseBrainstormRoundtable,
  parseNarrativeExtraction,
  parseQualityReview,
  findUniqueEvidenceRange,
  parseTrackingProposal,
  isQualityReviewCurrent,
  verifyQualityReviewEvidence,
  buildFullGenerationAgentPrompt,
  buildFullGenerationRecoveryRunRequest,
  buildFullGenerationAgentRunRequest,
  buildFullGenerationAgentSystemPrompt,
  buildFullGenerationPlanRepairRunRequest,
  buildFullGenerationSuggestionRepairRunRequest,
  buildFullGenerationTextCorrectionRunRequest,
  buildFullGenerationTextRunRequest,
  buildWritingWordBudget,
  countCharacters,
  evaluateFullGenerationTextBudget,
  assertManuscriptCandidateSourceSnapshot,
  applyExtendedAiRunBudget,
  applyFullGenerationRunTimeout,
  EXTENDED_AI_DEFAULT_MAX_TURNS,
  EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES,
  isFullGenerationTimeoutError,
  FULL_GENERATION_DEFAULT_TIMEOUT_MINUTES,
  FULL_GENERATION_DEFAULT_MAX_TURNS,
  FULL_GENERATION_AI_EXECUTION_PROFILE,
  formatFullGenerationChapterPlan,
  isFullGenerationMaxTurnsError,
  orderFullGenerationFragments,
  parseFullGenerationPlans,
  parseFullGenerationSuggestion,
  parseRoomSchemes,
  parseSimulationCandidateDraft,
  SIMULATION_AI_EXECUTION_PROFILE,
  SIMULATION_AI_TIMEOUT_MS,
  SIMULATION_AI_MAX_TURNS,
  roomModelOptions,
  roomModelSelectionLabel,
  roomProviderOptions,
  runFullGenerationAgentWithRecovery,
  sanitizeFullGenerationTextOutput,
} from "./ManuscriptStudio";

const extractionChapter = {
  id: "chapter-000001",
  title: "雨夜入局",
  content: "城门在雨里缓缓合拢。",
} as unknown as Parameters<typeof parseNarrativeExtraction>[1][number];

describe("正文 AI 结果契约", () => {
  it("候选同时绑定本地草稿和磁盘基线，外部修改时拒绝应用", () => {
    expect(() =>
      assertManuscriptCandidateSourceSnapshot({
        currentDraftContent: "未保存的作者修改",
        currentPersistedContent: "磁盘原文",
        candidateSourceContent: "未保存的作者修改",
        candidatePersistedContent: "磁盘原文",
      }),
    ).not.toThrow();

    expect(() =>
      assertManuscriptCandidateSourceSnapshot({
        currentDraftContent: "未保存的作者修改",
        currentPersistedContent: "外部编辑器的新正文",
        candidateSourceContent: "未保存的作者修改",
        candidatePersistedContent: "磁盘原文",
      }),
    ).toThrow("磁盘正文在候选生成后已经变化");

    expect(() =>
      assertManuscriptCandidateSourceSnapshot({
        currentDraftContent: "作者又改了一处",
        currentPersistedContent: "磁盘原文",
        candidateSourceContent: "候选生成时的正文",
        candidatePersistedContent: "磁盘原文",
      }),
    ).toThrow("正文在候选生成后已经变化");
  });

  it("拒绝缺失或重复的正文提炼章节，避免静默写入不完整剧情", () => {
    expect(() =>
      parseNarrativeExtraction(JSON.stringify({ chapters: [] }), [
        extractionChapter,
      ]),
    ).toThrow("缺少 1 个已选章节结果");

    expect(() =>
      parseNarrativeExtraction(
        JSON.stringify({
          chapters: [
            { sourceChapterId: extractionChapter.id, title: "甲" },
            { sourceChapterId: extractionChapter.id, title: "乙" },
          ],
        }),
        [extractionChapter],
      ),
    ).toThrow("重复章节结果");
  });

  it("只保留与连续性领域匹配且可执行的状态操作", () => {
    const output = parseTrackingProposal(
      JSON.stringify({
        summary: "发生了一次人物状态变化",
        changes: [
          {
            domain: "character-state",
            entityId: "character-000001",
            title: "境界变化",
            after: "进入筑基期",
            evidence: "他终于踏入筑基期。",
            operation: {
              kind: "timeline-event",
              eventKind: "event",
              timeLabel: "",
            },
          },
          {
            domain: "character-state",
            entityId: "character-000001",
            title: "状态变化",
            after: "进入筑基期",
            evidence: "他终于踏入筑基期。",
            operation: { kind: "character-field", field: "currentRealm" },
          },
          {
            domain: "character-state",
            title: "缺少人物引用",
            after: "进入筑基期",
            evidence: "他终于踏入筑基期。",
            operation: { kind: "character-field", field: "currentRealm" },
          },
        ],
      }),
    );

    expect(output.changes).toHaveLength(1);
    expect(output.changes[0].operation).toEqual({
      kind: "character-field",
      field: "currentRealm",
    });
  });

  it("保留无变化结果，并拒绝全是无效操作的连续性结果和无效质量评分", () => {
    expect(
      parseTrackingProposal(
        JSON.stringify({ summary: "没有变化", changes: [] }),
      ),
    ).toMatchObject({ changes: [] });
    expect(() =>
      parseTrackingProposal(
        JSON.stringify({
          changes: [
            {
              domain: "character-state",
              title: "无效",
              after: "x",
              evidence: "y",
              operation: {
                kind: "timeline-event",
                eventKind: "event",
                timeLabel: "",
              },
            },
          ],
        }),
      ),
    ).toThrow("变化均不可执行");
    expect(() =>
      parseQualityReview(JSON.stringify({ summary: "检查完成", issues: [] })),
    ).toThrow("缺少有效的 score");
    expect(
      parseQualityReview(
        JSON.stringify({
          score: 92,
          summary: "整体稳定",
          issues: [],
          passed: ["事实一致"],
        }),
      ),
    ).toMatchObject({ score: 92, passed: ["事实一致"] });
  });

  it("质量审查只在草稿、保存版本和磁盘快照一致时允许生成修复候选", () => {
    const sourceContent = "雨落在旧港。";
    expect(
      isQualityReviewCurrent({
        sourceContent,
        currentDraftContent: sourceContent,
        currentSavedContent: sourceContent,
        currentPersistedContent: sourceContent,
        externalChanged: false,
      }),
    ).toBe(true);

    expect(
      isQualityReviewCurrent({
        sourceContent,
        currentDraftContent: sourceContent,
        currentSavedContent: sourceContent,
        currentPersistedContent: "外部编辑后的正文。",
        externalChanged: true,
      }),
    ).toBe(false);

    expect(
      isQualityReviewCurrent({
        sourceContent,
        currentDraftContent: "作者修改后的草稿。",
        currentSavedContent: sourceContent,
        currentPersistedContent: sourceContent,
        externalChanged: false,
      }),
    ).toBe(false);
  });

  it("质量审查只保留可以由正文证实的问题，并拒绝全部失真的结果", () => {
    const review = parseQualityReview(
      JSON.stringify({
        score: 76,
        summary: "需要调整节奏。",
        issues: [
          {
            category: "节奏",
            severity: "warning",
            title: "有效问题",
            evidence: "雨落在旧港。",
          },
          {
            category: "人物",
            severity: "warning",
            title: "编造问题",
            evidence: "不存在的文本",
          },
        ],
      }),
    );

    expect(verifyQualityReviewEvidence(review, "雨落在旧港。")).toMatchObject({
      issues: [{ title: "有效问题" }],
      discardedIssueCount: 1,
    });
    expect(() =>
      verifyQualityReviewEvidence(
        { ...review, issues: [review.issues[1]!], discardedIssueCount: 0 },
        "雨落在旧港。",
      ),
    ).toThrow("均无法在正文中验证");
  });

  it("只为唯一出现的证据返回正文定位范围", () => {
    expect(findUniqueEvidenceRange("甲。乙。", "乙。")).toEqual({
      start: 2,
      end: 4,
    });
    expect(findUniqueEvidenceRange("甲。甲。", "甲。")).toBeNull();
    expect(findUniqueEvidenceRange("甲。", "乙。")).toBeNull();
  });
});

describe("正文脑暴室", () => {
  it("将连续的完整方案正文拆为小节、节拍与段落", () => {
    expect(
      formatBrainstormPlanContent(
        "【剧情结构：五拍闭环】①开场拍：林默排队候测。②测试拍：仪器出现异常。【情绪曲线】起势：期待。\n\n压迫：规则收紧。",
      ),
    ).toEqual([
      { kind: "heading", text: "【剧情结构：五拍闭环】" },
      { kind: "step", marker: "①", text: "开场拍：林默排队候测。" },
      { kind: "step", marker: "②", text: "测试拍：仪器出现异常。" },
      { kind: "heading", text: "【情绪曲线】" },
      { kind: "paragraph", text: "起势：期待。" },
      { kind: "paragraph", text: "压迫：规则收紧。" },
    ]);
  });

  it("保留完整方案中已有的段内换行", () => {
    expect(
      formatBrainstormPlanContent(
        "【开场】\r\n\r\n第一句。\r\n第二句。\r\n\r\n① 转折：线索出现。",
      ),
    ).toEqual([
      { kind: "heading", text: "【开场】" },
      { kind: "paragraph", text: "第一句。\n第二句。" },
      { kind: "step", marker: "①", text: "转折：线索出现。" },
    ]);
  });

  it("脑暴与剧情推演使用可配置的扩展执行预算", () => {
    const request = {
      sceneId: "manuscript.simulation.agent1" as const,
      label: "剧情推演 · Agent 1",
      prompt: "推演后续剧情",
    };

    expect(SIMULATION_AI_EXECUTION_PROFILE).toBe("extended");
    expect(SIMULATION_AI_TIMEOUT_MS).toBe(300_000);
    expect(SIMULATION_AI_MAX_TURNS).toBe(16);
    expect(EXTENDED_AI_DEFAULT_TIMEOUT_MINUTES).toBe(5);
    expect(EXTENDED_AI_DEFAULT_MAX_TURNS).toBe(16);
    expect(applyExtendedAiRunBudget(request, 10, 12)).toMatchObject({
      executionProfile: "extended",
      timeoutMs: 600_000,
      maxTurns: 12,
    });
  });

  it("将供应商与模型拆为两级选择，并只显示当前供应商的模型", () => {
    const providers = [
      {
        id: "ark",
        name: "火山方舟",
        vendor: "字节跳动",
        primaryModel: "doubao-pro",
        models: [
          { model: "doubao-pro", modelName: "豆包 Pro" },
          { model: "doubao-lite", modelName: "豆包 Lite" },
        ],
        runtimeBacked: false,
      },
      {
        id: "openai",
        name: "OpenAI",
        vendor: "OpenAI",
        primaryModel: "gpt-5",
        models: [{ model: "gpt-5", modelName: "GPT-5" }],
        runtimeBacked: false,
      },
    ] as const;
    const binding = { providerId: "ark", model: "doubao-pro" };

    expect(roomModelSelectionLabel(binding, providers)).toBe(
      "火山方舟 · 豆包 Pro",
    );
    expect(roomProviderOptions(undefined, providers, binding)[0]).toMatchObject(
      {
        value: "",
        label: "默认 · 火山方舟 · 豆包 Pro",
      },
    );

    expect(roomProviderOptions(binding, providers, undefined)).toMatchObject([
      { value: "", label: "跟随全局默认模型" },
      { value: "ark", label: "火山方舟", suffix: "字节跳动" },
      { value: "openai", label: "OpenAI", suffix: "OpenAI" },
    ]);
    expect(roomModelOptions(binding, providers[0])).toMatchObject([
      { value: "doubao-pro", label: "豆包 Pro", suffix: "doubao-pro" },
      { value: "doubao-lite", label: "豆包 Lite", suffix: "doubao-lite" },
    ]);
  });

  it("提供完整的字体缩放档位并按比例覆盖主题字号", () => {
    expect(BRAINSTORM_FONT_SCALE_OPTIONS).toEqual([
      80, 90, 100, 110, 125, 150, 175, 200,
    ]);
    expect(buildBrainstormFontScaleStyle(125)).toMatchObject({
      "--text-xs": "15px",
      "--text-sm": "17.5px",
      "--text-base": "20px",
      "--text-lg": "22.5px",
      "--text-xl": "25px",
      "--text-2xl": "27.5px",
      "--text-3xl": "35px",
    });
    const roundedStyle = buildBrainstormFontScaleStyle(
      110,
    ) as unknown as Record<string, string>;
    expect(roundedStyle["--text-xs"]).toBe("13.2px");
  });

  it("为六个 Agent 分配不可替代的创作视角", () => {
    const prompts = [1, 2, 3, 4, 5, 6].map(buildBrainstormSystemPrompt);

    expect(new Set(prompts).size).toBe(6);
    expect(prompts[0]).toContain("推进、阻力、转折");
    expect(prompts[1]).toContain("选择代价与关系变化");
    expect(prompts[2]).toContain("章节情绪曲线");
    expect(prompts[3]).toContain("默认预期");
    expect(prompts[4]).toContain("因果闭环、规则成本");
    expect(prompts[5]).toContain("开场抓取、信息递进");
  });

  it("把总控会诊解析为共享事实和方案契约", () => {
    const roundtable = parseBrainstormRoundtable(
      JSON.stringify({
        summary: "本章必须让主角主动选择。",
        sharedFacts: ["城门将在子时关闭"],
        authorIntent: ["结尾留下关系代价"],
        agreements: ["不能靠巧合破局"],
        disagreements: ["谈判还是突围"],
        contracts: [
          {
            id: "plan-1",
            title: "雨夜谈判",
            coreChoice: "用旧案换通行",
            causalChain: "证据暴露导致关系破裂",
            requiredBeats: ["试探", "交换", "代价"],
            characterQuestion: "主角为何此刻必须冒险？",
            emotionArc: "压迫到短暂释放",
            twist: "守门人早已知情",
            hook: "子时提前到来",
            nonNegotiables: ["遵守城门规则"],
            openQuestions: ["是否公开身份"],
          },
        ],
      }),
      2,
    );
    expect(roundtable.contracts[0]).toMatchObject({
      id: "plan-1",
      title: "雨夜谈判",
      requiredBeats: ["试探", "交换", "代价"],
    });
    expect(roundtable.sharedFacts).toContain("城门将在子时关闭");
  });

  it("要求设计师和总控整合引用同一个方案契约", () => {
    const contract = {
      id: "plan-1",
      title: "雨夜谈判",
      coreChoice: "用旧案换通行",
      causalChain: "证据暴露导致关系破裂",
      requiredBeats: ["试探"],
      characterQuestion: "为何冒险",
      emotionArc: "压迫",
      twist: "守门人知情",
      hook: "子时提前",
      nonNegotiables: ["不能巧合破局"],
      openQuestions: [],
    } as const;
    const roundtable = {
      summary: "",
      sharedFacts: [],
      authorIntent: [],
      agreements: ["遵守事实"],
      disagreements: [],
      contracts: [contract],
    } as const;
    expect(
      buildBrainstormControllerPrompt({
        chapterTitle: "雨夜入局",
        chapterPlan: "章节计划：拿到证据",
        manuscriptContent: "城门将闭。",
        context: { timeline: ["城门关闭"] },
        planCount: 2,
        councilNotes: [],
      }),
    ).toContain("方案契约");
    expect(
      buildBrainstormCouncilPrompt({
        chapterTitle: "雨夜入局",
        chapterPlan: "章节计划：拿到证据",
        manuscriptContent: "城门将闭。",
        authorIntent: "主角主动选择",
        role: "人物动机师",
        focus: "选择代价",
        context: { characters: ["主角"] },
      }),
    ).toContain("不要生成完整方案");
    expect(buildBrainstormDesignerSystemPrompt(2)).toContain("不得另起方案");
    expect(buildBrainstormCouncilSystemPrompt(2)).toContain("方案形成前的会诊");
    expect(buildBrainstormCouncilSystemPrompt(2)).not.toContain("方案 ID");
    expect(
      parseBrainstormCouncilNote(
        JSON.stringify({
          opportunities: ["旧案关系"],
          constraints: ["不能公开身份"],
          recommendation: "让主角主动交换",
          questions: [],
        }),
        2,
        "人物动机师",
      ),
    ).toMatchObject({ agent: 2, recommendation: "让主角主动交换" });
    expect(
      buildBrainstormDesignerPrompt({
        chapterTitle: "雨夜入局",
        chapterPlan: "章节计划：拿到证据",
        contract,
        role: "人物动机师",
        focus: "选择代价",
        context: { characters: ["主角"] },
        roundtable,
      }),
    ).toContain("plan-1");
    const contribution = parseBrainstormContribution(
      JSON.stringify({
        planId: "plan-1",
        contribution: "主角用秘密换时间。",
        evidence: ["正文第 22 章"],
        assumptions: ["守门人仍记得旧案"],
        conflicts: [],
      }),
      2,
      "人物动机师",
      "plan-1",
    );
    const plan = parseBrainstormCompletePlan(
      JSON.stringify({
        id: "plan-1",
        title: "雨夜谈判",
        premise: "用旧案换通行",
        content: "先试探，再交换。",
        beats: ["试探"],
        evidence: ["正文第 22 章"],
        assumptions: ["守门人仍记得旧案"],
        conflicts: [],
        audit: { score: 88, summary: "可执行", risks: [] },
      }),
      contract,
      [contribution],
    );
    expect(plan).toMatchObject({ id: "plan-1", audit: { score: 88 } });
    const synthesisPrompt = buildBrainstormSynthesisPrompt({
      chapterTitle: "雨夜入局",
      chapterPlan: "章节计划：拿到证据",
      contract,
      contributions: [contribution],
    });
    expect(synthesisPrompt).toContain("plan-1");
    expect(synthesisPrompt).toContain("不得将完整方案压成一段连续文字");
  });

  it("压缩脑暴上下文并按方案 ID 对齐批量设计结果", () => {
    const context = {
      characters: [{ id: "hero", name: "主角", motivation: "x".repeat(3000) }],
      timeline: [
        { id: "event-1", title: "城门关闭", summary: "y".repeat(3000) },
      ],
    } as const;
    const digest = buildBrainstormContextDigest(
      context,
      ["characters", "timeline"],
      { perModuleChars: 500, totalChars: 900 },
    );
    expect(digest.length).toBeLessThanOrEqual(920);
    const contracts = [
      {
        id: "plan-1",
        title: "甲",
        coreChoice: "甲",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
      {
        id: "plan-2",
        title: "乙",
        coreChoice: "乙",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
    ] as const;
    expect(
      buildBrainstormDesignerBatchPrompt({
        chapterTitle: "测试章",
        chapterPlan: "章节计划：推进",
        contracts,
        role: "剧情结构师",
        focus: "推进",
        context: digest,
        roundtable: {
          summary: "",
          sharedFacts: [],
          authorIntent: [],
          agreements: [],
          disagreements: [],
          contracts,
        },
      }),
    ).toContain("每个输入方案必须且只能对应一项");
    expect(
      parseBrainstormContributionBatch(
        JSON.stringify({
          contributions: [
            {
              planId: "plan-2",
              contribution: "乙贡献",
              evidence: [],
              assumptions: [],
              conflicts: [],
            },
            {
              planId: "plan-1",
              contribution: "甲贡献",
              evidence: [],
              assumptions: [],
              conflicts: [],
            },
          ],
        }),
        1,
        "剧情结构师",
        contracts,
      ).map((item) => [item.planId, item.contribution]),
    ).toEqual([
      ["plan-1", "甲贡献"],
      ["plan-2", "乙贡献"],
    ]);
  });

  it("兼容设计师批量贡献的常见返回形态并规范化方案 ID", () => {
    const contracts = [
      {
        id: "plan-1",
        title: "甲",
        coreChoice: "甲",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
      {
        id: "plan-2",
        title: "乙",
        coreChoice: "乙",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
    ] as const;

    const keyed = parseBrainstormContributionBatch(
      JSON.stringify({
        contributions: {
          " PLAN_1 ": {
            content: "甲的结构贡献",
            basis: ["既有伏笔"],
          },
          "plan-2": "乙的结构贡献",
        },
      }),
      1,
      "剧情结构师",
      contracts,
    );
    expect(
      keyed.map((item) => ({
        planId: item.planId,
        contribution: item.contribution,
        status: item.status,
      })),
    ).toEqual([
      { planId: "plan-1", contribution: "甲的结构贡献", status: "available" },
      { planId: "plan-2", contribution: "乙的结构贡献", status: "available" },
    ]);

    const wrappedPlans = parseBrainstormContributionBatch(
      JSON.stringify({
        plans: [
          { id: "plan-1", design: "甲的人物贡献" },
          { id: "PLAN 2", proposal: "乙的人物贡献" },
        ],
      }),
      2,
      "人物动机师",
      contracts,
    );
    expect(wrappedPlans.map((item) => item.contribution)).toEqual([
      "甲的人物贡献",
      "乙的人物贡献",
    ]);
  });

  it("保留贡献缺失、格式异常和顺序回退的诊断状态", () => {
    const contracts = [
      {
        id: "plan-1",
        title: "甲",
        coreChoice: "甲",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
      {
        id: "plan-2",
        title: "乙",
        coreChoice: "乙",
        causalChain: "",
        requiredBeats: [],
        characterQuestion: "",
        emotionArc: "",
        twist: "",
        hook: "",
        nonNegotiables: [],
        openQuestions: [],
      },
    ] as const;

    const sequential = parseBrainstormContributionBatch(
      JSON.stringify([
        { contribution: "按顺序归入甲" },
        { planId: "unknown-plan", contribution: "按顺序归入乙" },
      ]),
      3,
      "读者情绪师",
      contracts,
    );
    expect(sequential.map((item) => item.status)).toEqual([
      "available",
      "available",
    ]);
    expect(sequential[0].diagnostic).toContain("按方案顺序对齐");

    const incomplete = parseBrainstormContributionBatch(
      JSON.stringify({
        contributions: [{ planId: "plan-1", evidence: ["正文事实"] }],
      }),
      1,
      "剧情结构师",
      contracts,
    );
    expect(incomplete[0]).toMatchObject({
      status: "invalid",
      contribution: "",
    });
    expect(incomplete[0].diagnostic).toContain("贡献字段缺失或为空");
    expect(incomplete[1]).toMatchObject({
      status: "missing",
      contribution: "",
    });
    expect(incomplete[1].diagnostic).toContain("未返回方案 plan-2");
  });

  it("将带有前后说明的单个 JSON 方案转为可读卡片内容", () => {
    const schemes = parseRoomSchemes(
      `模型结果：\n{"title":"灯下的代价","premise":"主角必须在救人与守住秘密之间选择。","outline":["旧友带来一封不能公开的信","主角用承诺换取半夜的通行","代价在章末落到最信任的人身上"],"opening":"雨停后，门外只剩一盏灯。","category":"character","score":91,"tags":["选择","代价"]}\n[生成结束]`,
      2,
      "brainstorm",
      2,
    );

    expect(schemes).toHaveLength(1);
    expect(schemes[0]).toMatchObject({
      title: "灯下的代价",
      category: "character",
      premise: "主角必须在救人与守住秘密之间选择。",
      score: 91,
    });
    expect(schemes[0].content).toContain("1. 旧友带来一封不能公开的信");
    expect(schemes[0].content).not.toContain('"title"');
  });

  it("将剧情推演编辑稿无损映射回结构化采用数据", () => {
    const original = {
      title: "灯下的代价",
      premise: "主角必须在救人与守住秘密之间选择。",
      content: "旧友带来一封不能公开的信。",
      nodes: [
        {
          offset: 1,
          title: "半夜通行",
          summary: "主角用承诺换取通行。",
          checkpoint: "承诺可被追责",
        },
      ],
    };
    const draft = buildSimulationCandidateDraft(original, 3);
    expect(parseSimulationCandidateDraft(draft, 3)).toEqual(original);

    const edited = draft
      .replace("灯下的代价", "钟声后的选择")
      .replace("救人与守住秘密", "救人与公开秘密")
      .replace("旧友带来一封不能公开的信。", "主角决定公开半封信。")
      .replace("第 4 章 · 半夜通行", "第 5 章 · 当面对质")
      .replace("主角用承诺换取通行。", "主角在众人面前交出证据。")
      .replace("承诺可被追责", "证据来源必须闭合");
    expect(parseSimulationCandidateDraft(edited, 3)).toEqual({
      title: "钟声后的选择",
      premise: "主角必须在救人与公开秘密之间选择。",
      content: "主角决定公开半封信。",
      nodes: [
        {
          offset: 2,
          title: "当面对质",
          summary: "主角在众人面前交出证据。",
          checkpoint: "证据来源必须闭合",
        },
      ],
    });
  });

  it("剧情推演编辑稿结构损坏时拒绝静默采用旧方案", () => {
    expect(() =>
      parseSimulationCandidateDraft(
        "# 候选路径：只剩标题\n\n正文已经脱离结构",
        3,
      ),
    ).toThrow("必须保留唯一的“## 前提”段落");
  });

  it("解析正文方案片段并限制每个 Agent 的方案数量", () => {
    const plans = parseFullGenerationPlans(
      JSON.stringify({
        plans: [
          {
            title: "方案一",
            premise: "先谈判，再突围",
            fragments: [
              {
                title: "试探",
                summary: "确认对方底线",
                content: "主角先用一句旧案暗语试探来客。",
              },
              {
                title: "突围",
                summary: "局面转为行动",
                content: "灯灭后，主角从封锁最薄弱处突围。",
              },
            ],
          },
          {
            title: "方案二",
            fragments: [
              {
                title: "伏击",
                content: "主角提前封住后巷，把追兵引进空院。",
              },
            ],
          },
        ],
      }),
      4,
      1,
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: "agent-4-plan-1",
      agent: 4,
      agentName: "Agent 04",
      title: "方案一",
    });
    expect(plans[0].fragments.map((fragment) => fragment.id)).toEqual([
      "agent-4-plan-1-fragment-1",
      "agent-4-plan-1-fragment-2",
    ]);
  });

  it("兼容成功返回但没有严格 JSON 的 Markdown 正文方案", () => {
    const plans = parseFullGenerationPlans(
      `下面给出两个正文方案。

## 方案一：雨门换印
**核心取舍与主要因果链：** 主角先用旧案换取入城机会，再承担暴露身份的后果。

### 片段一：守门人的试探
**叙事作用：** 建立封城压力并确认守门人的真实立场。
**详细写作蓝图：**
雨水顺着城门钉往下淌。主角没有直接递出证据，而是先复述旧案中只有两人知道的错漏，逼守门人主动接话。
守门人表面呵斥，手却悄悄挡住巡兵视线，双方在一句句试探里确认临时同盟。

### 片段二：灯灭后的通行
**片段作用：** 把谈判结果转成行动，并留下身份暴露的代价。
**片段内容：** 城头灯火熄灭三息，主角趁换岗穿过侧门；追兵却从积水里的脚印判断出他并未离城。

## 方案二：反向设伏
**方案概述：** 主角放弃立刻入城，利用封门制造追兵的错误判断。

### 场景一：空车诱敌
**摘要：** 主角把证据藏进空车，让追兵先闯入守军视线。
**内容：** 车轮碾过泥水，故意留下通往正门的痕迹，主角本人则伏在排水渠中观察双方反应。`,
      1,
      2,
    );

    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      title: "雨门换印",
      premise: "主角先用旧案换取入城机会，再承担暴露身份的后果。",
    });
    expect(plans[0].fragments).toHaveLength(2);
    expect(plans[0].fragments[0]).toMatchObject({
      title: "守门人的试探",
      summary: "建立封城压力并确认守门人的真实立场。",
    });
    expect(plans[0].fragments[0].content).toContain(
      "双方在一句句试探里确认临时同盟",
    );
    expect(plans[1].fragments[0].title).toBe("空车诱敌");
  });

  it("兼容中文字段、单方案对象与 JSON 尾逗号", () => {
    const plans = parseFullGenerationPlans(
      `结果如下：\n\`\`\`json
{"方案标题":"暗门余波","核心思路":"先脱身，再让代价落到同伴身上。","正文片段":[{"片段标题":"错身","叙事作用":"完成脱身","详细内容":"主角借换岗的三息空隙穿过暗门。",},],}
\`\`\``,
      3,
      1,
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      title: "暗门余波",
      premise: "先脱身，再让代价落到同伴身上。",
    });
    expect(plans[0].fragments[0]).toMatchObject({
      title: "错身",
      summary: "完成脱身",
      content: "主角借换岗的三息空隙穿过暗门。",
    });
  });

  it("保留 AI 建议顺序并让人工排序决定最终片段顺序", () => {
    const plans = parseFullGenerationPlans(
      JSON.stringify({
        plans: [
          {
            title: "交叉方案",
            fragments: [
              { title: "甲", content: "甲片段" },
              { title: "乙", content: "乙片段" },
              { title: "丙", content: "丙片段" },
            ],
          },
        ],
      }),
      2,
      1,
    );
    const [first, second, third] = plans[0].fragments;
    const suggestion = parseFullGenerationSuggestion(
      JSON.stringify({
        fragmentIds: [third.id, first.id, third.id, "invalid"],
        reason: "先抛结果，再补原因。",
      }),
      new Set(plans[0].fragments.map((fragment) => fragment.id)),
    );

    expect(suggestion.fragmentIds).toEqual([third.id, first.id]);
    expect(
      orderFullGenerationFragments(
        plans,
        new Set([first.id, second.id, third.id]),
        [second.id, third.id, first.id],
      ).map((fragment) => fragment.title),
    ).toEqual(["乙", "丙", "甲"]);
  });

  it("将剧情工程节拍带入完整生成上下文", () => {
    expect(
      formatFullGenerationChapterPlan({
        title: "雨夜入局",
        description: "主角必须在城门关闭前拿到证据。",
        sections: [
          { title: "试探", description: "确认守门人的真实立场。" },
          { title: "交换", description: "用旧案换取通行时机。" },
        ],
      }),
    ).toBe(
      "剧情工程章节计划：雨夜入局\n主角必须在城门关闭前拿到证据。\n章节节拍：\n1. 试探：确认守门人的真实立场。\n2. 交换：用旧案换取通行时机。",
    );
    expect(formatFullGenerationChapterPlan(undefined)).toBe(
      "剧情工程章节计划：未关联",
    );
  });

  it("正文方案 Agent 复用只读项目工具并保留逐 Agent 配置", () => {
    const systemPrompt = buildFullGenerationAgentSystemPrompt();
    const prompt = buildFullGenerationAgentPrompt({
      chapterId: "chapter-000023",
      chapterNumber: 23,
      chapterTitle: "雨夜入局",
      schemeCount: 3,
      chapterPlan: "剧情工程章节计划：雨夜入局",
      generationContext: "前文衔接：城门将在子时关闭。",
      manuscriptContent: "门外的雨声越来越密。",
      targetWordCount: 2_800,
      toneBias: "suspenseful",
      extraPrompt: "优先保留谈判路线，结尾追加新的时间压力。",
    });

    expect(systemPrompt).toContain("小说工作台内置只读工具");
    expect(systemPrompt).toContain("设定库、人物库、剧情工程、时间线");
    expect(systemPrompt).toContain("不要调用任何写入工具");
    expect(systemPrompt).toContain("同一个工具原则上只调用一次");
    expect(systemPrompt).toContain("每个片段 content 约 300～600 个中文字");
    expect(systemPrompt).toContain("完整方案约 1200～2500 字");
    expect(systemPrompt).toContain("场景目标、在场人物的行动与阻力");
    expect(prompt).toContain("本 Agent 需要生成 3 个不同方案");
    expect(prompt).toContain("章节 ID：chapter-000023");
    expect(prompt).toContain("内容偏向：偏悬疑");
    expect(prompt).toContain("本章正文目标：2800 字");
    expect(prompt).toContain("用疑点、误导和逐步验证维持紧张感");
    expect(prompt).toContain("该 Agent 的额外提示词");
    expect(prompt).toContain("优先保留谈判路线");
    expect(FULL_GENERATION_AI_EXECUTION_PROFILE).toBe("extended");

    expect(
      buildFullGenerationAgentRunRequest({
        agent: 3,
        chapterTitle: "雨夜入局",
        prompt,
        modelSelection: {
          providerId: "ark",
          model: "doubao-pro",
        },
      }),
    ).toMatchObject({
      sceneId: "manuscript.brainstorm.agent3",
      label: "雨夜入局 · 正文方案 · Agent 3",
      modelSelection: {
        providerId: "ark",
        model: "doubao-pro",
      },
      executionProfile: "extended",
      usesNovelContextTools: true,
      prompt,
    });
  });

  it("方案格式整理复用原 Agent 模型但不再次开放项目工具", () => {
    const request = buildFullGenerationAgentRunRequest({
      agent: 3,
      chapterTitle: "雨夜入局",
      prompt: "生成两个详细方案",
      modelSelection: { providerId: "ark", model: "doubao-pro" },
    });
    const repairRequest = buildFullGenerationPlanRepairRunRequest({
      request,
      output: "## 方案一\n### 片段一\n已有方案内容",
      schemeCount: 2,
    });

    expect(repairRequest).toMatchObject({
      sceneId: "manuscript.brainstorm.agent3",
      label: "雨夜入局 · 正文方案 · Agent 3 · 整理返回格式",
      modelSelection: { providerId: "ark", model: "doubao-pro" },
      executionProfile: "extended",
    });
    expect(repairRequest.usesNovelContextTools).toBeUndefined();
    expect(repairRequest.novelContextToolCallLimit).toBeUndefined();
    expect(repairRequest.systemPrompt).toContain("不得调用任何工具");
    expect(repairRequest.prompt).toContain("已有方案内容");
  });

  it("AI 选片格式整理只允许保留现有片段 ID 且不开放工具", () => {
    const repairRequest = buildFullGenerationSuggestionRepairRunRequest({
      output: "我建议选择第一个和第三个片段。",
      allowedIds: ["agent-1-plan-1-fragment-1", "agent-2-plan-1-fragment-3"],
    });

    expect(repairRequest).toMatchObject({
      sceneId: "manuscript.brainstorm.synthesis",
      label: "正文方案 · AI 建议选片 · 整理返回格式",
      executionProfile: "extended",
    });
    expect(repairRequest.usesNovelContextTools).toBeUndefined();
    expect(repairRequest.systemPrompt).toContain("不得调用任何工具");
    expect(repairRequest.prompt).toContain("agent-2-plan-1-fragment-3");
  });

  it("完整生成窗口统一使用 1 到 10 分钟超时且默认 5 分钟", () => {
    const request = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "生成正文",
      targetWordCount: 2_800,
    });

    expect(FULL_GENERATION_DEFAULT_TIMEOUT_MINUTES).toBe(5);
    expect(FULL_GENERATION_DEFAULT_MAX_TURNS).toBe(16);
    expect(applyFullGenerationRunTimeout(request, 5)).toMatchObject({
      executionProfile: "extended",
      timeoutMs: 300_000,
      maxTurns: 16,
    });
    expect(applyFullGenerationRunTimeout(request, 5, 8).maxTurns).toBe(8);
    expect(applyFullGenerationRunTimeout(request, 0).timeoutMs).toBe(60_000);
    expect(applyFullGenerationRunTimeout(request, 12).timeoutMs).toBe(600_000);
    expect(request.systemPrompt).toContain("本章目标字数为 2800 字");
    expect(request.systemPrompt).toContain("2520～3080 个非空字符");
    expect(buildWritingWordBudget(2_800, "generate", 0, 0)).toContain(
      "本章目标默认继承项目总览：2800 字",
    );
  });

  it("快速模式把资料一次性注入请求且不开放上下文工具", () => {
    const planRequest = buildFullGenerationAgentRunRequest({
      agent: 1,
      chapterTitle: "雨夜入局",
      prompt: "【快速模式资料快照】\n人物：沈砚",
      modelSelection: undefined,
      readMode: "quick",
    });
    const textRequest = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "【快速模式资料快照】\n前章正文",
      targetWordCount: 2_800,
      readMode: "quick",
    });

    expect(planRequest.usesNovelContextTools).toBeUndefined();
    expect(planRequest.novelContextToolCallLimit).toBeUndefined();
    expect(planRequest.systemPrompt).toContain("禁止调用任何工具");
    expect(textRequest.usesNovelContextTools).toBeUndefined();
    expect(textRequest.novelContextToolCallLimit).toBeUndefined();
    expect(textRequest.systemPrompt).toContain("一次性输出完整正文");

    const recoveryRequest = buildFullGenerationRecoveryRunRequest(planRequest);
    expect(recoveryRequest.usesNovelContextTools).toBeUndefined();
    expect(recoveryRequest.novelContextToolCallLimit).toBeUndefined();
    expect(recoveryRequest.systemPrompt).toContain("不得调用任何工具");
  });

  it("清除正文尾部泄漏的英文计数与自检过程", () => {
    const manuscript = "雨水沿着城门缓缓流下。".repeat(20);
    const output = `${manuscript}\n\n---\n\nLet me count roughly. I'll estimate the text first.\n\nParagraph 1: ~190 chars\nParagraph 2: ~150 chars\nWord count: about 2800`;
    const sanitized = sanitizeFullGenerationTextOutput(output);

    expect(sanitized).toBe(manuscript);
    expect(sanitized).not.toContain("Let me count");
    expect(sanitized).not.toContain("Paragraph 1");
  });

  it("按总览每章字数校验正文并构造一次无工具调整请求", () => {
    const shortText = "字".repeat(2_519);
    const validText = "字".repeat(2_800);
    expect(countCharacters("雨 夜\n入城。")).toBe(5);
    expect(evaluateFullGenerationTextBudget(shortText, 2_800)).toMatchObject({
      count: 2_519,
      target: 2_800,
      minimum: 2_520,
      maximum: 3_080,
      withinRange: false,
    });
    expect(evaluateFullGenerationTextBudget(validText, 2_800).withinRange).toBe(
      true,
    );

    const sourceRequest = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "保持雨夜谈判与章末追兵线索。",
      targetWordCount: 2_800,
    });
    const correctionRequest = buildFullGenerationTextCorrectionRunRequest({
      request: sourceRequest,
      output: shortText,
      targetWordCount: 2_800,
    });
    expect(correctionRequest).toMatchObject({
      sceneId: "manuscript.generate",
      label: "雨夜入局 · 完整生成正文 · 按总览字数调整",
      executionProfile: "extended",
    });
    expect(correctionRequest.usesNovelContextTools).toBeUndefined();
    expect(correctionRequest.systemPrompt).toContain("2520～3080");
    expect(correctionRequest.systemPrompt).toContain("不得调用任何工具");
    expect(correctionRequest.prompt).toContain("本章目标：2800 字");
  });

  it("仅在达到轮次上限时自动执行一次无工具的收敛重试", async () => {
    const request = buildFullGenerationAgentRunRequest({
      agent: 2,
      chapterTitle: "雨夜入局",
      prompt: "生成两个详细方案",
      modelSelection: { providerId: "ark", model: "doubao-pro" },
    });
    const recoveryRequest = buildFullGenerationRecoveryRunRequest(request);

    expect(
      isFullGenerationMaxTurnsError(
        new Error(
          "Claude Code returned an error result: Reached maximum number of turns (16)",
        ),
      ),
    ).toBe(true);
    expect(isFullGenerationMaxTurnsError(new Error("模型不可用"))).toBe(false);
    expect(recoveryRequest).toMatchObject({
      label: "雨夜入局 · 正文方案 · Agent 2 · 收敛重试",
      modelSelection: { providerId: "ark", model: "doubao-pro" },
    });
    expect(recoveryRequest.usesNovelContextTools).toBeUndefined();
    expect(recoveryRequest.novelContextToolCallLimit).toBeUndefined();
    expect(recoveryRequest.systemPrompt).toContain("唯一一次自动收敛重试");
    expect(recoveryRequest.systemPrompt).toContain("不得调用任何工具");
    expect(recoveryRequest.prompt).toContain("无工具收敛重试");

    const onRecovery = vi.fn();
    const onRun = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Claude Code returned an error result: Reached maximum number of turns (16)",
        ),
      )
      .mockResolvedValueOnce('{"plans":[]}');

    await expect(
      runFullGenerationAgentWithRecovery({ request, onRun, onRecovery }),
    ).resolves.toBe('{"plans":[]}');
    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]?.usesNovelContextTools).toBeUndefined();
  });

  it("普通错误不会触发完整生成自动重试", async () => {
    const request = buildFullGenerationAgentRunRequest({
      agent: 1,
      chapterTitle: "雨夜入局",
      prompt: "生成方案",
      modelSelection: undefined,
    });
    const onRecovery = vi.fn();
    const onRun = vi.fn().mockRejectedValue(new Error("模型不可用"));

    await expect(
      runFullGenerationAgentWithRecovery({ request, onRun, onRecovery }),
    ).rejects.toThrow("模型不可用");
    expect(onRecovery).not.toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("保留一次性正文生成请求的受控工具预算", () => {
    const request = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "按确认片段生成完整正文",
    });

    expect(request).toMatchObject({
      sceneId: "manuscript.generate",
      label: "雨夜入局 · 完整生成正文",
      executionProfile: "extended",
      usesNovelContextTools: true,
      novelContextToolCallLimit: 6,
      prompt: "按确认片段生成完整正文",
    });
    expect(request.systemPrompt).toContain("只输出可直接采用的完整章节正文");
  });

  it("快速模式的一次性正文 Run 不携带上下文工具", () => {
    const request = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "按人工资料快照生成完整正文",
      targetWordCount: 3000,
      readMode: "quick",
    });

    expect(request).toMatchObject({
      sceneId: "manuscript.generate",
      executionProfile: "extended",
    });
    expect(request).not.toHaveProperty("usesNovelContextTools");
    expect(request).not.toHaveProperty("novelContextToolCallLimit");
    expect(request.systemPrompt).toContain("禁止调用任何工具");
  });

  it("正文超时会识别为可收敛重试错误", () => {
    expect(
      isFullGenerationTimeoutError(
        new Error("AI 运行超过 300 秒，尚未返回最终文本"),
      ),
    ).toBe(true);
    expect(isFullGenerationTimeoutError(new Error("模型不可用"))).toBe(false);
  });

  it("正文超时只重试一次并切换为纯文本收敛指令", async () => {
    const request = buildFullGenerationTextRunRequest({
      chapterTitle: "雨夜入局",
      prompt: "按确认片段生成完整正文",
    });
    const onRecovery = vi.fn();
    const onRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("AI 运行超过 300 秒，尚未返回最终文本"))
      .mockResolvedValueOnce("主角推开了城门。\n\n雨声停了一瞬。\n");

    await expect(
      runFullGenerationAgentWithRecovery({ request, onRun, onRecovery }),
    ).resolves.toContain("主角推开了城门");
    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]?.usesNovelContextTools).toBeUndefined();
    expect(onRun.mock.calls[1]?.[0].systemPrompt).toContain(
      "返回完整章节正文纯文本",
    );
    expect(onRun.mock.calls[1]?.[0].systemPrompt).not.toContain(
      "返回约定 JSON",
    );
  });

  it("收敛重试失败时明确标记自动重试已耗尽", async () => {
    const request = buildFullGenerationAgentRunRequest({
      agent: 1,
      chapterTitle: "雨夜入局",
      prompt: "生成方案",
      modelSelection: undefined,
    });
    const onRun = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Claude Code returned an error result: Reached maximum number of turns (16)",
        ),
      )
      .mockRejectedValueOnce(new Error("模型未返回结果"));

    await expect(
      runFullGenerationAgentWithRecovery({ request, onRun }),
    ).rejects.toThrow("已自动收敛重试一次，仍未完成：模型未返回结果");
    expect(onRun).toHaveBeenCalledTimes(2);
  });
});
