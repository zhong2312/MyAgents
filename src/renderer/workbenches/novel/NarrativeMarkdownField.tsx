import { PencilLine, X } from "lucide-react";
import { useCallback, useState } from "react";

import { useCloseLayer } from "@/hooks/useCloseLayer";
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
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const openEditor = useCallback(() => setOpen(true), []);
  const noopSave = useCallback(() => undefined, []);

  useCloseLayer(() => {
    if (!open) return false;
    close();
    return true;
  }, 210);

  return (
    <div className={`ns-markdown-field ${className}`}>
      <MarkdownVisualEditor
        pageId={`narrative-field:${pageId}`}
        label={label}
        value={value}
        onChange={onChange}
        onSave={noopSave}
        fullWidth
        expandable={!disabled}
        disabled={disabled}
        toolbarVariant="narrative"
        onExpand={openEditor}
        placeholder={placeholder ?? `开始填写${label}……`}
      />
      {open && (
        <DraggableDialogFrame
          ariaLabel={`${label} Markdown 编辑器`}
          className="h-[min(48rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))]"
          overlayClassName="bg-black/35"
          headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
          header={
            <div className="flex h-12 items-center gap-2 px-4">
              <PencilLine className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {label}
              </h2>
              <button
                type="button"
                className="ns-icon-button border-0"
                title="关闭编辑器"
                aria-label="关闭编辑器"
                onClick={close}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          }
        >
          <div className="flex min-h-0 flex-1">
            <MarkdownVisualEditor
              pageId={`narrative-field:${pageId}:dialog`}
              label={label}
              value={value}
              onChange={onChange}
              onSave={close}
              fullWidth
              expandable={false}
              toolbarVariant="narrative"
              placeholder={placeholder ?? `开始填写${label}……`}
            />
          </div>
          <footer className="flex shrink-0 justify-end border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
            <button
              className="ns-button is-primary"
              type="button"
              onClick={close}
            >
              完成
            </button>
          </footer>
        </DraggableDialogFrame>
      )}
    </div>
  );
}
