import "@mdxeditor/editor/style.css";
import "./MarkdownVisualEditor.css";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertTable,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import { AlertTriangle, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  CustomSelect,
  type SelectOption,
  useCloseLayer,
} from "@/workbench-sdk";

interface MarkdownVisualEditorProps {
  readonly pageId: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly placeholder?: string;
  readonly fullWidth?: boolean;
  readonly expandable?: boolean;
  readonly disabled?: boolean;
  readonly toolbarVariant?: "full" | "narrative";
  readonly onExpand?: () => void;
  readonly className?: string;
  readonly footer?: React.ReactNode;
}

type MarkdownLineSpacing = "compact" | "standard" | "relaxed";

const MARKDOWN_LINE_SPACING_STORAGE_KEY =
  "myagents.novel.markdown-line-spacing";

const MARKDOWN_LINE_SPACING_OPTIONS: SelectOption[] = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
  { value: "relaxed", label: "宽松" },
];

function readMarkdownLineSpacing(): MarkdownLineSpacing {
  if (typeof window === "undefined") return "compact";
  try {
    const stored = window.localStorage.getItem(
      MARKDOWN_LINE_SPACING_STORAGE_KEY,
    );
    if (stored === "compact" || stored === "standard" || stored === "relaxed") {
      return stored;
    }
  } catch {
    // Local storage may be unavailable in restricted web views.
  }
  return "compact";
}

const EDITOR_TRANSLATIONS: Readonly<Record<string, string>> = {
  "toolbar.blockTypeSelect.selectBlockTypeTooltip": "段落与标题",
  "toolbar.blockTypeSelect.placeholder": "段落类型",
  "toolbar.blockTypes.paragraph": "正文",
  "toolbar.blockTypes.quote": "引用",
  "toolbar.blockTypes.heading": "标题 {{level}}",
  "toolbar.bold": "加粗",
  "toolbar.italic": "斜体",
  "toolbar.underline": "下划线",
  "toolbar.bulletedList": "无序列表",
  "toolbar.numberedList": "有序列表",
  "toolbar.checkList": "任务列表",
  "toolbar.link": "插入链接",
  "toolbar.table": "插入表格",
  "toolbar.undo": "撤销",
  "toolbar.redo": "重做",
  "toolbar.richText": "可视化",
  "toolbar.source": "源码",
  "createLink.urlPlaceholder": "输入或粘贴链接地址",
  "createLink.textTooltip": "链接在正文中显示的文字",
  "createLink.text": "链接文字",
  "createLink.titleTooltip": "鼠标悬停时显示的链接标题",
  "createLink.title": "链接标题",
  "createLink.saveTooltip": "保存链接",
  "createLink.cancelTooltip": "取消修改",
  "dialogControls.save": "保存",
  "dialogControls.cancel": "取消",
  "linkPreview.edit": "编辑链接",
  "linkPreview.copyToClipboard": "复制链接",
  "linkPreview.copied": "已复制",
  "linkPreview.remove": "移除链接",
};

function translateEditor(
  key: string,
  defaultValue: string,
  interpolations?: Record<string, unknown>,
): string {
  return Object.entries(interpolations ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    EDITOR_TRANSLATIONS[key] ?? defaultValue,
  );
}

