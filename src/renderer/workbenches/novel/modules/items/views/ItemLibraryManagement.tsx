import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderPlus,
  LockKeyhole,
  Loader2,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  ConfirmDialog,
  CustomSelect,
  DraggableDialogFrame,
  type SelectOption,
  type WorkbenchNavigationGuard,
} from "@/workbench-sdk";
import NarrativeUnsavedChangesGuard from "../../../NarrativeUnsavedChangesGuard";

import type { LoadedItemLibrary } from "../data-access/itemLibraryRepository";
import {
  getCategoryAncestors,
  type CategoryFieldDefinition,
  type ItemCategory,
  type ItemFieldDefinition,
  type ItemFieldType,
  type ItemFieldValue,
  type ItemLibraryMeta,
} from "../entities/itemLibrarySchema";

const ROOT_CATEGORY_VALUE = "__root__";

const FIELD_TYPE_OPTIONS: SelectOption[] = [
  { value: "text", label: "单行文本" },
  { value: "textarea", label: "多行文本" },
  { value: "number", label: "数字 / 单位" },
  { value: "single-select", label: "单选" },
  { value: "multi-select", label: "多选" },
  { value: "boolean", label: "开关" },
  { value: "story-time", label: "故事时间" },
  { value: "entity-reference", label: "实体引用" },
  { value: "asset-reference", label: "资产引用" },
];

function uniqueId(prefix: string): string {
  const token =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);
  return `${prefix}-${token}`;
}

function defaultValueForType(type: ItemFieldType): ItemFieldValue {
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "multi-select") return [];
  return "";
}

export function createEmptyItemFieldDefinition(
  id = uniqueId("field"),
): ItemFieldDefinition {
  return {
    id,
    label: "新字段",
    description: "",
    group: "扩展信息",
    type: "text",
    required: false,
    defaultValue: "",
    options: [],
    order: 0,
  };
}

interface ItemFieldEditorDialogProps {
  readonly title: string;
  readonly definition: ItemFieldDefinition;
  readonly lockType?: boolean;
  readonly onSubmit: (definition: ItemFieldDefinition) => void;
  readonly onClose: () => void;
}

