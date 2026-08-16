import type {
  WorkbenchAiRunProgress,
  WorkbenchAiRunProgressKind,
} from "../shared/workbench-sdk";

const RUN_ID_PATTERN = /^[a-zA-Z0-9-]{16,128}$/u;
const PROGRESS_TTL_MS = 15 * 60_000;
const progressByRunId = new Map<string, WorkbenchAiRunProgress>();
const expiryByRunId = new Map<string, ReturnType<typeof setTimeout>>();

export function isWorkbenchAiRunProgressId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function updateWorkbenchAiRunProgress(
  runId: string,
  kind: WorkbenchAiRunProgressKind,
  message: string,
): WorkbenchAiRunProgress {
  const previous = progressByRunId.get(runId);
  const normalizedMessage = message.trim().slice(0, 160) || "正在处理本次请求";
  const progress: WorkbenchAiRunProgress = {
    runId,
    kind,
    message: normalizedMessage,
    revision: (previous?.revision ?? 0) + 1,
  };
  progressByRunId.set(runId, progress);

  const previousExpiry = expiryByRunId.get(runId);
  if (previousExpiry) clearTimeout(previousExpiry);
  expiryByRunId.set(
    runId,
    setTimeout(() => {
      progressByRunId.delete(runId);
      expiryByRunId.delete(runId);
    }, PROGRESS_TTL_MS),
  );
  return progress;
}

export function readWorkbenchAiRunProgress(
  runId: string,
): WorkbenchAiRunProgress | null {
  return progressByRunId.get(runId) ?? null;
}
