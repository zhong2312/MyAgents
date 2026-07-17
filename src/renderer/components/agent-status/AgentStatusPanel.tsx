// PRD 0.2.17 — Agent Status Panel
//
// Top-level 容器：组合 useAgentStatusState 派生 + 收起态长条 + 展开态 sections。
// 自带可见性生命周期（首次淡入、归零延迟 1.5s 淡出，再触发立即淡入）。

import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Message } from '@/types/chat';

import { useTabStateOptional } from '@/context/TabContext';

import { SubagentRunningIcon } from './icons';
import SubagentSection from './SubagentSection';
import TodoSection from './TodoSection';
import { useAgentStatusState } from './useAgentStatusState';

// 全部 completed 时先驻留 500ms 让用户看到「全完成」瞬间，再开始 fade。
// 总从「内容归零」到「DOM 卸载」≈ 500 (linger) + 200 (opacity transition) + 800 (extra delay before unmount)。
const FADE_LINGER_MS = 500;
const FADE_OUT_DELAY_MS = 1500;

interface AgentStatusPanelProps {
  /** Chat 内容区的 ref，限定 querySelector 作用域（防多 Tab 同 Session DOM 冲突） */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Chat 提供：ChatScrollController message jump + 二阶段 highlight。SubagentRow 透传调用。 */
  onJumpToTool: (toolId: string) => void;
}

/** Stable empty fallback if ever rendered outside a TabProvider (in practice
 *  only Chat mounts this, always inside one). */
const EMPTY_MESSAGES: Message[] = [];