export function ItemFieldEditorDialog({
  title,
  definition,
  lockType = false,
  onSubmit,
  onClose,
}: ItemFieldEditorDialogProps) {
  const [draft, setDraft] = useState<ItemFieldDefinition>(definition);
  const [optionsText, setOptionsText] = useState(definition.options.join("\n"));
  const [entityTypesText, setEntityTypesText] = useState(
    definition.entityTypes?.join(", ") ?? "",
  );

  const applyType = (value: string) => {
    const type = value as ItemFieldType;
    setDraft((current) => ({
      ...current,
      type,
      defaultValue: defaultValueForType(type),
      options:
        type === "single-select" || type === "multi-select"
          ? current.options
          : [],
    }));
  };

  const submit = () => {
    const label = draft.label.trim();
    const group = draft.group.trim();
    if (!label || !group) return;
    const options = optionsText
      .split(/\r?\n/u)
      .map((option) => option.trim())
      .filter(Boolean);
    const entityTypes = entityTypesText
      .split(/[，,]/u)
      .map((item) => item.trim())
      .filter(Boolean);
    onSubmit({
      ...draft,
      label,
      group,
      description: draft.description.trim(),
      options,
      ...(draft.unit?.trim()
        ? { unit: draft.unit.trim() }
        : { unit: undefined }),
      ...(entityTypes.length ? { entityTypes } : { entityTypes: undefined }),
    });
  };

  return (
    <DraggableDialogFrame
      ariaLabel={title}
      className="h-[min(720px,calc(100vh-32px))] w-[min(620px,calc(100vw-24px))]"
      overlayClassName="bg-black/35"
      headerClassName="border-b border-[var(--line)] bg-[var(--paper-elevated)]"
      header={
        <div className="flex h-12 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="h-4 w-4 text-[var(--accent-warm)]" />
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭字段编辑"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <FieldLabel label="字段名称" required>
            <input
              value={draft.label}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  label: event.target.value,
                }))
              }
              className="item-library-input"
              autoFocus
            />
          </FieldLabel>
          <FieldLabel label="分组" required>
            <input
              value={draft.group}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  group: event.target.value,
                }))
              }
              className="item-library-input"
            />
          </FieldLabel>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 max-sm:grid-cols-1">
          <FieldLabel label="字段类型">
            {lockType ? (
              <>
                <div
                  aria-label="字段类型"
                  className="flex h-9 items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 text-xs text-[var(--ink-muted)]"
                >
                  <span>
                    {FIELD_TYPE_OPTIONS.find(
                      (option) => option.value === draft.type,
                    )?.label ?? draft.type}
                  </span>
                  <LockKeyhole className="h-3.5 w-3.5" />
                </div>
                <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                  已有字段不可更改类型
                </p>
              </>
            ) : (
              <CustomSelect
                value={draft.type}
                options={FIELD_TYPE_OPTIONS}
                onChange={applyType}
                ariaLabel="字段类型"
              />
            )}
          </FieldLabel>
          {draft.type === "number" ? (
            <FieldLabel label="单位">
              <input
                value={draft.unit ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    unit: event.target.value,
                  }))
                }
                placeholder="例如 cm、kg"
                className="item-library-input"
              />
            </FieldLabel>
          ) : (
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--ink)]">
                <input
                  type="checkbox"
                  checked={draft.required}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      required: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 accent-[var(--accent-warm)]"
                />
                必填字段
              </label>
            </div>
          )}
        </div>

        {draft.type === "number" && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  required: event.target.checked,
                }))
              }
              className="h-4 w-4 accent-[var(--accent-warm)]"
            />
            必填字段
          </label>
        )}

        <FieldLabel label="字段说明" className="mt-4">
          <textarea
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            rows={3}
            className="item-library-input resize-y"
          />
        </FieldLabel>

        {(draft.type === "single-select" || draft.type === "multi-select") && (
          <FieldLabel label="选项（每行一个）" className="mt-4">
            <textarea
              value={optionsText}
              onChange={(event) => setOptionsText(event.target.value)}
              rows={5}
              className="item-library-input resize-y font-mono"
            />
          </FieldLabel>
        )}

        {draft.type === "entity-reference" && (
          <FieldLabel label="允许的实体类型（逗号分隔）" className="mt-4">
            <input
              value={entityTypesText}
              onChange={(event) => setEntityTypesText(event.target.value)}
              placeholder="character, faction, location"
              className="item-library-input font-mono"
            />
          </FieldLabel>
        )}

        <FieldLabel label="默认值" className="mt-4">
          <DefaultValueEditor
            definition={draft}
            onChange={(defaultValue) =>
              setDraft((current) => ({ ...current, defaultValue }))
            }
          />
        </FieldLabel>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!draft.label.trim() || !draft.group.trim()}
          className="flex items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 py-2 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-4 w-4" /> 确定
        </button>
      </footer>
    </DraggableDialogFrame>
  );
}