export default function MarkdownVisualEditor({
  pageId,
  label,
  value,
  onChange,
  onSave,
  placeholder = "开始记录这个设定……",
  fullWidth = false,
  expandable = false,
  disabled = false,
  toolbarVariant = "full",
  onExpand,
  className = "",
  footer,
}: MarkdownVisualEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEditorValue = useRef(value);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasEditorFocus, setHasEditorFocus] = useState(false);
  const [lineSpacing, setLineSpacing] = useState<MarkdownLineSpacing>(
    readMarkdownLineSpacing,
  );

  const renderLineSpacingControl = useCallback(
    () => (
      <div className="novel-markdown-line-spacing-control">
        <CustomSelect
          ariaLabel="正文行距"
          className="novel-markdown-line-spacing-select"
          options={MARKDOWN_LINE_SPACING_OPTIONS}
          size="toolbar"
          value={lineSpacing}
          onChange={(nextValue) =>
            setLineSpacing(nextValue as MarkdownLineSpacing)
          }
        />
      </div>
    ),
    [lineSpacing],
  );

  const renderFormattingTools = useCallback(() => {
    if (toolbarVariant === "narrative") {
      return (
        <>
          <div className="novel-markdown-block-type-control">
            <BlockTypeSelect />
          </div>
          {renderLineSpacingControl()}
          <Separator />
          <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
          <Separator />
          <ListsToggle options={["bullet", "number"]} />
          <Separator />
          <CreateLink />
        </>
      );
    }

    return (
      <>
        <UndoRedo />
        <Separator />
        <div className="novel-markdown-block-type-control">
          <BlockTypeSelect />
        </div>
        {renderLineSpacingControl()}
        <Separator />
        <BoldItalicUnderlineToggles />
        <Separator />
        <CodeToggle />
        <Separator />
        <ListsToggle options={["bullet", "number", "check"]} />
        <Separator />
        <CreateLink />
        <InsertTable />
      </>
    );
  }, [renderLineSpacingControl, toolbarVariant]);

  useCloseLayer(() => {
    if (!expanded) return false;
    setExpanded(false);
    return true;
  }, 260);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MARKDOWN_LINE_SPACING_STORAGE_KEY,
        lineSpacing,
      );
    } catch {
      // Local storage may be unavailable in restricted web views.
    }
  }, [lineSpacing]);

  const plugins = useMemo(
    () => [
      headingsPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
      codeMirrorPlugin({
        codeBlockLanguages: {
          "": "纯文本",
          text: "纯文本",
          json: "JSON",
          yaml: "YAML",
          markdown: "Markdown",
          javascript: "JavaScript",
          typescript: "TypeScript",
          jsx: "JavaScript (React)",
          tsx: "TypeScript (React)",
          html: "HTML",
          css: "CSS",
          bash: "Shell",
        },
      }),
      listsPlugin(),
      quotePlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      markdownShortcutPlugin(),
      diffSourcePlugin({ viewMode: "rich-text" }),
      toolbarPlugin({
        toolbarClassName: "novel-markdown-toolbar",
        toolbarContents: () => (
          <>
            <DiffSourceToggleWrapper
              options={["rich-text", "source"]}
              SourceToolbar={
                <div
                  className="novel-markdown-source-toolbar"
                  aria-label="Markdown 源码工具栏"
                >
                  <span className="novel-markdown-source-label">源码</span>
                  <div className="novel-markdown-source-tools">
                    {renderFormattingTools()}
                  </div>
                </div>
              }
            >
              {renderFormattingTools()}
            </DiffSourceToggleWrapper>
            {expandable && (
              <button
                className="novel-markdown-expand-button"
                type="button"
                title={expanded ? "恢复编辑器" : "放大编辑器"}
                aria-label={expanded ? "恢复编辑器" : "放大编辑器"}
                aria-pressed={expanded}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (onExpand) {
                    onExpand();
                    return;
                  }
                  setExpanded((current) => !current);
                }}
              >
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </button>
            )}
          </>
        ),
      }),
    ],
    [expandable, expanded, onExpand, renderFormattingTools],
  );

  useEffect(() => {
    if (value === lastEditorValue.current) return;
    editorRef.current?.setMarkdown(value);
    lastEditorValue.current = value;
  }, [pageId, value]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const applyAccessibleNames = () => {
      root
        .querySelectorAll<HTMLElement>(
          '.novel-markdown-content[contenteditable="true"]',
        )
        .forEach((editor) => {
          editor.setAttribute("aria-label", label);
          editor.setAttribute("aria-multiline", "true");
        });
      root
        .querySelectorAll<HTMLElement>('.cm-content[contenteditable="true"]')
        .forEach((editor) => {
          editor.setAttribute("aria-label", `${label}源码`);
          editor.setAttribute("aria-multiline", "true");
        });
    };
    applyAccessibleNames();
    const observer = new MutationObserver(applyAccessibleNames);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [label, pageId]);

  const editor = (
    <div
      ref={rootRef}
      className={`novel-markdown-shell ${expanded ? "is-expanded" : ""} ${className}`}
      data-line-spacing={lineSpacing}
      onPointerDownCapture={(event) => {
        if (disabled) return;
        const target = event.target as HTMLElement;
        if (
          target.closest("button, input, select, textarea, a, [role='button']")
        ) {
          return;
        }
        requestAnimationFrame(() => {
          rootRef.current
            ?.querySelector<HTMLElement>(
              '.novel-markdown-content[contenteditable="true"]',
            )
            ?.focus();
        });
      }}
      onFocusCapture={() => setHasEditorFocus(true)}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setHasEditorFocus(false);
      }}
      onKeyDownCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          onSave();
        }
      }}
    >
      {editorError && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-[var(--error-bg)] px-4 py-2 text-xs text-[var(--error)]"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Markdown 无法解析：{editorError}
        </div>
      )}
      <MDXEditor
        key={pageId}
        ref={editorRef}
        markdown={value}
        plugins={plugins}
        trim={false}
        readOnly={disabled}
        spellCheck
        placeholder={hasEditorFocus ? "" : placeholder}
        className="novel-markdown-editor"
        contentEditableClassName={`novel-markdown-content ${
          fullWidth ? "novel-markdown-content--full" : ""
        }`}
        translation={translateEditor}
        onChange={(markdown, initialMarkdownNormalize) => {
          if (initialMarkdownNormalize) return;
          lastEditorValue.current = markdown;
          setEditorError(null);
          onChange(markdown);
        }}
        onError={({ error }) => setEditorError(error)}
      />
      {footer && (
        <div className="flex shrink-0 items-center justify-end border-t border-[var(--line-subtle)] px-4 py-2">
          {footer}
        </div>
      )}
    </div>
  );

  return expanded
    ? createPortal(
        <div className="novel-markdown-fullscreen-overlay">{editor}</div>,
        document.body,
      )
    : editor;
}
