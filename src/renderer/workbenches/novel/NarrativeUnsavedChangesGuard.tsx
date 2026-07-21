import { AlertTriangle, Loader2, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCloseLayer } from "@/hooks/useCloseLayer";
import {
  DraggableDialogFrame,
  type WorkbenchNavigationGuard,
} from "@/workbench-sdk";

interface NarrativeUnsavedChangesGuardProps {
  readonly dirty: boolean;
  readonly label: string;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
  readonly onSave: () => Promise<boolean>;
}

export default function NarrativeUnsavedChangesGuard({
  dirty,
  label,
  registerNavigationGuard,
  onSave,
}: NarrativeUnsavedChangesGuardProps) {
  const dirtyRef = useRef(dirty);
  const saveRef = useRef(onSave);
  const pendingPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
    saveRef.current = onSave;
  }, [dirty, onSave]);

  const complete = useCallback((allowed: boolean) => {
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    pendingPromiseRef.current = null;
    setOpen(false);
    setSaving(false);
    setError(null);
    resolve?.(allowed);
  }, []);
  useCloseLayer(() => {
    if (!open) return false;
    if (!saving) complete(false);
    return true;
  }, 210);

  const confirmLeave = useCallback(() => {
    if (!dirtyRef.current) return Promise.resolve(true);
    if (pendingPromiseRef.current) return pendingPromiseRef.current;
    const pending = new Promise<boolean>((resolve) => {
      pendingResolveRef.current = resolve;
    });
    pendingPromiseRef.current = pending;
    setError(null);
    setOpen(true);
    return pending;
  }, []);

  useEffect(
    () => registerNavigationGuard({ confirmLeave }),
    [confirmLeave, registerNavigationGuard],
  );

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  useEffect(
    () => () => {
      pendingResolveRef.current?.(false);
      pendingResolveRef.current = null;
      pendingPromiseRef.current = null;
    },
    [],
  );

  const saveAndLeave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveRef.current();
      if (saved) complete(true);
      else {
        setSaving(false);
        setError("保存没有完成，请检查页面中的错误后重试。");
      }
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!open) return null;
  return (
    <DraggableDialogFrame
      ariaLabel="未保存修改"
      className="w-[min(520px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center gap-2 px-4">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warning)]" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {label}有未保存修改
          </h2>
          <button
            type="button"
            className="ns-icon-button border-0"
            title="继续编辑"
            aria-label="继续编辑"
            disabled={saving}
            onClick={() => complete(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="px-5 py-5">
        <p className="text-sm leading-6 text-[var(--ink-muted)]">
          离开后，本页尚未保存的修改将不会写入项目。你可以先保存，也可以明确放弃这些修改。
        </p>
        {error && (
          <div className="mt-4 rounded-md border border-[var(--error)]/30 bg-[var(--error)]/5 px-3 py-2 text-sm text-[var(--error)]">
            {error}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
        <button
          type="button"
          className="ns-button"
          disabled={saving}
          onClick={() => complete(false)}
        >
          继续编辑
        </button>
        <button
          type="button"
          className="ns-button is-danger"
          disabled={saving}
          onClick={() => complete(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />放弃修改
        </button>
        <button
          type="button"
          className="ns-button is-primary"
          disabled={saving}
          onClick={() => void saveAndLeave()}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "保存中" : "保存并离开"}
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}
