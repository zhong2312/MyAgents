import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  createNovelNarrativeStudioRepository,
  type LoadedNarrativeStudioProject,
} from "./narrativeStudioRepository";
import type {
  CreativeProfile,
  InspirationLibrary,
  NarrativeDesign,
} from "./narrativeStudioSchema";

export interface NarrativeStudioProjectController {
  readonly project: LoadedNarrativeStudioProject | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isSaving: boolean;
  reload(): Promise<LoadedNarrativeStudioProject | null>;
  saveNarrative(value: NarrativeDesign): Promise<void>;
  saveInspirations(value: InspirationLibrary): Promise<void>;
  saveProfile(value: CreativeProfile): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNarrativeStudioProject(
  storage: WorkbenchStorage,
  projectTitle: string,
  projectGenres: readonly string[],
  isActive: boolean,
): NarrativeStudioProjectController {
  const repository = useMemo(
    () =>
      createNovelNarrativeStudioRepository(
        storage,
        projectTitle,
        projectGenres,
      ),
    [projectGenres, projectTitle, storage],
  );
  const [project, setProject] = useState<LoadedNarrativeStudioProject | null>(
    null,
  );
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
          console.warn("[NarrativeStudio] File watch unavailable:", cause);
        }
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (subscription) void subscription.dispose();
    };
  }, [isActive, isSaving, load, storage]);

  const runSave = useCallback(
    async (
      operation: (
        current: LoadedNarrativeStudioProject,
      ) => Promise<LoadedNarrativeStudioProject>,
    ) => {
      if (!project) throw new Error("叙事工程尚未加载");
      setIsSaving(true);
      setError(null);
      try {
        const saved = await operation(project);
        setProject(saved);
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      } finally {
        setIsSaving(false);
      }
    },
    [project],
  );

  const saveNarrative = useCallback(
    (value: NarrativeDesign) =>
      runSave((current) => repository.saveNarrative(current, value)),
    [repository, runSave],
  );
  const saveInspirations = useCallback(
    (value: InspirationLibrary) =>
      runSave((current) => repository.saveInspirations(current, value)),
    [repository, runSave],
  );
  const saveProfile = useCallback(
    (value: CreativeProfile) =>
      runSave((current) => repository.saveProfile(current, value)),
    [repository, runSave],
  );

  return Object.freeze({
    project,
    error,
    isLoading,
    isRefreshing,
    isSaving,
    reload,
    saveNarrative,
    saveInspirations,
    saveProfile,
  });
}