const AgentStatusPanel = memo(function AgentStatusPanel({ containerRef, onJumpToTool }: AgentStatusPanelProps) {
  // P3: self-subscribe to messages instead of receiving them as a prop. This
  // removes the [messages] dependency from Chat's `agentStatusSlot` useMemo, so
  // the slot element identity stays STABLE during streaming → SimpleChatInput's
  // React.memo holds and the input no longer re-renders on every streamed token.
  // This panel still re-renders per commit via the context subscription; its
  // derived DOM only changes when todos/subagents do (cost absorbed by React).
  const tab = useTabStateOptional();
  const messages = tab?.messages ?? EMPTY_MESSAGES;
  const state = useAgentStatusState(messages, tab?.agentPlanTodos ?? null, tab?.sessionId ?? null);
  // hasContent：todos 全部 completed 时视为「已结束」→ 进入 fade-out
  // （对齐 PRD §8.1 #6 验收：「5/5 ☑ 后 1.5s 整段淡出」）
  const todosActive = state.todos.length > 0 && state.todos.some(t => t.status !== 'completed');
  const hasContent = todosActive || state.subagents.length > 0;

  // 可见性状态机：内容出现 → 立即 setMounted(true) + setOpacity(1)
  // 内容归零 → 立即 setOpacity(0)，1.5s 后 setMounted(false)（卸载 DOM 释放内存）
  // 归零 1.5s 内若内容再次出现 → 取消淡出，setOpacity(1)
  const [mounted, setMounted] = useState(false);
  const [opaque, setOpaque] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 跨 rAF 边界跟踪第二层 rAF id，避免 toggle 过快时 stale setOpaque 漏过 cleanup（Codex Adv 1）。
  const raf2Ref = useRef<number | undefined>(undefined);

  // 第二段定时器，用于「lingerTimer = 500ms 全可见驻留 → 然后才开始 fade」（I1）
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (hasContent) {
      // 取消任何待执行的 fade-out + linger 计时器
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = undefined;
      }
      if (lingerTimerRef.current) {
        clearTimeout(lingerTimerRef.current);
        lingerTimerRef.current = undefined;
      }
      // 用 rAF 包装 setState，规避 react-hooks/set-state-in-effect lint。
      // 第一帧 mount（opacity 仍是 0），第二帧设 opaque=true 触发 200ms 淡入。
      const raf1 = requestAnimationFrame(() => {
        setMounted(true);
        raf2Ref.current = requestAnimationFrame(() => {
          setOpaque(true);
          raf2Ref.current = undefined;
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2Ref.current !== undefined) {
          cancelAnimationFrame(raf2Ref.current);
          raf2Ref.current = undefined;
        }
      };
    }
    // hasContent just turned false。如果当前还没 mounted，无需安排任何动作
    // （避免 Codex Adv 3：首次渲染就 hasContent=false 时仍调度无意义 1.5s 定时器）
    if (!mounted) return;
    // I1: 先 linger 500ms 让用户看到「全完成」瞬间（opacity 仍是 1），
    //     再触发 opacity 0 过渡 + 1.5s 后从 DOM 卸载。
    lingerTimerRef.current = setTimeout(() => {
      lingerTimerRef.current = undefined;
      setOpaque(false);
      fadeTimerRef.current = setTimeout(() => {
        setMounted(false);
        fadeTimerRef.current = undefined;
      }, FADE_OUT_DELAY_MS);
    }, FADE_LINGER_MS);
    return () => {
      if (lingerTimerRef.current) {
        clearTimeout(lingerTimerRef.current);
        lingerTimerRef.current = undefined;
      }
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = undefined;
      }
    };
  }, [hasContent, mounted]);

  // 展开/收起状态（Tab 生命周期内保持；不持久化）
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(v => !v), []);

  if (!mounted) return null;

  return (
    // 卡片级 DOM——定位/居中/右边界对齐由父级 SimpleChatInput 内的「panel 行」
    // 负责。和 QueuedMessagesPanel 同居一个 `flex items-end justify-end gap-2`
    // 行：当 queue 同时存在时 `[&:not(:only-child)]:mr-auto` 把 Todo 推到左侧，
    // queue 自然落到右侧；只剩 Todo 时 `:only-child` 触发，无 mr-auto，
    // justify-end 把它保持在右边。这样原来 `bottom-[8rem]` 的硬编码偏移和与
    // queue 的 z-20 撞车都被布局消化了，输入框高度变化（图片附件、textarea
    // 长大、cron status bar）也不再让 Todo 偏离 queue。
    <div
      aria-hidden={!hasContent}
      className={`flex w-[260px] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 shadow-lg backdrop-blur-md transition-opacity duration-200 [&:not(:only-child)]:mr-auto ${
        opaque ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {/* 展开态：上面 sections，下面 bar；收起态：仅 bar */}
      {expanded && (
        <div className="flex flex-col">
          <TodoSection todos={state.todos} />
          <SubagentSection subagents={state.subagents} containerRef={containerRef} onJumpToTool={onJumpToTool} />
        </div>
      )}
      <AgentStatusBar
        summary={state.summary}
        expanded={expanded}
        onToggle={toggle}
      />
    </div>
  );
});

export default AgentStatusPanel;

interface AgentStatusBarProps {
  summary: import('./types').AgentStatusSummary;
  expanded: boolean;
  onToggle: () => void;
}

// V3 收起态文案（用户拍板）：「Todo 0/4   Agents 3 ·」，· 是脉冲绿点。
// 不显示 icon prefix、不显示 elapsed 时间数字、不区分 sync/bg 计数——
// 信息密度刚好够「瞥一眼知有几件事」，详情留给展开态。
const AgentStatusBar = memo(function AgentStatusBar({ summary, expanded, onToggle }: AgentStatusBarProps) {
  const { t } = useTranslation('app');
  const hasTodos = summary.todoTotal > 0;
  const hasSubagents = summary.subagentRunning > 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? t('agentStatus.collapse') : t('agentStatus.expand')}
      className={`flex items-center gap-4 px-3 py-2 text-xs text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]/40 ${
        expanded ? 'border-t border-[var(--line-subtle)]' : ''
      }`}
    >
      {hasTodos && (
        <span className="tabular-nums">
          Todo {summary.todoCompleted}/{summary.todoTotal}
        </span>
      )}

      {hasSubagents && (
        <span className="flex items-center gap-1.5 tabular-nums">
          Agents {summary.subagentRunning}
          <SubagentRunningIcon />
        </span>
      )}

      <span className="ml-auto text-[var(--ink-muted)]">
        {expanded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </span>
    </button>
  );
});
