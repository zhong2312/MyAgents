// PRD 0.2.17 — Agent Status Panel
//
// 展开态的 SUBAGENTS 区：列出活跃 subagent，sync + background 混排，background 加
// [bg] 徽标区分（PRD D10）。点击行 → 对话流滚动到对应 TaskTool 卡片并高亮（PRD D11）。
//
// 跳转交由 Chat 通过 onJumpToTool 注入：ChatScrollController message jump（解决虚拟化卸载）+
// 二阶段 querySelector 高亮，scope 在 chat container ref（解决多 Tab 同 Session DOM
// 冲突）。见 Chat.tsx::handleJumpToTool（cross-review C1/C2 修复）。

import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, OctagonX, StopCircle } from 'lucide-react';

import { SubagentRunningIcon } from './icons';
import type { SubagentStatus } from './types';
import { useElapsedSeconds } from './useElapsedSeconds';

interface SubagentSectionProps {
  subagents: SubagentStatus[];
  containerRef: React.RefObject<HTMLElement | null>;
  onJumpToTool: (toolId: string) => void;
}

interface SubagentRowProps {
  subagent: SubagentStatus;
  onJumpToTool: (toolId: string) => void;
}

function SubagentRow({ subagent, onJumpToTool }: SubagentRowProps) {
  const { t } = useTranslation('app');
  const elapsed = useElapsedSeconds(subagent.startedAt, subagent.finishedAt);

  const onClick = useCallback(() => {
    if (!subagent.id) return;
    onJumpToTool(subagent.id);
  }, [subagent.id, onJumpToTool]);

  // 单行紧凑布局：[●] agentType[后台] description(truncate)…  elapsed
  // tokens / tool count 在收起单行里省略；用户要细节就跳转到对话流里的 TaskTool 卡片看。
  // 完整 description 走 title 属性 tooltip。
  const titleParts = [
    subagent.agentType,
    subagent.mode === 'background' ? t('agentStatus.backgroundTooltip') : null,
    subagent.description,
  ].filter(Boolean);
  const tooltip = titleParts.join(' · ');

  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      className="group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--paper-inset)]/60"
    >
      {subagent.status === 'running' ? (
        <SubagentRunningIcon />
      ) : subagent.status === 'failed' ? (
        <OctagonX aria-label={t('agentStatus.failed')} className="size-3.5 shrink-0 text-[var(--error)]" />
      ) : subagent.status === 'interrupted' ? (
        <StopCircle aria-label={t('agentStatus.interrupted')} className="size-3.5 shrink-0 text-[var(--warning)]" />
      ) : (
        <CheckCircle2 aria-label={t('agentStatus.completed')} className="size-3.5 shrink-0 text-[var(--success)]" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
        <span className="shrink-0 font-medium text-[var(--ink)]">
          {subagent.agentType}
        </span>
        {subagent.mode === 'background' && (
          <span className="shrink-0 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
            {t('agentStatus.background')}
          </span>
        )}
        {subagent.description && (
          <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">
            {subagent.description}
          </span>
        )}
      </div>
      {elapsed && (
        <span className="shrink-0 tabular-nums text-xs text-[var(--ink-muted)]">
          {elapsed}
        </span>
      )}
    </button>
  );
}

const MemoSubagentRow = memo(SubagentRow);

const SubagentSection = memo(function SubagentSection({ subagents, containerRef: _containerRef, onJumpToTool }: SubagentSectionProps) {
  // containerRef 当前留作前向 API 兼容（onJumpToTool 已内部使用 Chat 持有的 ref），
  // 解构出来防止下游 row 重复签名。下划线前缀显式标记暂不使用——保留是为后续 row 内
  // 直接做轻量 DOM 探测（如自己探测是否已 mounted 以跳过 Virtuoso 滚动）留个口子。
  void _containerRef;
  if (subagents.length === 0) return null;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between px-3 pb-1 pt-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
          SubAgents
        </span>
        <span className="text-xs tabular-nums text-[var(--ink-muted)]">
          {subagents.length}
        </span>
      </div>
      {/* V6: 行间分隔线（subtle，不抢视觉） */}
      <div className="max-h-[160px] divide-y divide-[var(--line-subtle)]/60 overflow-y-auto">
        {subagents.map(s => (
          <MemoSubagentRow key={s.id} subagent={s} onJumpToTool={onJumpToTool} />
        ))}
      </div>
    </div>
  );
});

export default SubagentSection;
