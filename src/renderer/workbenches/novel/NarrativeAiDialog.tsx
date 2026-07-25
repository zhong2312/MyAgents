import { BrainCircuit, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import { DraggableDialogFrame } from "@/workbench-sdk";

import { NARRATIVE_AI_TASKS, type NarrativeAiTaskId } from "./narrativeAi";

export interface NarrativeAiDialogProps {
  readonly projectTitle: string;
  readonly selectedEntity: string;
  readonly viewLabel: string;
  readonly counts: Readonly<{
    lines: number;
    arcs: number;
    chapters: number;
    sections: number;
    findings: number;
  }>;
  readonly onClose: () => void;
  readonly onSubmit: (
    task: NarrativeAiTaskId,
    userInstruction: string,
  ) => Promise<void>;
}

export default function NarrativeAiDialog({
  projectTitle,
  selectedEntity,
  viewLabel,
  counts,
  onClose,
  onSubmit,
}: NarrativeAiDialogProps) {
  const [task, setTask] = useState<NarrativeAiTaskId>("current");
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
      ariaLabel="剧情工程 AI 共创"
      className="w-[min(42rem,calc(100vw-2rem))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-14 items-center gap-3 px-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]">
            <BrainCircuit className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">剧情工程 AI 共创</h2>
            <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
              {projectTitle} · {viewLabel} · {selectedEntity}
            </p>
          </div>
          <button
            type="button"
            className="ns-icon-button border-0"
            aria-label="关闭剧情工程 AI 共创"
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
        <div className="grid grid-cols-5 gap-2 border-b border-[var(--line)] pb-4">
          {[
            ["线路", counts.lines],
            ["故事弧", counts.arcs],
            ["章节", counts.chapters],
            ["节", counts.sections],
            ["检查项", counts.findings],
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
            {NARRATIVE_AI_TASKS.map((candidate) => (
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
            placeholder="例如：重点检查中点前后的角色弧转折，并给出可以落到具体章节或节的修改建议。"
          />
        </label>

        <p className="mt-4 text-xs leading-5 text-[var(--ink-muted)]">
          AI 会在 MyAgents 完整对话中按需读取剧情工程事实。作者明确要求创建线路或故事弧时，AI 会使用受控工具写入已保存的规划；不会修改正文。
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
