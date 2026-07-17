import "@mdxeditor/editor/style.css";
import "./MarkdownVisualEditor.css";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertTable,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
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
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface MarkdownVisualEditorProps {
  readonly pageId: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly placeholder?: string;
  readonly fullWidth?: boolean;
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
}: MarkdownVisualEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEditorValue = useRef(value);
  const [editorError, setEditorError] = useState<string | null>(null);
  const plugins = useMemo(
    () => [
      headingsPlugin(),
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
          <DiffSourceToggleWrapper options={["rich-text", "source"]}>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <Separator />
            <BoldItalicUnderlineToggles />
            <Separator />
            <ListsToggle options={["bullet", "number", "check"]} />
            <Separator />
            <CreateLink />
            <InsertTable />
          </DiffSourceToggleWrapper>
        ),
      }),
    ],
    [],
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

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col"
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
}
