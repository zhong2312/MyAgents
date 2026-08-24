import { FileText, ListChecks, Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Message, ContentBlock } from "@/types/chat";
import WorkspaceSessionHistory from "@/components/directory-panel/WorkspaceSessionHistory";

interface WorkbenchReferencePanelProps {
  readonly promptId?: string;
  readonly promptTitle?: string;
  readonly promptContent?: string;
  readonly messages: readonly Message[];
  readonly streamingMessage?: Message | null;
  readonly workspacePath?: string;
  readonly currentSessionId?: string | null;
  readonly onSelectSession?: (sessionId: string, title: string) => void;
}

type Reference = {
  readonly id: string;
  readonly kind: "prompt" | "content";
  readonly label: string;
  readonly detail?: string;
  readonly count: number;
  readonly content?: string;
};

const FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
]);
const NOVEL_WORKBENCH_TOOL_PREFIX = "mcp__novel-workbench__";

type ReferenceSeed = Omit<Reference, "count">;
type JsonRecord = Record<string, unknown>;

function pathLabel(value: string, workspacePath?: string): string {
  const normalized = value.replaceAll("\\", "/");
  const workspace = workspacePath?.replaceAll("\\", "/").replace(/\/$/, "");
  if (
    workspace &&
    normalized.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)
  ) {
    return normalized.slice(workspace.length + 1);
  }
  return normalized;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseJson(value: string | undefined): unknown {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function looksLikeFailedFileRead(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:file does not exist|no such file|cannot find the file|enoent)/iu.test(
    value,
  );
}

function toolLabel(toolName: string): string {
  const action = toolName.startsWith(NOVEL_WORKBENCH_TOOL_PREFIX)
    ? toolName.slice(NOVEL_WORKBENCH_TOOL_PREFIX.length)
    : toolName;
  return action.replaceAll("_", " ");
}

function contentReference(
  id: string,
  label: string,
  detail?: string,
  content?: string,
): ReferenceSeed {
  return { id, kind: "content", label, detail, content };
}

function collectFileToolReferences(
  tool: NonNullable<ContentBlock["tool"]>,
  workspacePath?: string,
): ReferenceSeed[] {
  if (
    !FILE_TOOLS.has(tool.name) ||
    tool.isError ||
    tool.isFailed ||
    looksLikeFailedFileRead(tool.result)
  ) {
    return [];
  }
  const input = asRecord(tool.parsedInput ?? tool.input) ?? {};
  const references: ReferenceSeed[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const label = pathLabel(value.trim(), workspacePath);
    references.push(
      contentReference(
        `source:${label.toLowerCase()}`,
        label,
        tool.name,
        tool.result,
      ),
    );
  }
  return references;
}

