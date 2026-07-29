import { BrainCircuit, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { DraggableDialogFrame } from "@/workbench-sdk";

import { TIMELINE_AI_TASKS, type TimelineAiTaskId } from "./timelineAi";

export interface TimelineAiDialogProps {
  readonly projectTitle: string;
  readonly selectedLabel: string;
  readonly counts: Readonly<{
    events: number;
    periods: number;
    branches: number;
    foreshadowings: number;
  }>;
  readonly onClose: () => void;
  readonly onSubmit: (
    task: TimelineAiTaskId,
    userInstruction: string,
  ) => Promise<void>;
}

export default function TimelineAiDialog({
  projectTitle,
  selectedLabel,
  counts,
  onClose,
  onSubmit,
}: TimelineAiDialogProps) {
  const [task, setTask] = useState<TimelineAiTaskId>("consistency");
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit(task, instruction);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DraggableDialogFrame
      ariaLabel="时间线 AI 共创"
      className="w-[min(42rem,calc(100vw-2rem))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-14 items-center gap-3 px-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]">
            <BrainCircuit className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">时间线 AI 共创</h2>
            <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {selectedLabel}
            </p>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            aria-label="关闭时间线 AI 共创"
            title="关闭"
            onClick={onClose}
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="ne-panel-scroll min-h-0 flex-1 p-5">
        <div className="grid grid-cols-4 gap-2 border-b border-[var(--line)] pb-4">
          {[
            ["事件", counts.events],
            ["纪元", counts.periods],
            ["分支", counts.branches],
            ["伏笔", counts.foreshadowings],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-2 py-2 text-center"
            >
              <div className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                {value}
              </div>
              <div className="mt-0.5 text-[0.65rem] text-[var(--ink-muted)]">
                {label}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--accent-warm)]" />
            <h3 className="text-sm font-semibold">选择共创方向</h3>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {TIMELINE_AI_TASKS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`rounded-md border px-3 py-3 text-left transition-colors ${
                  task === candidate.id
                    ? "border-[var(--accent-warm)] bg-[var(--accent-warm-muted)]"
                    : "border-[var(--line)] bg-[var(--paper)] hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]"
                }`}
                onClick={() => setTask(candidate.id)}
                disabled={submitting}
              >
                <span className="block text-xs font-semibold text-[var(--ink)]">
                  {candidate.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">
                  {candidate.description}
                </span>
              </button>
            ))}
          </div>
        </div>

        <label className="mt-5 block">
          <span className="text-xs font-medium text-[var(--ink-muted)]">
            作者补充要求
            <span className="ml-1 font-normal text-[var(--ink-subtle)]">
              （可选）
            </span>
          </span>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={submitting}
            rows={4}
            className="ne-input mt-2 min-h-24 resize-y leading-6"
            placeholder="例如：核对当前分支在第一个分歧点之后是否还保留了不应继承的事件。"
          />
        </label>

        <p className="mt-4 text-xs leading-5 text-[var(--ink-muted)]">
          AI 会在 MyAgents 完整对话中按需读取已保存的时间线与关联事实，并给出可由作者确认后录入的建议；不会直接修改时间线或正文。
        </p>
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
        <button
          type="button"
          className="ns-button"
          onClick={onClose}
          disabled={submitting}
        >
          取消
        </button>
        <button
          type="button"
          className="ns-button is-primary"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {submitting ? "正在打开" : "进入 AI 共创"}
        </button>
      </div>
    </DraggableDialogFrame>
  );
}
