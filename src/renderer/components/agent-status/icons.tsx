// PRD 0.2.17 — Agent Status Panel
//
// Todo 三态 icon + SubAgent 运行 icon。严格对照需求截图的视觉语言：
//   - pending      ☐ 空心方框（ink-muted）
//   - in_progress  ■ 实心方块（accent-warm 橙色）
//   - completed    ☑ 勾选（success 绿）+ 删除线由调用方加在文本上

import { Check } from 'lucide-react';

interface IconProps {
  className?: string;
}

export function TodoPendingIcon({ className = '' }: IconProps) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3.5 shrink-0 rounded-[3px] border border-[var(--ink-subtle)] ${className}`}
    />
  );
}

export function TodoInProgressIcon({ className = '' }: IconProps) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3.5 shrink-0 rounded-[3px] bg-[var(--accent-warm)] ${className}`}
    />
  );
}

export function TodoCompletedIcon({ className = '' }: IconProps) {
  return (
    <span
      aria-hidden
      className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[var(--success)] text-[var(--on-success)] ${className}`}
    >
      <Check className="size-2.5" strokeWidth={3} />
    </span>
  );
}

export function SubagentRunningIcon({ className = '' }: IconProps) {
  return (
    <span aria-hidden className={`relative inline-flex size-3.5 shrink-0 items-center justify-center ${className}`}>
      <span className="absolute inline-flex size-2.5 rounded-full bg-[var(--accent-cool)] opacity-70 animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-[var(--accent-cool)]" />
    </span>
  );
}
