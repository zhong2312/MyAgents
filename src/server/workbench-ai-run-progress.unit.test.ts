import { describe, expect, it } from "vitest";

import {
  isWorkbenchAiRunProgressId,
  readWorkbenchAiRunProgress,
  updateWorkbenchAiRunProgress,
} from "./workbench-ai-run-progress";

describe("workbench AI run progress", () => {
  it("accepts bounded correlation IDs and keeps the latest compact projection", () => {
    const runId = "full-generation-7ed0f6ee-0000-4000-8000-000000000000";

    expect(isWorkbenchAiRunProgressId(runId)).toBe(true);
    expect(isWorkbenchAiRunProgressId("short")).toBe(false);

    expect(updateWorkbenchAiRunProgress(runId, "tool", "正在读取世界架构"))
      .toMatchObject({ runId, kind: "tool", revision: 1 });
    expect(updateWorkbenchAiRunProgress(runId, "status", "正在生成正文"))
      .toMatchObject({ runId, kind: "status", message: "正在生成正文", revision: 2 });
    expect(readWorkbenchAiRunProgress(runId)).toMatchObject({
      runId,
      kind: "status",
      revision: 2,
    });
  });
});
