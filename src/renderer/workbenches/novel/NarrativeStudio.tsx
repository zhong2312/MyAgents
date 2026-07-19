import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { WorkbenchStorage } from "@/workbench-sdk";

import CreativeProfileWorkbench from "./CreativeProfileWorkbench";
import InspirationWorkbench from "./InspirationWorkbench";
import NarrativeDesignWorkbench, {
  type NarrativeFocus,
} from "./NarrativeDesignWorkbench";
import "./NarrativeStudio.css";
import type { LoadedNovelChapter } from "./repository";
import { useNarrativeStudioProject } from "./useNarrativeStudioProject";

export type NarrativeStudioScreen =
  | "narrative"
  | "inspiration"
  | "profile";

interface NarrativeStudioProps {
  readonly screen: NarrativeStudioScreen;
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
  readonly projectTitle: string;
  readonly projectGenres: readonly string[];
  readonly chapters: readonly LoadedNovelChapter[];
  readonly outlineContent: string;
  readonly onSaveOutline: (
    content: string,
    expectedContent: string,
  ) => Promise<void>;
  readonly onNavigateScreen: (screen: NarrativeStudioScreen) => void;
}

export default function NarrativeStudio({
  screen,
  storage,
  isActive,
  projectTitle,
  projectGenres,
  chapters,
  outlineContent,
  onSaveOutline,
  onNavigateScreen,
}: NarrativeStudioProps) {
  const controller = useNarrativeStudioProject(
    storage,
    projectTitle,
    projectGenres,
    isActive,
  );
  const [narrativeFocus, setNarrativeFocus] =
    useState<NarrativeFocus | null>(null);
  const [inspirationFocusId, setInspirationFocusId] = useState<string | null>(
    null,
  );

  if (controller.isLoading && !controller.project) {
    return (
      <div className="narrative-studio items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-warm)]" />
        <p className="mt-3 text-sm text-[var(--ink-muted)]">
          正在读取叙事工程文件…
        </p>
      </div>
    );
  }
  if (!controller.project) {
    return (
      <div className="narrative-studio items-center justify-center p-8 text-center">
        <AlertTriangle className="h-6 w-6 text-[var(--error)]" />
        <h1 className="mt-3 text-base font-semibold">无法读取叙事工程</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--ink-muted)]">
          {controller.error ?? "项目文件不存在或格式无效"}
        </p>
        <button
          type="button"
          className="ns-button mt-4"
          onClick={() => void controller.reload()}
        >
          <RefreshCw className="h-3.5 w-3.5" />重新读取
        </button>
      </div>
    );
  }

  const project = controller.project;
  if (screen === "inspiration") {
    return (
      <InspirationWorkbench
        library={project.inspirations}
        content={project.inspirationContent}
        narrative={project.narrative}
        profile={project.profile}
        isSaving={controller.isSaving}
        focusId={inspirationFocusId}
        onFocusConsumed={() => setInspirationFocusId(null)}
        onSave={controller.saveInspirations}
        onOpenNarrative={(focus) => {
          setNarrativeFocus(focus);
          onNavigateScreen("narrative");
        }}
      />
    );
  }
  if (screen === "profile") {
    return (
      <CreativeProfileWorkbench
        profile={project.profile}
        content={project.profileContent}
        isSaving={controller.isSaving}
        onSave={controller.saveProfile}
      />
    );
  }
  return (
    <NarrativeDesignWorkbench
      narrative={project.narrative}
      narrativeContent={project.narrativeContent}
      inspirations={project.inspirations}
      profile={project.profile}
      chapters={chapters}
      outlineContent={outlineContent}
      isSaving={controller.isSaving}
      focus={narrativeFocus}
      onFocusConsumed={() => setNarrativeFocus(null)}
      onSaveNarrative={controller.saveNarrative}
      onSaveOutline={onSaveOutline}
      onOpenInspiration={(id) => {
        setInspirationFocusId(id);
        onNavigateScreen("inspiration");
      }}
    />
  );
}

