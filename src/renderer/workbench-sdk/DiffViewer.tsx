import {
  DiffEditor,
  loader,
  type Monaco,
  type MonacoDiffEditor,
} from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

import "monaco-editor/min/vs/editor/editor.main.css";

import { useCallback, useEffect, useRef, useState } from "react";

if (
  typeof self !== "undefined" &&
  typeof self.MonacoEnvironment?.getWorker !== "function"
) {
  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      return label === "json" ? new jsonWorker() : new editorWorker();
    },
  };
}
loader.config({ monaco });

const LIGHT_THEME = "myagents-workbench-diff-light";
const DARK_THEME = "myagents-workbench-diff-dark";

export interface DiffViewerProps {
  readonly original: string;
  readonly modified: string;
  readonly language?: string;
  readonly renderSideBySide?: boolean;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  /**
   * 提供时仅允许编辑右侧候选内容，并在每次修改后回传最新文本。
   * 左侧基线始终只读，避免比较基准被误改。
   */
  readonly onModifiedChange?: (value: string) => void;
  readonly className?: string;
}

function defineThemes(monacoInstance: Monaco): void {
  monacoInstance.editor.defineTheme(LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fbfaf8",
      "editorGutter.background": "#f4f2ee",
      "diffEditor.insertedTextBackground": "#b8e3c766",
      "diffEditor.removedTextBackground": "#efb8b866",
      "diffEditor.insertedLineBackground": "#dcefe366",
      "diffEditor.removedLineBackground": "#f6dede66",
      "diffEditor.diagonalFill": "#dedbd5",
    },
  });
  monacoInstance.editor.defineTheme(DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#17191c",
      "editorGutter.background": "#1d2024",
      "diffEditor.insertedTextBackground": "#245c3d88",
      "diffEditor.removedTextBackground": "#71363688",
      "diffEditor.insertedLineBackground": "#1f483455",
      "diffEditor.removedLineBackground": "#572d2d55",
      "diffEditor.diagonalFill": "#33373d",
    },
  });
}

export default function DiffViewer({
  original,
  modified,
  language = "plaintext",
  renderSideBySide = true,
  fontSize = 14,
  lineHeight = 0,
  onModifiedChange,
  className = "",
}: DiffViewerProps) {
  const editorRef = useRef<MonacoDiffEditor | null>(null);
  const modelsRef = useRef<ReturnType<MonacoDiffEditor["getModel"]>>(null);
  const onModifiedChangeRef = useRef(onModifiedChange);
  const modifiedContentListenerRef = useRef<monaco.IDisposable | null>(null);
  const isModifiedEditable = Boolean(onModifiedChange);
  const [isDark, setIsDark] = useState(() =>
    typeof document === "undefined"
      ? false
      : document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const beforeMount = useCallback((monacoInstance: Monaco) => {
    defineThemes(monacoInstance);
  }, []);
  useEffect(() => {
    onModifiedChangeRef.current = onModifiedChange;
  }, [onModifiedChange]);

  const handleMount = useCallback((editor: MonacoDiffEditor) => {
    editorRef.current = editor;
    modelsRef.current = editor.getModel();
    modifiedContentListenerRef.current?.dispose();
    const modifiedEditor = editor.getModifiedEditor();
    modifiedContentListenerRef.current = modifiedEditor.onDidChangeModelContent(
      () => onModifiedChangeRef.current?.(modifiedEditor.getValue()),
    );
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const options = {
      renderSideBySide,
      useInlineViewWhenSpaceIsLimited: false,
      fontSize,
      lineHeight,
      readOnly: !isModifiedEditable,
      originalEditable: false,
    };
    editor.updateOptions(options);
    // DiffEditor 的顶层选项在部分 Monaco 版本不会立即刷新子编辑器。
    // 显式更新两侧，确保正文候选的阅读字号和行距即时生效。
    editor.getOriginalEditor().updateOptions({ fontSize, lineHeight });
    editor.getModifiedEditor().updateOptions({ fontSize, lineHeight });
  }, [fontSize, isModifiedEditable, lineHeight, renderSideBySide]);

  useEffect(
    () => () => {
      editorRef.current = null;
      modifiedContentListenerRef.current?.dispose();
      modifiedContentListenerRef.current = null;
      const models = modelsRef.current;
      modelsRef.current = null;
      if (!models) return;
      // @monaco-editor/react otherwise disposes models before the diff widget
      // clears them. Let the child unmount first, then release our kept models.
      window.setTimeout(() => {
        if (!models.original.isDisposed()) models.original.dispose();
        if (!models.modified.isDisposed()) models.modified.dispose();
      }, 0);
    },
    [],
  );

  return (
    <div
      className={`relative h-full min-h-0 overflow-hidden bg-[var(--paper)] ${className}`}
      data-diff-engine="monaco-editor"
    >
      <DiffEditor
        height="100%"
        original={original}
        modified={modified}
        language={language}
        theme={isDark ? DARK_THEME : LIGHT_THEME}
        beforeMount={beforeMount}
        onMount={handleMount}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        loading={
          <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--ink-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在载入差异
          </div>
        }
        options={{
          readOnly: !isModifiedEditable,
          originalEditable: false,
          renderSideBySide,
          useInlineViewWhenSpaceIsLimited: false,
          enableSplitViewResizing: true,
          automaticLayout: true,
          minimap: { enabled: false },
          folding: false,
          glyphMargin: false,
          lineNumbersMinChars: 3,
          renderOverviewRuler: false,
          overviewRulerLanes: 0,
          fontSize,
          lineHeight,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          diffWordWrap: "on",
          ignoreTrimWhitespace: false,
          renderMarginRevertIcon: false,
          contextmenu: false,
          unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: true,
            includeComments: false,
            includeStrings: false,
          },
          hideUnchangedRegions: {
            enabled: true,
            contextLineCount: 3,
            minimumLineCount: 8,
            revealLineCount: 12,
          },
        }}
      />
    </div>
  );
}
