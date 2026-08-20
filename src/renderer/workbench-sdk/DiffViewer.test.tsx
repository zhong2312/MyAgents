import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CapturedDiffEditorProps = {
  readonly beforeMount?: (monaco: unknown) => void;
  readonly onMount?: (editor: unknown) => void;
  readonly options?: {
    readonly fontSize?: number;
    readonly lineHeight?: number;
    readonly originalEditable?: boolean;
    readonly readOnly?: boolean;
  };
};

const diffEditorMock = vi.hoisted(() => {
  let modifiedValue = "候选初稿";
  let modifiedContentListener: (() => void) | null = null;
  let capturedProps: CapturedDiffEditorProps | null = null;
  const originalEditor = { updateOptions: vi.fn() };
  const modifiedEditor = {
    getValue: () => modifiedValue,
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      modifiedContentListener = listener;
      return { dispose: vi.fn() };
    }),
    updateOptions: vi.fn(),
  };
  const editor = {
    getModel: vi.fn(() => ({
      original: { dispose: vi.fn(), isDisposed: () => false },
      modified: { dispose: vi.fn(), isDisposed: () => false },
    })),
    getModifiedEditor: vi.fn(() => modifiedEditor),
    getOriginalEditor: vi.fn(() => originalEditor),
    updateOptions: vi.fn(),
  };

  return {
    editor,
    getCapturedProps: () => capturedProps,
    reset() {
      modifiedValue = "候选初稿";
      modifiedContentListener = null;
      capturedProps = null;
      originalEditor.updateOptions.mockClear();
      modifiedEditor.onDidChangeModelContent.mockClear();
      modifiedEditor.updateOptions.mockClear();
      editor.getModel.mockClear();
      editor.getModifiedEditor.mockClear();
      editor.getOriginalEditor.mockClear();
      editor.updateOptions.mockClear();
    },
    setCapturedProps(props: CapturedDiffEditorProps) {
      capturedProps = props;
    },
    triggerModifiedChange(value: string) {
      modifiedValue = value;
      modifiedContentListener?.();
    },
  };
});

vi.mock("monaco-editor", () => ({
  editor: { defineTheme: vi.fn() },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class EditorWorker {},
}));

vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class JsonWorker {},
}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  return {
    DiffEditor: (props: CapturedDiffEditorProps) => {
      diffEditorMock.setCapturedProps(props);
      React.useEffect(() => {
        props.beforeMount?.({ editor: { defineTheme: vi.fn() } });
        props.onMount?.(diffEditorMock.editor);
      }, [props]);
      return <div data-testid="monaco-diff-editor" />;
    },
    loader: { config: vi.fn() },
  };
});

import DiffViewer from "./DiffViewer";

describe("DiffViewer", () => {
  beforeEach(() => {
    diffEditorMock.reset();
  });

  it("在右侧候选可编辑时同步内容，并立即应用字号与行高", async () => {
    const onModifiedChange = vi.fn();
    render(
      <DiffViewer
        original="原文"
        modified="候选初稿"
        fontSize={18}
        lineHeight={30}
        onModifiedChange={onModifiedChange}
      />,
    );

    expect(diffEditorMock.getCapturedProps()?.options).toMatchObject({
      fontSize: 18,
      lineHeight: 30,
      originalEditable: false,
      readOnly: false,
    });
    await waitFor(() => {
      expect(diffEditorMock.editor.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ fontSize: 18, lineHeight: 30 }),
      );
      expect(
        diffEditorMock.editor.getModifiedEditor().updateOptions,
      ).toHaveBeenCalledWith({
        fontSize: 18,
        lineHeight: 30,
      });
    });

    diffEditorMock.triggerModifiedChange("人工修改后的候选");
    expect(onModifiedChange).toHaveBeenCalledWith("人工修改后的候选");
  });
});
