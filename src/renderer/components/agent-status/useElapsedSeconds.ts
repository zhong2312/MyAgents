// PRD 0.2.17 — Agent Status Panel
//
// 把 startedAt（不变量）转成"已运行 N 秒"的实时字符串。隔离在小 hook 里，让
// 每秒重渲只影响调用方组件（典型是一个 SubagentRow 或长条的时间数字），不
// 触发整张面板列表的重算（避免 todos/subagents 数组结构每秒重 diff）。

import { useEffect, useState } from 'react';

import { formatElapsed } from './format';

export function useElapsedSeconds(startedAt: number | null, finishedAt?: number): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null || finishedAt !== undefined) return;
    // 立即对齐一次（用 rAF 包装，避免 react-hooks/set-state-in-effect lint），
    // 然后每秒 tick。setInterval 在 callback 里 setState 不会触发 lint。
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [startedAt, finishedAt]);

  if (startedAt === null) return null;
  return formatElapsed(Math.max(0, (finishedAt ?? now) - startedAt));
}
