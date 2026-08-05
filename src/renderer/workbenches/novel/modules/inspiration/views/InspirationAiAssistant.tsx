import {
  ChevronDown,
  Lightbulb,
  MessagesSquare,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { CompactAiRunWindow } from "@/workbench-sdk";

import {
  createInspirationAiAgentRequest,
  createInspirationAiRunRequest,
  type InspirationAiAgentRequest,
  type InspirationAiContext,
  type InspirationAiRunMode,
  type InspirationAiRunRequest,
} from "../business/inspirationAi";

interface InspirationAiAssistantProps {
  readonly context: InspirationAiContext;
  readonly onRun?: (request: InspirationAiRunRequest) => Promise<string>;
  readonly onOpenAgent?: (request: InspirationAiAgentRequest) => Promise<void>;
}

interface ActiveRun {
  readonly mode: InspirationAiRunMode;
  readonly label: string;
  readonly status: "running" | "ready" | "error";
  readonly output?: string;
  readonly error?: string;
}

const RUN_ACTIONS = [
  {
    id: "diagnose" as const,
    label: "诊断当前灵感",
    description: "检查清晰度、重复和待补问题",
    icon: ScanSearch,
  },
  {
    id: "develop" as const,
    label: "展开三个方向",
    description: "把当前火花发展成可继续思考的方向",
    icon: Lightbulb,
  },
] as const;

export default function InspirationAiAssistant({
  context,
  onRun,
  onOpenAgent,
}: InspirationAiAssistantProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const runTokenRef = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [agentOpening, setAgentOpening] = useState(false);
  const available = Boolean(onRun || onOpenAgent);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const run = async (mode: InspirationAiRunMode) => {
    if (!onRun) return;
    const request = createInspirationAiRunRequest(mode, context);
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    setMenuOpen(false);
    setActiveRun({ mode, label: request.label, status: "running" });
    try {
      const output = await onRun(request);
      if (runTokenRef.current !== token) return;
      setActiveRun({ mode, label: request.label, status: "ready", output });
    } catch (error) {
      if (runTokenRef.current !== token) return;
      setActiveRun({
        mode,
        label: request.label,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openAgent = async (seedOutput?: string) => {
    if (!onOpenAgent || agentOpening) return;
    setMenuOpen(false);
    setAgentOpening(true);
    try {
      await onOpenAgent(createInspirationAiAgentRequest(context, seedOutput));
    } catch (error) {
      setActiveRun({
        mode: "diagnose",
        label: `灵感共创 · ${context.focusLabel}`,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAgentOpening(false);
    }
  };

  const closeRun = () => {
    runTokenRef.current += 1;
    setActiveRun(null);
  };

  return (
    <>
      <div className="relative" ref={rootRef}>
        <button
          type="button"
          className="ns-button"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          disabled={!available || agentOpening}
          title={available ? "打开灵感 AI 功能" : "当前环境不可使用 AI"}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <Sparkles className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
          {agentOpening ? "正在打开" : "AI"}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div
            id={menuId}
            role="menu"
            className="absolute left-1/2 top-full z-50 mt-1 w-72 max-w-[calc(100vw-24px)] -translate-x-1/2 overflow-hidden rounded-md border border-[var(--line-strong)] bg-[var(--paper-elevated)] py-1 shadow-lg"
          >
            <div className="border-b border-[var(--line)] px-3 py-2">
              <span className="block text-xs text-[var(--ink-muted)]">当前处理</span>
              <strong className="mt-0.5 block truncate text-sm font-medium">
                {context.focusLabel}
              </strong>
            </div>
            {RUN_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  disabled={!onRun}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-[var(--hover-bg)] disabled:opacity-45"
                  onClick={() => void run(action.id)}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-warm)]" />
                  <span className="min-w-0">
                    <strong className="block text-sm font-medium">{action.label}</strong>
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
                      {action.description}
                    </span>
                  </span>
                </button>
              );
            })}
            <div className="my-1 border-t border-[var(--line)]" />
            <button
              type="button"
              role="menuitem"
              disabled={!onOpenAgent}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-[var(--hover-bg)] disabled:opacity-45"
              onClick={() => void openAgent()}
            >
              <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
              <span className="min-w-0">
                <strong className="block text-sm font-medium">深度共创</strong>
                <span className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
                  带当前灵感上下文打开完整 MyAgents 会话
                </span>
              </span>
            </button>
          </div>
        )}
      </div>
      {activeRun && (
        <CompactAiRunWindow
          label={activeRun.label}
          status={activeRun.status}
          output={activeRun.output}
          error={activeRun.error}
          onRetry={() => void run(activeRun.mode)}
          onExpand={
            onOpenAgent && activeRun.status === "ready"
              ? () => void openAgent(activeRun.output)
              : undefined
          }
          onClose={closeRun}
        />
      )}
    </>
  );
}
