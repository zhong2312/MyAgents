import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkbenchProjection, WorkbenchStorage } from "@/workbench-sdk";

import {
  buildDomainIndex,
  type DomainIndex,
} from "../business/domainIndex";

const REBUILD_DEBOUNCE_MS = 500;

/**
 * 领域索引 hook：激活时构建索引，外部文件变化（storage.watch）防抖 500ms 后
 * 重建，保证外部编辑器修改 1 秒内对全局查找/图谱可见。索引仅存内存，不写盘。
 */
export function useDomainIndex(
  storage: WorkbenchStorage,
  isActive: boolean,
  projection?: WorkbenchProjection,
): DomainIndex | null {
  const [index, setIndex] = useState<DomainIndex | null>(null);
  const disposedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuild = useCallback(async () => {
    try {
      const next = await buildDomainIndex(storage, projection);
      if (!disposedRef.current) setIndex(next);
    } catch {
      // 单个库文件损坏不应拖垮索引；保持上次成功索引
    }
  }, [projection, storage]);

  useEffect(() => {
    disposedRef.current = false;
    if (!isActive) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await buildDomainIndex(storage, projection);
        if (!cancelled && !disposedRef.current) setIndex(next);
      } catch {
        // 单个库文件损坏不应拖垮索引；保持上次成功索引
      }
    })();

    let subscription: { dispose(): Promise<void> } | null = null;
    void storage
      .watch(() => {
        if (cancelled || !isActive) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void rebuild();
        }, REBUILD_DEBOUNCE_MS);
      })
      .then((sub) => {
        if (cancelled) {
          void sub.dispose();
        } else {
          subscription = sub;
        }
      });

    return () => {
      cancelled = true;
      disposedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void subscription?.dispose();
    };
  }, [isActive, projection, rebuild, storage]);

  return index;
}
