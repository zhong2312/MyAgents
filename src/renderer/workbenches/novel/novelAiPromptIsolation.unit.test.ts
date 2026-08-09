import { describe, expect, it } from "vitest";

import { createInspirationAiAgentRequest } from "./modules/inspiration/business/inspirationAi";
import { buildTimelineAiAgentRequest } from "./modules/timeline/business/timelineAi";
import { buildNarrativeAiAgentRequest } from "./narrativeAi";

describe("小说工作台 AI 提示词上下文隔离", () => {
  it("剧情工程只在系统提示中保留目标标识和工具协议", () => {
    const request = buildNarrativeAiAgentRequest({
      task: "chapters",
      projectTitle: "测试小说",
      selection: {
        view: "chapters",
        selectedLineId: "line-secret",
        selectedArcId: "arc-secret",
        selectedDirectoryId: "volume-1",
        selectedChapterId: "chapter-plan-1",
      },
      userInstruction: "规划三章",
    });

    expect(request.initialMessage).toBe(
      "请开始执行当前小说工作台剧情工程任务。",
    );
    expect(request.initialMessage).not.toContain("line-secret");
    expect(request.systemPrompt).toContain("novel_narrative_get_context");
    expect(request.systemPrompt).toContain('"selectedDirectoryId":"volume-1"');
    expect(request.systemPrompt).not.toContain("<narrative-context>");
  });

  it("时间线不把页面事件草稿序列化进提示词", () => {
    const eventDraft = {
      id: "event-secret",
      title: "不应出现在提示词中的事件正文",
    } as never;
    const request = buildTimelineAiAgentRequest({
      task: "consistency",
      projectTitle: "测试小说",
      selection: {
        branchId: "main-branch",
        viewId: "world-history",
        periodId: "period-1",
        eventId: "event-1",
        eventDraft,
      },
      userInstruction: "检查因果",
    });

    expect(request.initialMessage).toBe("请开始执行当前小说工作台时间线任务。");
    expect(request.systemPrompt).toContain("novel_timeline_get_context");
    expect(request.systemPrompt).toContain('"eventId":"event-1"');
    expect(request.systemPrompt).not.toContain("不应出现在提示词中的事件正文");
    expect(request.systemPrompt).not.toContain("<timeline-context>");
  });

  it("灵感共创只传焦点标识并要求通过工具读取", () => {
    const request = createInspirationAiAgentRequest({
      projectTitle: "测试小说",
      focusId: "idea-1",
      focusLabel: "雨夜相逢",
    });

    expect(request.initialMessage).toBe(
      "请开始执行当前小说工作台灵感共创任务。",
    );
    expect(request.systemPrompt).toContain("novel_inspiration_get_context");
    expect(request.systemPrompt).toContain("idea-1");
    expect(request.systemPrompt).not.toContain("当前上下文：");
  });
});