function DefaultValueEditor({
  definition,
  onChange,
}: {
  readonly definition: ItemFieldDefinition;
  readonly onChange: (value: ItemFieldValue) => void;
}) {
  if (definition.type === "boolean") {
    return (
      <label className="flex h-9 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={definition.defaultValue === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--accent-warm)]"
        />
        默认开启
      </label>
    );
  }
  if (definition.type === "multi-select") {
    return (
      <input
        value={
          Array.isArray(definition.defaultValue)
            ? definition.defaultValue.join(", ")
            : ""
        }
        onChange={(event) =>
          onChange(
            event.target.value
              .split(/[，,]/u)
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
        placeholder="逗号分隔"
        className="item-library-input"
      />
    );
  }
  return (
    <input
      type={definition.type === "number" ? "number" : "text"}
      value={
        typeof definition.defaultValue === "string" ||
        typeof definition.defaultValue === "number"
          ? definition.defaultValue
          : ""
      }
      onChange={(event) =>
        onChange(
          definition.type === "number" && event.target.value !== ""
            ? Number(event.target.value)
            : event.target.value,
        )
      }
      className="item-library-input"
    />
  );
}

function FieldLabel({
  label,
  required,
  className = "",
  children,
}: {
  readonly label: string;
  readonly required?: boolean;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
        {label}
        {required && <span className="ml-1 text-[var(--error)]">*</span>}
      </span>
      {children}
    </label>
  );
}

interface ItemLibraryManagementProps {
  readonly library: LoadedItemLibrary;
  readonly isSaving: boolean;
  readonly onSave: (meta: ItemLibraryMeta) => Promise<void>;
  readonly onClose: () => void;
  readonly registerNavigationGuard?: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

export default function ItemLibraryManagement({
  library,
  isSaving,
  onSave,
  onClose,
  registerNavigationGuard,
}: ItemLibraryManagementProps) {
  const [draft, setDraft] = useState(library.meta);
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    library.meta.categories[0]?.id ?? "",
  );
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () =>
      new Set(
        library.meta.categories
          .filter((category) =>
            library.meta.categories.some(
              (candidate) => candidate.parentId === category.id,
            ),
          )
          .map((category) => category.id),
      ),
  );
  const [fieldEditor, setFieldEditor] = useState<{
    readonly definition: ItemFieldDefinition;
    readonly existingId: string | null;
  } | null>(null);
  const [deleteCategory, setDeleteCategory] = useState<ItemCategory | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(library.meta),
    [draft, library.meta],
  );
  const selectedCategory =
    draft.categories.find((category) => category.id === selectedCategoryId) ??
    draft.categories[0];

  const itemCountByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    library.index.items.forEach((item) =>
      counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1),
    );
    return counts;
  }, [library.index.items]);

  const save = async () => {
    if (!dirty || isSaving) return true;
    setError(null);
    try {
      await onSave(draft);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const close = async () => {
    if (dirty && !(await save())) return;
    onClose();
  };

  const updateSelected = (patch: Partial<ItemCategory>) => {
    if (!selectedCategory) return;
    setDraft((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.id === selectedCategory.id
          ? { ...category, ...patch }
          : category,
      ),
    }));
  };

  const descendants = useMemo(() => {
    if (!selectedCategory) return new Set<string>();
    const result = new Set<string>();
    const visit = (parentId: string) => {
      draft.categories
        .filter((category) => category.parentId === parentId)
        .forEach((category) => {
          result.add(category.id);
          visit(category.id);
        });
    };
    visit(selectedCategory.id);
    return result;
  }, [draft.categories, selectedCategory]);

  const parentOptions: SelectOption[] = [
    { value: ROOT_CATEGORY_VALUE, label: "顶级分类" },
    ...draft.categories
      .filter(
        (category) =>
          category.id !== selectedCategory?.id && !descendants.has(category.id),
      )
      .map((category) => ({
        value: category.id,
        label: getCategoryAncestors(draft, category.id)
          .map((item) => item.name)
          .join(" / "),
      })),
  ];

  const createCategory = (parentId: string | null) => {
    const id = uniqueId("category");
    const siblings = draft.categories.filter(
      (category) => category.parentId === parentId,
    );
    setDraft((current) => ({
      ...current,
      categories: [
        ...current.categories,
        {
          id,
          parentId,
          name: "新分类",
          description: "",
          icon: "folder",
          order:
            siblings.reduce(
              (maximum, category) => Math.max(maximum, category.order),
              0,
            ) + 10,
        },
      ],
    }));
    if (parentId) {
      setExpandedCategories((current) => new Set(current).add(parentId));
    }
    setSelectedCategoryId(id);
  };

  const ownedFields = draft.fields
    .filter((field) => field.ownerCategoryId === selectedCategory?.id)
    .sort((left, right) => left.order - right.order);
  const inheritedFields = selectedCategory
    ? draft.fields.filter(
        (field) =>
          !field.archived &&
          field.ownerCategoryId !== selectedCategory.id &&
          getCategoryAncestors(draft, selectedCategory.id).some(
            (category) => category.id === field.ownerCategoryId,
          ),
      )
    : [];

  const openNewField = () => {
    const maximumOrder = ownedFields.reduce(
      (maximum, field) => Math.max(maximum, field.order),
      0,
    );
    setFieldEditor({
      definition: {
        ...createEmptyItemFieldDefinition(),
        order: maximumOrder + 10,
      },
      existingId: null,
    });
  };

  const submitField = (definition: ItemFieldDefinition) => {
    if (!selectedCategory || !fieldEditor) return;
    const categoryField: CategoryFieldDefinition = {
      ...definition,
      ownerCategoryId: selectedCategory.id,
    };
    setDraft((current) => ({
      ...current,
      fields: fieldEditor.existingId
        ? current.fields.map((field) =>
            field.id === fieldEditor.existingId ? categoryField : field,
          )
        : [...current.fields, categoryField],
    }));
    setFieldEditor(null);
  };

  const moveField = (fieldId: string, direction: -1 | 1) => {
    const index = ownedFields.findIndex((field) => field.id === fieldId);
    const target = ownedFields[index + direction];
    const field = ownedFields[index];
    if (!field || !target) return;
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((item) =>
        item.id === field.id
          ? { ...item, order: target.order }
          : item.id === target.id
            ? { ...item, order: field.order }
            : item,
      ),
    }));
  };

  const confirmDeleteCategory = () => {
    if (!deleteCategory) return;
    const categoryId = deleteCategory.id;
    setDraft((current) => ({
      ...current,
      categories: current.categories.filter(
        (category) => category.id !== categoryId,
      ),
    }));
    setSelectedCategoryId(
      deleteCategory.parentId ?? draft.categories[0]?.id ?? "",
    );
    setDeleteCategory(null);
  };

  if (!selectedCategory) return null;
  const hasChildren = draft.categories.some(
    (category) => category.parentId === selectedCategory.id,
  );
  const directItemCount = itemCountByCategory.get(selectedCategory.id) ?? 0;
  const canDelete =
    !selectedCategory.system &&
    !hasChildren &&
    directItemCount === 0 &&
    ownedFields.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      {registerNavigationGuard && (
        <NarrativeUnsavedChangesGuard
          dirty={dirty}
          label="物品分类与字段"
          registerNavigationGuard={registerNavigationGuard}
          onSave={save}
        />
      )}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-elevated)] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => void close()}
            aria-label="返回物品库"
            title="返回物品库"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">分类与字段管理</h1>
            <p className="truncate text-xs text-[var(--ink-muted)]">
              {library.index.items.length} 件物品 · {draft.categories.length}{" "}
              个分类
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || isSaving}
          className="flex h-9 items-center gap-2 rounded-md bg-[var(--accent-warm)] px-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : dirty ? (
            <Save className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {isSaving ? "保存中" : dirty ? "保存更改" : "已保存"}
        </button>
      </header>

      {error && (
        <div className="shrink-0 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)] max-md:w-52">
          <div className="flex h-12 items-center justify-between border-b border-[var(--line)] px-3">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">
              分类树
            </span>
            <button
              type="button"
              onClick={() => createCategory(null)}
              aria-label="新增顶级分类"
              title="新增顶级分类"
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--hover-bg)]"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree">
            <CategoryManagementTree
              meta={draft}
              parentId={null}
              selectedId={selectedCategory.id}
              expanded={expandedCategories}
              counts={itemCountByCategory}
              onToggle={(id) =>
                setExpandedCategories((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelect={setSelectedCategoryId}
            />
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-6 max-md:px-4">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Folder className="h-5 w-5 shrink-0 text-[var(--accent-warm)]" />
                  <h2 className="truncate text-lg font-semibold">
                    {selectedCategory.name}
                  </h2>
                  {selectedCategory.archived && (
                    <span className="rounded border border-[var(--line)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                      已归档
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {getCategoryAncestors(draft, selectedCategory.id)
                    .map((category) => category.name)
                    .join(" / ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => createCategory(selectedCategory.id)}
                  aria-label="新增子分类"
                  title="新增子分类"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
                {!selectedCategory.system && (
                  <button
                    type="button"
                    onClick={() =>
                      updateSelected({ archived: !selectedCategory.archived })
                    }
                    aria-label={
                      selectedCategory.archived ? "恢复分类" : "归档分类"
                    }
                    title={selectedCategory.archived ? "恢复分类" : "归档分类"}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  >
                    {selectedCategory.archived ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canDelete}
                  onClick={() => setDeleteCategory(selectedCategory)}
                  aria-label="删除分类"
                  title={
                    canDelete
                      ? "删除分类"
                      : selectedCategory.system
                        ? "系统分类不可删除"
                        : hasChildren
                          ? "请先处理子分类"
                          : directItemCount > 0
                            ? "请先迁移分类中的物品"
                            : "含字段定义的分类只能归档"
                  }
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <section className="grid grid-cols-2 gap-4 border-b border-[var(--line)] py-5 max-lg:grid-cols-1">
              <FieldLabel label="分类名称" required>
                <input
                  value={selectedCategory.name}
                  disabled={selectedCategory.system}
                  onChange={(event) =>
                    updateSelected({ name: event.target.value })
                  }
                  className="item-library-input"
                />
              </FieldLabel>
              <FieldLabel label="父分类">
                <CustomSelect
                  value={selectedCategory.parentId ?? ROOT_CATEGORY_VALUE}
                  options={parentOptions}
                  onChange={(value) =>
                    updateSelected({
                      parentId: value === ROOT_CATEGORY_VALUE ? null : value,
                    })
                  }
                  ariaLabel="父分类"
                  className={
                    selectedCategory.system
                      ? "pointer-events-none opacity-60"
                      : ""
                  }
                />
              </FieldLabel>
              <FieldLabel label="图标标识">
                <input
                  value={selectedCategory.icon}
                  onChange={(event) =>
                    updateSelected({ icon: event.target.value })
                  }
                  className="item-library-input font-mono"
                />
              </FieldLabel>
              <FieldLabel label="排序值">
                <input
                  type="number"
                  min={0}
                  value={selectedCategory.order}
                  onChange={(event) =>
                    updateSelected({ order: Number(event.target.value) || 0 })
                  }
                  className="item-library-input"
                />
              </FieldLabel>
              <FieldLabel
                label="分类说明"
                className="col-span-2 max-lg:col-span-1"
              >
                <textarea
                  value={selectedCategory.description}
                  onChange={(event) =>
                    updateSelected({ description: event.target.value })
                  }
                  rows={3}
                  className="item-library-input resize-y"
                />
              </FieldLabel>
            </section>

            <section className="py-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">分类字段</h3>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                    {ownedFields.length} 个本级字段 · {inheritedFields.length}{" "}
                    个继承字段
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openNewField}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-xs font-medium hover:bg-[var(--hover-bg)]"
                >
                  <Plus className="h-3.5 w-3.5" /> 新增字段
                </button>
              </div>

              {inheritedFields.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {inheritedFields.map((field) => (
                    <span
                      key={field.id}
                      className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-muted)]"
                    >
                      {field.label}
                      <span className="ml-1 text-xs text-[var(--ink-subtle)]">
                        来自
                        {draft.categories.find(
                          (category) => category.id === field.ownerCategoryId,
                        )?.name ?? field.ownerCategoryId}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="divide-y divide-[var(--line-subtle)] border-y border-[var(--line)]">
                {ownedFields.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-[var(--ink-muted)]">
                    暂无本级字段
                  </div>
                ) : (
                  ownedFields.map((field, index) => (
                    <div
                      key={field.id}
                      className={`flex items-center gap-3 px-3 py-3 ${
                        field.archived ? "opacity-55" : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {field.label}
                          </span>
                          <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                            {FIELD_TYPE_OPTIONS.find(
                              (option) => option.value === field.type,
                            )?.label ?? field.type}
                          </span>
                          {field.required && (
                            <span className="text-xs text-[var(--error)]">
                              必填
                            </span>
                          )}
                          {field.archived && (
                            <span className="text-xs text-[var(--ink-muted)]">
                              已归档
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">
                          {field.group} · {field.id}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => moveField(field.id, -1)}
                          aria-label="字段上移"
                          title="上移"
                          className="management-icon-button"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={index === ownedFields.length - 1}
                          onClick={() => moveField(field.id, 1)}
                          aria-label="字段下移"
                          title="下移"
                          className="management-icon-button"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setFieldEditor({
                              definition: { ...field },
                              existingId: field.id,
                            })
                          }
                          className="rounded-md px-2 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const maximumOrder = ownedFields.reduce(
                              (maximum, item) => Math.max(maximum, item.order),
                              0,
                            );
                            const copy = {
                              ...field,
                              id: uniqueId("field"),
                              label: `${field.label}副本`,
                              order: maximumOrder + 10,
                              archived: false,
                            };
                            setDraft((current) => ({
                              ...current,
                              fields: [...current.fields, copy],
                            }));
                          }}
                          aria-label="复制字段"
                          title="复制字段"
                          className="management-icon-button"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              fields: current.fields.map((item) =>
                                item.id === field.id
                                  ? { ...item, archived: !field.archived }
                                  : item,
                              ),
                            }))
                          }
                          aria-label={field.archived ? "恢复字段" : "归档字段"}
                          title={field.archived ? "恢复字段" : "归档字段"}
                          className="management-icon-button"
                        >
                          {field.archived ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </main>
      </div>

      {fieldEditor && (
        <ItemFieldEditorDialog
          title={fieldEditor.existingId ? "编辑分类字段" : "新增分类字段"}
          definition={fieldEditor.definition}
          lockType={fieldEditor.existingId !== null}
          onSubmit={submitField}
          onClose={() => setFieldEditor(null)}
        />
      )}
      {deleteCategory && (
        <ConfirmDialog
          title="删除分类"
          message={`确认删除“${deleteCategory.name}”？`}
          confirmText="删除"
          confirmVariant="danger"
          onConfirm={confirmDeleteCategory}
          onCancel={() => setDeleteCategory(null)}
        />
      )}
    </div>
  );
}

function CategoryManagementTree({
  meta,
  parentId,
  selectedId,
  expanded,
  counts,
  depth = 0,
  onToggle,
  onSelect,
}: {
  readonly meta: ItemLibraryMeta;
  readonly parentId: string | null;
  readonly selectedId: string;
  readonly expanded: ReadonlySet<string>;
  readonly counts: ReadonlyMap<string, number>;
  readonly depth?: number;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (id: string) => void;
}) {
  const children = meta.categories
    .filter((category) => category.parentId === parentId)
    .sort((left, right) => left.order - right.order);
  return children.map((category) => {
    const childCount = meta.categories.filter(
      (candidate) => candidate.parentId === category.id,
    ).length;
    const isExpanded = expanded.has(category.id);
    const selected = selectedId === category.id;
    return (
      <div
        key={category.id}
        role="treeitem"
        aria-expanded={childCount ? isExpanded : undefined}
      >
        <div
          style={{ paddingLeft: `${Math.min(depth * 16 + 4, 68)}px` }}
          className={`flex h-10 items-center gap-1 rounded-md pr-2 transition-colors ${
            selected
              ? "bg-[var(--accent-cool-subtle)] text-[var(--ink)] ring-1 ring-inset ring-[var(--accent-cool)]/30"
              : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          } ${category.archived ? "opacity-50" : ""}`}
        >
          <button
            type="button"
            onClick={() => childCount > 0 && onToggle(category.id)}
            aria-label={
              isExpanded ? `收起${category.name}` : `展开${category.name}`
            }
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${
              childCount ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onSelect(category.id)}
            aria-label={`${category.name} · ${counts.get(category.id) ?? 0} 件物品`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Folder
              className={`h-4 w-4 shrink-0 ${selected ? "text-[var(--accent-cool)]" : ""}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {category.name}
            </span>
            <span className="shrink-0 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
              {counts.get(category.id) ?? 0} 件
            </span>
          </button>
        </div>
        {childCount > 0 && isExpanded && (
          <CategoryManagementTree
            meta={meta}
            parentId={category.id}
            selectedId={selectedId}
            expanded={expanded}
            counts={counts}
            depth={depth + 1}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </div>
    );
  });
}
