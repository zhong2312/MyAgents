import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import type {
  WorkbenchNavigationGuard,
  WorkbenchStorage,
} from "@/workbench-sdk";

import type {
  InspirationAiAgentRequest,
  InspirationAiRunRequest,
} from "./inspirationAi";
import type { InspirationItem } from "./inspirationSchema";
import InspirationWorkbench from "./InspirationWorkbench";
import "./InspirationStudio.css";
import { createNarrativeEngineeringRepository } from "./narrativeEngineeringRepository";
import type { DomainEntityRef } from "./domainIndex";
import { useInspirationProject } from "./useInspirationProject";

interface InspirationStudioProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly projectTitle: string;
  readonly focus?: DomainEntityRef | null;
  readonly onAiRun?: (request: InspirationAiRunRequest) => Promise<string>;
  readonly onOpenAiAgent?: (
    request: InspirationAiAgentRequest,
  ) => Promise<void>;
  readonly registerNavigationGuard: (
    guard: WorkbenchNavigationGuard,
  ) => () => void;
}

export default function InspirationStudio({
  storage,
  isActive,
  projectTitle,
  onAiRun,
  onOpenAiAgent,
  focus,
  registerNavigationGuard,
}: InspirationStudioProps) {
  const controller = useInspirationProject(storage, isActive);

  const convertToNarrative = async (item: InspirationItem) => {
    const narrativeRepository = createNarrativeEngineeringRepository(storage);
    const current = await narrativeRepository.load();
    const plan = {
      id: `narrative-chapter-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
      directoryId: null,
      manuscriptChapterId: null,
      title: item.title.trim() || "来自灵感的规划",
      description: `【来自灵感“${item.title.trim()}”】\n${item.body.slice(0, 4000)}`,
      status: "idea" as const,
      order: current.library.chapters.length,
      updatedAt: new Date().toISOString(),
      lineIds: [],
      arcIds: [],
      sections: [],
    };
    await narrativeRepository.save(current, {
      ...current.library,
      chapters: [...current.library.chapters, plan],
    });
  };

  if (controller.isLoading && !controller.project) {
    return (
      <div className="inspiration-studio items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-warm)]" />
        <p className="mt-3 text-sm text-[var(--ink-muted)]">正在读取灵感文件…</p>
      </div>
    );
  }
  if (!controller.project) {
    return (
      <div className="inspiration-studio items-center justify-center p-8 text-center">
        <AlertTriangle className="h-6 w-6 text-[var(--error)]" />
        <h1 className="mt-3 text-base font-semibold">无法读取灵感</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--ink-muted)]">
          {controller.error ?? "灵感文件不存在或格式无效"}
        </p>
        <button
          type="button"
          className="ns-button mt-4"
          onClick={() => void controller.reload()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新读取
        </button>
      </div>
    );
  }

  return (
    <InspirationWorkbench
      storage={storage}
      isActive={isActive}
      projectTitle={projectTitle}
      library={controller.project.library}
      content={controller.project.content}
      isSaving={controller.isSaving}
      onSave={controller.save}
      onAiRun={onAiRun}
      onOpenAiAgent={onOpenAiAgent}
      onConvertToNarrative={convertToNarrative}
      focus={focus}
      registerNavigationGuard={registerNavigationGuard}
    />
  );
}
