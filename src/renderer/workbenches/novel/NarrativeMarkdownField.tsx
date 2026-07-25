import { X } from "lucide-react";
import { useState } from "react";

import { DraggableDialogFrame } from "@/workbench-sdk";

import MarkdownVisualEditor from "./MarkdownVisualEditor";

interface NarrativeMarkdownFieldProps {
  readonly pageId: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

export default function NarrativeMarkdownField({
  pageId,
  label,
  value,
  onChange,
  placeholder,
  className = "",
  disabled = false,
}: NarrativeMarkdownFieldProps) {
  const [isPopupOpen, setIsPopupOpen] = useState(false);

  return (
    <>
      <div className={`ns-markdown-field ${className}`}>
        <MarkdownVisualEditor
          pageId={`narrative-field:${pageId}`}
          label={label}
          value={value}
          onChange={onChange}
          onSave={() => undefined}
          fullWidth
          expandable
          disabled={disabled}
          toolbarVariant="full"
          onExpand={() => setIsPopupOpen(true)}
          placeholder={placeholder ?? `开始填写${label}……`}
        />
      </div>
      {isPopupOpen && (
        <DraggableDialogFrame
          ariaLabel={`${label}弹窗编辑`}
          className="h-[min(42rem,calc(100vh-5rem))] w-[min(56rem,calc(100vw-4rem))]"
          overlayClassName="bg-black/35"
          headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
          header={
            <div className="flex h-12 items-center justify-between gap-3 px-4">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{label}</h2>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  Markdown 弹窗编辑
                </p>
              </div>
              <button
                type="button"
                className="ns-icon-button border-0"
                title="关闭弹窗编辑"
                aria-label="关闭弹窗编辑"
                onClick={() => setIsPopupOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          }
        >
          <div className="min-h-0 flex-1">
            <MarkdownVisualEditor
              pageId={`narrative-field:${pageId}:popup`}
              label={label}
              value={value}
              onChange={onChange}
              onSave={() => undefined}
              fullWidth
              expandable={false}
              disabled={disabled}
              toolbarVariant="full"
              className="ne-track-markdown-field narrative-markdown-dialog-editor"
              placeholder={placeholder ?? `开始填写${label}……`}
            />
          </div>
        </DraggableDialogFrame>
      )}
    </>
  );
}
