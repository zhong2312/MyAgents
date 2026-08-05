import { ArrowRight, Check, FileText, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import { DraggableDialogFrame } from "@/workbench-sdk";

import type {
  ItemAiSuggestion,
  ItemProfileAiSuggestion,
} from "../business/itemLibraryAi";
import type {
  CategoryFieldDefinition,
  ItemFieldDefinition,
  ItemFieldValue,
  ItemRecord,
} from "../entities/itemLibrarySchema";

type EffectiveField = ItemFieldDefinition | CategoryFieldDefinition;

interface ItemLibraryAiDialogProps {
  readonly itemName: string;
  readonly record: ItemRecord;
  readonly fields: readonly EffectiveField[];
  readonly suggestion: ItemAiSuggestion;
  readonly onApplyProfile: (selectedKeys: ReadonlySet<string>) => void;
  readonly onApplyDescription: (content: string) => void;
  readonly onClose: () => void;
}

interface SuggestionRow {
  readonly key: string;
  readonly label: string;
  readonly current: string;
  readonly proposed: string;
}

function valueLabel(value: ItemFieldValue | undefined): string {
  if (value === undefined || value === null || value === "") return "未填写";
  if (Array.isArray(value)) return value.join("、") || "未填写";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return String(value);
}

function profileRows(
  suggestion: ItemProfileAiSuggestion,
  record: ItemRecord,
  fields: readonly EffectiveField[],
): readonly SuggestionRow[] {
  const rows: SuggestionRow[] = [];
  if (suggestion.summary !== undefined) {
    rows.push({
      key: "summary",
      label: "摘要",
      current: record.summary || "未填写",
      proposed: suggestion.summary,
    });
  }
  if (suggestion.aliases !== undefined) {
    rows.push({
      key: "aliases",
      label: "别名",
      current: record.aliases.join("、") || "未填写",
      proposed: suggestion.aliases.join("、"),
    });
  }
  if (suggestion.tags !== undefined) {
    rows.push({
      key: "tags",
      label: "标签",
      current: record.tags.join("、") || "未填写",
      proposed: suggestion.tags.join("、"),
    });
  }
  for (const [fieldId, value] of Object.entries(suggestion.values)) {
    const field = fields.find((candidate) => candidate.id === fieldId);
    rows.push({
      key: `value:${fieldId}`,
      label: field?.label ?? fieldId,
      current: valueLabel(record.values[fieldId]),
      proposed: valueLabel(value),
    });
  }
  return rows;
}

export default function ItemLibraryAiDialog({
  itemName,
  record,
  fields,
  suggestion,
  onApplyProfile,
  onApplyDescription,
  onClose,
}: ItemLibraryAiDialogProps) {
  const rows = useMemo(
    () =>
      suggestion.kind === "profile"
        ? profileRows(suggestion, record, fields)
        : [],
    [fields, record, suggestion],
  );
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(rows.map((row) => row.key)),
  );
  const [descriptionDraft, setDescriptionDraft] = useState(
    suggestion.kind === "description" ? suggestion.content : "",
  );

  const toggleRow = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = () => {
    if (suggestion.kind === "profile") onApplyProfile(selectedKeys);
    else onApplyDescription(descriptionDraft.trim());
  };
  const canApply =
    suggestion.kind === "profile"
      ? selectedKeys.size > 0
      : descriptionDraft.trim().length > 0;

  return (
    <DraggableDialogFrame
      ariaLabel={
        suggestion.kind === "profile" ? "AI 资料建议" : "AI 描述建议"
      }
      className="h-[min(760px,calc(100vh-24px))] w-[min(760px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">
                {suggestion.kind === "profile" ? "AI 完善资料" : "AI 撰写描述"}
              </h2>
              <p className="truncate text-xs text-[var(--ink-muted)]">
                {itemName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭 AI 建议"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      {suggestion.kind === "profile" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y divide-[var(--line-subtle)]">
            {rows.map((row) => {
              const selected = selectedKeys.has(row.key);
              return (
                <button
                  key={row.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleRow(row.key)}
                  className={`grid w-full grid-cols-[24px_minmax(0,1fr)_24px_minmax(0,1fr)] items-start gap-3 px-5 py-4 text-left transition-colors max-sm:grid-cols-[24px_minmax(0,1fr)] ${
                    selected ? "bg-[var(--paper)]" : "bg-[var(--paper-inset)] opacity-60"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded border ${
                      selected
                        ? "border-[var(--accent-warm)] bg-[var(--accent-warm)] text-white"
                        : "border-[var(--line-strong)]"
                    }`}
                  >
                    {selected && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--ink-muted)]">
                      {row.label} · 当前
                    </span>
                    <span className="mt-1 block break-words text-sm leading-6 text-[var(--ink)]">
                      {row.current}
                    </span>
                  </span>
                  <ArrowRight className="mt-5 h-4 w-4 text-[var(--ink-subtle)]" />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--accent-warm)]">
                      AI 建议
                    </span>
                    <span className="mt-1 block break-words text-sm leading-6 text-[var(--ink)]">
                      {row.proposed}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-5">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium text-[var(--ink-muted)]">
            <FileText className="h-3.5 w-3.5" /> Markdown 描述
          </div>
          <textarea
            value={descriptionDraft}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            aria-label="AI 生成的物品描述"
            className="item-library-input min-h-0 flex-1 resize-none font-mono text-sm leading-6"
          />
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3 max-sm:flex-col max-sm:items-stretch">
        <span className="text-xs text-[var(--ink-muted)]">
          {suggestion.kind === "profile"
            ? `已选择 ${selectedKeys.size} / ${rows.length} 项`
            : "应用后仍可继续编辑"}
        </span>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className="flex items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 py-2 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> 应用建议
          </button>
        </div>
      </footer>
    </DraggableDialogFrame>
  );
}
