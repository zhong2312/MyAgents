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
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useCloseLayer } from "@/hooks/useCloseLayer";

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
  expandable = true,
  disabled = false,
  toolbarVariant = "full",
  onExpand,
}: MarkdownVisualEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEditorValue = useRef(value);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
            <DiffSourceToggleWrapper options={["rich-text", "source"]}>
              {toolbarVariant === "narrative" ? (
                <>
                  <BlockTypeSelect />
                  <Separator />
                  <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
                  <Separator />
                  <ListsToggle options={["bullet", "number"]} />
                  <Separator />
                  <CreateLink />
                </>
              ) : (
                <>
                  <UndoRedo />
                  <Separator />
                  <BlockTypeSelect />
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
              )}
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
    [expandable, expanded, onExpand, toolbarVariant],
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
      className={`novel-markdown-shell ${expanded ? "is-expanded" : ""}`}
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
        placeholder={placeholder}
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
    </div>
  );

  return expanded
    ? createPortal(
        <div className="novel-markdown-fullscreen-overlay">{editor}</div>,
        document.body,
      )
    : editor;
}
