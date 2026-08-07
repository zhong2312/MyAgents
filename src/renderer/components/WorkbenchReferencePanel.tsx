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
  readonly workspacePath?: string;
  readonly currentSessionId?: string | null;
  readonly onSelectSession?: (sessionId: string) => void;
}

type Reference = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly count: number;
  readonly content?: string;
};

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]);

function pathLabel(value: string, workspacePath?: string): string {
  const normalized = value.replaceAll("\\", "/");
  const workspace = workspacePath?.replaceAll("\\", "/").replace(/\/$/, "");
  if (workspace && normalized.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)) {
    return normalized.slice(workspace.length + 1);
  }
  return normalized;
}

function collectToolReferences(blocks: readonly ContentBlock[], workspacePath?: string): string[] {
  const paths: string[] = [];
  for (const block of blocks) {
    const tool = block.tool;
    if (!tool || !FILE_TOOLS.has(tool.name)) continue;
    const input = (tool.parsedInput ?? tool.input) as Record<string, unknown>;
    for (const key of ["file_path", "notebook_path", "path"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) paths.push(pathLabel(value.trim(), workspacePath));
    }
  }
  return paths;
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
        <span className="ml-auto tabular-nums text-[var(--ink-subtle)]">{items.length}</span>
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
                  aria-label={`查看完整提示词：${item.label}`}
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
      <div className="truncate text-xs font-medium text-[var(--ink)]" title={item.label}>
        {item.label}
      </div>
      {item.detail && (
        <div className="mt-0.5 truncate text-xs text-[var(--ink-subtle)]" title={item.detail}>
          {item.detail}
        </div>
      )}
      {item.count > 1 && <div className="mt-1 text-xs text-[var(--ink-subtle)]">引用 {item.count} 次</div>}
    </>
  );
}

function PromptPreviewDialog({ prompt, onClose }: { readonly prompt: Reference; readonly onClose: () => void }) {
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
        aria-labelledby="workbench-prompt-preview-title"
        className="flex max-h-[min(760px,calc(100vh-48px))] w-[min(760px,100%)] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
          <div className="min-w-0">
            <h2 id="workbench-prompt-preview-title" className="truncate text-sm font-semibold text-[var(--ink)]">
              {prompt.label}
            </h2>
            {prompt.detail && <p className="truncate text-xs text-[var(--ink-subtle)]">{prompt.detail}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭提示词预览"
            title="关闭提示词预览"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--ink)]">
            {prompt.content?.trim() || "当前会话未提供完整提示词内容。"}
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
  workspacePath,
  currentSessionId,
  onSelectSession,
}: WorkbenchReferencePanelProps) {
  const { prompts, files } = useMemo(() => {
    const promptItems: Reference[] = promptId || promptTitle
      ? [{ id: promptId ?? promptTitle ?? "workbench-prompt", label: promptTitle ?? promptId ?? "工作台提示词", detail: promptId, content: promptContent, count: 1 }]
      : [];
    const counts = new Map<string, { label: string; detail?: string; count: number }>();
    const addFile = (value: string, detail?: string) => {
      const key = value.toLowerCase();
      const current = counts.get(key);
      counts.set(key, current ? { ...current, count: current.count + 1 } : { label: value, detail, count: 1 });
    };
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        const value = pathLabel(attachment.relativePath ?? attachment.savedPath ?? attachment.name, workspacePath);
        addFile(value, attachment.mimeType);
      }
      if (Array.isArray(message.content)) {
        for (const value of collectToolReferences(message.content, workspacePath)) addFile(value);
      }
    }
    return {
      prompts: promptItems,
      files: [...counts.entries()].map(([id, value]) => ({ id, ...value })),
    };
  }, [messages, promptContent, promptId, promptTitle, workspacePath]);

  const [selectedPrompt, setSelectedPrompt] = useState<Reference | null>(null);

  return (
    <aside aria-label="小说对话与引用资料" className="flex h-full min-h-0 w-[min(300px,32%)] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--paper-elevated)]">
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
          <strong className="text-sm font-semibold text-[var(--ink)]">引用资料</strong>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ReferenceSection title="提示词" icon={<Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />} empty="本会话尚未绑定提示词" items={prompts} onItemClick={setSelectedPrompt} />
          <ReferenceSection title="资料与文件" icon={<FileText className="h-3.5 w-3.5 text-[var(--accent-cool)]" />} empty="AI 读取资料后会显示在这里" items={files} />
        </div>
      </section>
      {selectedPrompt && <PromptPreviewDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} />}
    </aside>
  );
}
