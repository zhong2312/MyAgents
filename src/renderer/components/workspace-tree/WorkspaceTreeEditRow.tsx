import { FilePlus, FolderPlus } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { FileIcon } from "@/components/file-icon";

import { validateItemName } from "./nameValidation";
import type { TreeEditingState } from "./treeTypes";

interface WorkspaceTreeEditRowProps {
  editing: TreeEditingState;
  depth: number;
  rowHeight: number;
  /** Commit a (locally valid) name. The panel performs the Rust call; on
   *  failure it keeps the editor open and surfaces the error. */
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function combinedError(
  name: string,
  editing: TreeEditingState,
  t: TFunction<"app">,
): string | null {
  const base = validateItemName(name);
  if (base) return base;
  if (editing.mode === "rename" && name === editing.initialName) return null;
  if (editing.siblingNames.has(name)) return t("workspaceNameValidation.duplicate");
  return null;
}

/**
 * VS Code-style inline editor row for rename / create. Enter commits, Esc
 * cancels; blur commits when valid-and-changed, otherwise cancels. Rename
 * pre-selects the stem (name without extension).
 */
export const WorkspaceTreeEditRow = memo(function WorkspaceTreeEditRow({
  editing,
  depth,
  rowHeight,
  onCommit,
  onCancel,
}: WorkspaceTreeEditRowProps) {
  const { t } = useTranslation("app");
  const initialName = editing.mode === "rename" ? editing.initialName : "";
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard double-commit: Enter commits, then the resulting blur must not
  // commit (or cancel) again.
  const settledRef = useRef(false);

  const error = useMemo(() => combinedError(name, editing, t), [name, editing, t]);
  const isDir =
    editing.mode === "create-folder" ||
    (editing.mode === "rename" && editing.isDir);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (editing.mode === "rename") {
      const dot = initialName.lastIndexOf(".");
      // Select the stem only (VS Code): renaming "notes.md" pre-selects
      // "notes". Dotfiles / folders select the whole name.
      const end = !isDir && dot > 0 ? dot : initialName.length;
      input.setSelectionRange(0, end);
    }
    // Mount-only: the editor is keyed by editing session in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settle = (action: "commit" | "cancel") => {
    if (settledRef.current) return;
    const trimmed = name.trim();
    if (
      action === "commit" &&
      !combinedError(trimmed, editing, t) &&
      trimmed.length > 0 &&
      !(editing.mode === "rename" && trimmed === editing.initialName)
    ) {
      settledRef.current = true;
      onCommit(trimmed);
      return;
    }
    settledRef.current = true;
    onCancel();
  };

  const icon = isDir ? (
    editing.mode === "create-folder" ? (
      <FolderPlus className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
    ) : (
      <FileIcon name={name || initialName} nodeKind="directory" />
    )
  ) : name ? (
    <FileIcon name={name} />
  ) : (
    <FilePlus className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]" />
  );

  return (
    <div
      className="flex items-center gap-2 px-3"
      style={{ height: rowHeight, paddingLeft: `${12 + depth * 16}px` }}
    >
      <span className="h-4 w-4 flex-shrink-0" />
      {icon}
      <input
        ref={inputRef}
        type="text"
        value={name}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        title={error ?? undefined}
        onChange={(e) => setName(e.target.value)}
        // The tree container owns global key handling (arrows / F2 / Cmd+C…);
        // while typing a name those must stay in the input.
        onKeyDown={(e) => {
          e.stopPropagation();
          // IME composition (中文输入选候选词) also presses Enter — committing
          // there would create/rename with a half-composed name.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            settle("commit");
          } else if (e.key === "Escape") {
            e.preventDefault();
            settle("cancel");
          }
        }}
        onBlur={() => settle("commit")}
        className={`h-5 min-w-0 flex-1 rounded-sm border bg-[var(--paper-elevated)] px-1 text-sm text-[var(--ink)] outline-none ${
          error
            ? "border-[var(--error)]"
            : "border-[var(--accent)]/60 focus:border-[var(--accent)]"
        }`}
      />
    </div>
  );
});
