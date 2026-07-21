import { CircleHelp, Lightbulb, X } from "lucide-react";
import { useState } from "react";

import { useCloseLayer } from "@/hooks/useCloseLayer";
import { DraggableDialogFrame } from "@/workbench-sdk";

export default function InspirationHelp() {
  const [open, setOpen] = useState(false);
  useCloseLayer(() => {
    if (!open) return false;
    setOpen(false);
    return true;
  }, 210);

  return (
    <>
      <button
        type="button"
        className="ns-icon-button ns-help-button"
        aria-label="查看灵感使用说明"
        title="灵感使用说明"
        onClick={() => setOpen(true)}
      >
        <CircleHelp className="h-4 w-4" />
      </button>
      {open && (
        <DraggableDialogFrame
          ariaLabel="灵感使用说明"
          className="max-h-[min(42rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-2rem))]"
          overlayClassName="bg-black/35"
          headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
          header={
            <div className="flex h-12 items-center gap-2 px-4">
              <Lightbulb className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                灵感使用说明
              </h2>
              <button
                type="button"
                className="ns-icon-button border-0"
                aria-label="关闭使用说明"
                title="关闭"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          }
        >
          <div className="min-h-0 overflow-y-auto px-5 py-5 text-sm leading-7">
            <p className="text-[var(--ink-muted)]">
              灵感库用于保存尚未定稿的片段、意象、问题和研究触发点。这里的内容是素材，不代表小说已经采用或正文已经发生。
            </p>
            <section className="mt-5 border-t border-[var(--line-subtle)] pt-4">
              <h3 className="font-semibold">推荐流程</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--ink-muted)]">
                <li>先用标题记录能重新唤起想法的一句话。</li>
                <li>在正文中补充画面、冲突、人物反应或参考来源。</li>
                <li>用标签聚合同类素材，将状态从收集箱推进到待整理。</li>
                <li>暂时不用的内容标为暂不使用，过期内容归档。</li>
              </ol>
            </section>
            <section className="mt-5 border-t border-[var(--line-subtle)] pt-4">
              <h3 className="font-semibold">AI 能做什么</h3>
              <p className="mt-2 text-[var(--ink-muted)]">
                AI 可以检查想法是否清晰、与现有灵感是否重复，并提供三个发展方向。结果只作为建议，不会自动修改灵感文件或正文。
              </p>
            </section>
          </div>
        </DraggableDialogFrame>
      )}
    </>
  );
}