function collectNovelWorkbenchReferences(
  tool: NonNullable<ContentBlock["tool"]>,
  workspacePath?: string,
): ReferenceSeed[] {
  if (!tool.name.startsWith(NOVEL_WORKBENCH_TOOL_PREFIX)) return [];
  const input = asRecord(tool.parsedInput ?? tool.input) ?? {};
  const result = asRecord(parseJson(tool.result));
  if (tool.isError || result?.error) return [];
  const action = toolLabel(tool.name);
  const references: ReferenceSeed[] = [];
  const addPath = (value: unknown, content?: unknown, detail = action) => {
    if (typeof value !== "string" || !value.trim()) return;
    const label = pathLabel(value.trim(), workspacePath);
    references.push(
      contentReference(
        `source:${label.toLowerCase()}`,
        label,
        detail,
        formatContent(content ?? result),
      ),
    );
  };

  const files = asRecord(result?.files);
  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      addPath(filePath, content);
    }
  }
  for (const key of ["sourcePath", "trackingPath", "continuityPath"]) {
    addPath(result?.[key]);
  }
  if (!files && Array.isArray(input.paths)) {
    for (const requestedPath of input.paths) {
      addPath(requestedPath, files?.[String(requestedPath)]);
    }
  }

  const inputIds = [
    "focusId",
    "systemId",
    "categoryId",
    "characterId",
    "factionId",
    "chapterId",
    "eventId",
    "periodId",
    "branchId",
  ].flatMap((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
  if (Array.isArray(input.ids)) {
    inputIds.push(
      ...input.ids.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    );
  }
  if (references.length === 0) {
    for (const id of inputIds) {
      references.push(
        contentReference(
          `novel-id:${tool.name}:${id}`,
          id,
          action,
          formatContent(result ?? tool.result),
        ),
      );
    }
  } else if (inputIds.length > 0) {
    const idSummary = [...new Set(inputIds)].join(", ");
    references[0] = {
      ...references[0],
      detail: `${references[0].detail ?? action} · ID: ${idSummary}`,
    };
  }
  if (references.length === 0 && /(?:^|_)get(?:_|$)/.test(action)) {
    references.push(
      contentReference(
        `novel-tool:${tool.id}`,
        action,
        `工具读取结果 · ${tool.id}`,
        formatContent(result ?? tool.result),
      ),
    );
  }
  return references;
}

function collectToolReferences(
  blocks: readonly ContentBlock[],
  workspacePath?: string,
): ReferenceSeed[] {
  const references: ReferenceSeed[] = [];
  for (const block of blocks) {
    const tool = block.tool;
    if (!tool) continue;
    references.push(...collectNovelWorkbenchReferences(tool, workspacePath));
    references.push(...collectFileToolReferences(tool, workspacePath));
  }
  return references;
}

function ReferenceSection({
  title,
  icon,
  empty,
  items,
  onItemClick,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly empty: string;
  readonly items: readonly Reference[];
  readonly onItemClick?: (item: Reference) => void;
}) {
  return (
    <section className="border-b border-[var(--line-subtle)] px-3 py-3 last:border-b-0">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
        {icon}
        <span>{title}</span>
        <span className="ml-auto tabular-nums text-[var(--ink-subtle)]">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs leading-5 text-[var(--ink-subtle)]">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="min-w-0">
              {onItemClick ? (
                <button
                  type="button"
                  onClick={() => onItemClick(item)}
                  aria-label={`${item.kind === "prompt" ? "查看完整提示词" : "查看资料详情"}：${item.label}`}
                  className="block w-full rounded-md bg-[var(--paper-inset)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                >
                  <ReferenceItemBody item={item} />
                </button>
              ) : (
                <div className="rounded-md bg-[var(--paper-inset)] px-2.5 py-2">
                  <ReferenceItemBody item={item} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReferenceItemBody({ item }: { readonly item: Reference }) {
  return (
    <>
      <div
        className="truncate text-xs font-medium text-[var(--ink)]"
        title={item.label}
      >
        {item.label}
      </div>
      {item.detail && (
        <div
          className="mt-0.5 truncate text-xs text-[var(--ink-subtle)]"
          title={item.detail}
        >
          {item.detail}
        </div>
      )}
      {item.count > 1 && (
        <div className="mt-1 text-xs text-[var(--ink-subtle)]">
          引用 {item.count} 次
        </div>
      )}
    </>
  );
}

function ReferencePreviewDialog({
  reference,
  onClose,
}: {
  readonly reference: Reference;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 px-4 py-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workbench-reference-preview-title"
        className="flex max-h-[min(760px,calc(100vh-48px))] w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
          <div className="min-w-0">
            <h2
              id="workbench-reference-preview-title"
              className="truncate text-sm font-semibold text-[var(--ink)]"
            >
              {reference.label}
            </h2>
            {reference.detail && (
              <p className="truncate text-xs text-[var(--ink-subtle)]">
                {reference.detail}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭资料详情"
            title="关闭资料详情"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--ink)]">
            {reference.content?.trim() ||
              (reference.kind === "prompt"
                ? "当前会话未提供完整提示词内容。"
                : "当前会话未提供完整资料内容。")}
          </pre>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function WorkbenchReferencePanel({
  promptId,
  promptTitle,
  promptContent,
  messages,
  streamingMessage,
  workspacePath,
  currentSessionId,
  onSelectSession,
}: WorkbenchReferencePanelProps) {
  const { prompts, files } = useMemo(() => {
    const promptItems: Reference[] =
      promptId || promptTitle
        ? [
            {
              kind: "prompt",
              id: promptId ?? promptTitle ?? "workbench-prompt",
              label: promptTitle ?? promptId ?? "工作台提示词",
              detail: promptId,
              content: promptContent,
              count: 1,
            },
          ]
        : [];
    const counts = new Map<string, Reference>();
    const addReference = (reference: ReferenceSeed) => {
      const key = reference.id.toLowerCase();
      const current = counts.get(key);
      counts.set(
        key,
        current
          ? {
              ...current,
              count: current.count + 1,
              content: current.content ?? reference.content,
            }
          : { ...reference, count: 1 },
      );
    };
    const visibleMessages =
      streamingMessage &&
      !messages.some((message) => message.id === streamingMessage.id)
        ? [...messages, streamingMessage]
        : messages;
    for (const message of visibleMessages) {
      for (const attachment of message.attachments ?? []) {
        const value = pathLabel(
          attachment.relativePath ?? attachment.savedPath ?? attachment.name,
          workspacePath,
        );
        addReference(
          contentReference(
            `source:${value.toLowerCase()}`,
            value,
            attachment.mimeType,
          ),
        );
      }
      if (Array.isArray(message.content)) {
        for (const reference of collectToolReferences(
          message.content,
          workspacePath,
        ))
          addReference(reference);
      }
    }
    return {
      prompts: promptItems,
      files: [...counts.values()],
    };
  }, [
    messages,
    promptContent,
    promptId,
    promptTitle,
    streamingMessage,
    workspacePath,
  ]);

  const [selectedReference, setSelectedReference] = useState<Reference | null>(
    null,
  );

  return (
    <aside
      aria-label="小说对话与引用资料"
      className="flex h-full min-h-0 w-[min(300px,32%)] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--paper-elevated)]"
    >
      {workspacePath && (
        <WorkspaceSessionHistory
          agentDir={workspacePath}
          currentSessionId={currentSessionId}
          onSelectSession={onSelectSession}
          defaultExpanded={false}
        />
      )}
      <section className="flex min-h-0 flex-1 flex-col border-t border-[var(--line)]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-3">
          <ListChecks className="h-4 w-4 text-[var(--accent-cool)]" />
          <strong className="text-sm font-semibold text-[var(--ink)]">
            引用资料
          </strong>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReferenceSection
            title="提示词"
            icon={
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
            }
            empty="本会话尚未绑定提示词"
            items={prompts}
            onItemClick={setSelectedReference}
          />
          <ReferenceSection
            title="资料与文件"
            icon={
              <FileText className="h-3.5 w-3.5 text-[var(--accent-cool)]" />
            }
            empty="AI 读取资料后会显示在这里"
            items={files}
            onItemClick={setSelectedReference}
          />
        </div>
      </section>
      {selectedReference && (
        <ReferencePreviewDialog
          reference={selectedReference}
          onClose={() => setSelectedReference(null)}
        />
      )}
    </aside>
  );
}
