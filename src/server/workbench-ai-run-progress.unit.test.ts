import { describe, expect, it } from "vitest";

import {
  beginWorkbenchAiRun,
  cancelWorkbenchAiRun,
  finishWorkbenchAiRun,
  isWorkbenchAiRunProgressId,
  readWorkbenchAiRunProgress,
  updateWorkbenchAiRunProgress,
} from "./workbench-ai-run-progress";

describe("workbench AI run progress", () => {
  it("accepts bounded correlation IDs and keeps the latest compact projection", () => {
    const runId = "full-generation-7ed0f6ee-0000-4000-8000-000000000000";

    expect(isWorkbenchAiRunProgressId(runId)).toBe(true);
    expect(isWorkbenchAiRunProgressId("short")).toBe(false);

    expect(
      updateWorkbenchAiRunProgress(runId, "tool", "正在读取世界架构"),
    ).toMatchObject({ runId, kind: "tool", revision: 1 });
    expect(
      updateWorkbenchAiRunProgress(runId, "status", "正在生成正文"),
    ).toMatchObject({
      runId,
      kind: "status",
      message: "正在生成正文",
      revision: 2,
    });
    expect(readWorkbenchAiRunProgress(runId)).toMatchObject({
      runId,
      kind: "status",
      revision: 2,
    });
    expect(
      updateWorkbenchAiRunProgress(runId, "status", "正在生成结果", "实时文本"),
    ).toMatchObject({ partialOutput: "实时文本", revision: 3 });
    expect(readWorkbenchAiRunProgress(runId)).toMatchObject({
      partialOutput: "实时文本",
      revision: 3,
    });
  });

  it("cancels only the matching active run", () => {
    const cancelledRunId =
      "full-generation-7ed0f6ee-0000-4000-8000-000000000001";
    const otherRunId = "full-generation-7ed0f6ee-0000-4000-8000-000000000002";
    const cancelledController = beginWorkbenchAiRun(cancelledRunId);
    const otherController = beginWorkbenchAiRun(otherRunId);

    expect(cancelWorkbenchAiRun(cancelledRunId)).toBe(true);
    expect(cancelledController.signal.aborted).toBe(true);
    expect(otherController.signal.aborted).toBe(false);
    expect(readWorkbenchAiRunProgress(cancelledRunId)).toMatchObject({
      message: "正在停止本次生成",
    });

    finishWorkbenchAiRun(cancelledRunId, cancelledController);
    finishWorkbenchAiRun(otherRunId, otherController);
    expect(cancelWorkbenchAiRun(cancelledRunId)).toBe(false);
  });
});
