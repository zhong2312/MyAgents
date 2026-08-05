import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelInspirationRepository,
  type LoadedInspirationProject,
} from "../data-access/inspirationRepository";
import type { InspirationLibrary } from "../entities/inspirationSchema";

export interface InspirationProjectController {
  readonly project: LoadedInspirationProject | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isSaving: boolean;
  reload(): Promise<LoadedInspirationProject | null>;
  save(value: InspirationLibrary): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useInspirationProject(
  storage: WorkbenchStorage,
  isActive: boolean,
): InspirationProjectController {
  const repository = useMemo(
    () => createNovelInspirationRepository(storage),
    [storage],
  );
  const [project, setProject] = useState<LoadedInspirationProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (background: boolean) => {
      const requestId = ++requestIdRef.current;
      if (background) setIsRefreshing(true);
      else setIsLoading(true);
      try {
        const loaded = await repository.load();
        if (requestId !== requestIdRef.current) return null;
        setProject(loaded);
        setError(null);
        return loaded;
      } catch (cause) {
        if (requestId === requestIdRef.current) setError(errorMessage(cause));
        return null;
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [repository],
  );

  const reload = useCallback(() => load(project !== null), [load, project]);

  useEffect(() => {
    if (!isActive) return;
    void load(false);
  }, [isActive, load, storage.rootPath]);

  useEffect(() => {
    if (!isActive || !storage.isAvailable) return;
    let disposed = false;
    let timer: number | undefined;
    let subscription: Awaited<ReturnType<WorkbenchStorage["watch"]>> | undefined;
    void storage
      .watch(() => {
        if (disposed || isSaving) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void load(true), 180);
      })
      .then((value) => {
        if (disposed) void value.dispose();
        else subscription = value;
      })
      .catch((cause) => {
        if (!disposed) {
          console.warn("[Inspiration] File watch unavailable:", cause);
        }
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (subscription) void subscription.dispose();
    };
  }, [isActive, isSaving, load, storage]);

  const save = useCallback(
    async (value: InspirationLibrary) => {
      if (!project) throw new Error("灵感尚未加载");
      setIsSaving(true);
      setError(null);
      try {
        setProject(await repository.save(project, value));
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      } finally {
        setIsSaving(false);
      }
    },
    [project, repository],
  );

  return Object.freeze({
    project,
    error,
    isLoading,
    isRefreshing,
    isSaving,
    reload,
    save,
  });
}
