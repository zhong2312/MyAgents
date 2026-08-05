import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import PromptManagerPrototype from "./PromptManagerPrototype";
import {
  createNovelPromptLibraryRepository,
  type LoadedPromptLibrary,
} from "../data-access/promptLibraryRepository";
import type { PromptLibraryModel } from "../entities/promptLibrarySchema";

interface PromptManagerProps {
  readonly storage: WorkbenchStorage;
  readonly projectGenres: readonly string[];
  readonly isActive: boolean;
}

type PersistenceStatus = "loading" | "ready" | "dirty" | "saving" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function PromptManager({
  storage,
  projectGenres,
  isActive,
}: PromptManagerProps) {
  const repository = useMemo(
    () => createNovelPromptLibraryRepository(storage),
    [storage],
  );
  const [library, setLibrary] = useState<LoadedPromptLibrary | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<PersistenceStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [externalChanged, setExternalChanged] = useState(false);
  const baseRef = useRef<LoadedPromptLibrary | null>(null);
  const pendingRef = useRef<PromptLibraryModel | null>(null);
  const savePromiseRef = useRef<Promise<LoadedPromptLibrary> | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const writeWindowRef = useRef(false);
  const writeWindowTimerRef = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const loaded = await repository.load();
      baseRef.current = loaded;
      pendingRef.current = null;
      setLibrary(loaded);
      setRevision((current) => current + 1);
      setExternalChanged(false);
      setError(null);
      setStatus("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setStatus("error");
    }
  }, [repository]);

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load, storage.rootPath]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    if (savePromiseRef.current) await savePromiseRef.current;

    while (pendingRef.current) {
      const current = baseRef.current;
      const nextModel = pendingRef.current;
      if (!current) throw new Error("提示词数据尚未加载");
      pendingRef.current = null;
      setStatus("saving");
      setError(null);
      writeWindowRef.current = true;
      const operation = repository.save(current, nextModel);
      savePromiseRef.current = operation;
      try {
        const saved = await operation;
        baseRef.current = saved;
        setLibrary(saved);
        setExternalChanged(false);
      } catch (cause) {
        pendingRef.current = nextModel;
        setError(errorMessage(cause));
        setExternalChanged(true);
        setStatus("error");
        throw cause;
      } finally {
        savePromiseRef.current = null;
        window.clearTimeout(writeWindowTimerRef.current);
        writeWindowTimerRef.current = window.setTimeout(() => {
          writeWindowRef.current = false;
        }, 600);
      }
    }
    setStatus("ready");
  }, [repository]);

  const handleModelChange = useCallback(
    (model: PromptLibraryModel) => {
      pendingRef.current = model;
      setStatus("dirty");
      setError(null);
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void flush().catch(() => undefined);
      }, 450);
    },
    [flush],
  );

  const handleSave = useCallback(
    async (model: PromptLibraryModel) => {
      pendingRef.current = model;
      await flush();
    },
    [flush],
  );

  useEffect(() => {
    if (!isActive || !storage.isAvailable) return;
    let disposed = false;
    let refreshTimer: number | undefined;
    let subscription:
      | Awaited<ReturnType<WorkbenchStorage["watch"]>>
      | undefined;
    void storage
      .watch(() => {
        if (disposed || writeWindowRef.current) return;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          if (pendingRef.current || savePromiseRef.current) {
            setExternalChanged(true);
            return;
          }
          void load();
        }, 180);
      })
      .then((value) => {
        if (disposed) void value.dispose();
        else subscription = value;
      })
      .catch((cause) => {
        if (!disposed) {
          console.warn("[NovelWorkbench] Prompt watch unavailable:", cause);
        }
      });
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      if (subscription) void subscription.dispose();
    };
  }, [isActive, load, storage]);

  useEffect(
    () => () => {
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(writeWindowTimerRef.current);
      const current = baseRef.current;
      const pending = pendingRef.current;
      if (current && pending) {
        void repository.save(current, pending).catch((cause) => {
          console.error(
            "[NovelWorkbench] Failed to flush prompt changes:",
            cause,
          );
        });
      }
    },
    [repository],
  );

  if (!library && status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在读取提示词
      </div>
    );
  }

  if (!library) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-lg text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-[var(--warning)]" />
          <h1 className="mt-3 text-lg font-semibold">无法读取提示词</h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            {error ?? "提示词注册表不存在或格式不正确"}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mx-auto mt-4 flex h-9 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm hover:bg-[var(--hover-bg)]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> 重新读取
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(error || externalChanged) && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--warning-bg)] px-4 py-2 text-xs text-[var(--warning)]">
          <span className="min-w-0">
            {error ?? "提示词文件已在外部修改，本地内容尚未覆盖磁盘版本"}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            载入磁盘版本
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <PromptManagerPrototype
          key={revision}
          initialModel={library.model}
          initialProjectGenres={projectGenres}
          onModelChange={handleModelChange}
          onSave={handleSave}
          githubInstallEnabled={false}
        />
        {(status === "dirty" || status === "saving") && (
          <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)] shadow-md">
            {status === "saving" && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {status === "saving" ? "正在保存" : "等待保存"}
          </div>
        )}
      </div>
    </div>
  );
}
