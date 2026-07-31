import { useEffect, useMemo, useRef } from "react";

import type {
  WorkbenchSimulationRuns,
  WorkbenchStorage,
} from "@/workbench-sdk";

import { buildWorldSimulationSnapshot } from "./worldSimulationSnapshot";
import {
  createMiroFishNovelBridge,
  type MiroFishNovelView,
} from "./mirofishBridge";
import { mountMiroFishNovelLab } from "./MiroFishNovelLab";

interface MiroFishNovelWorkbenchProps {
  readonly storage: WorkbenchStorage;
  readonly simulationRuns: WorkbenchSimulationRuns;
  readonly isActive: boolean;
  readonly onOpenConsole: () => void;
}

export default function MiroFishNovelWorkbench({
  storage,
  simulationRuns,
  isActive,
  onOpenConsole,
}: MiroFishNovelWorkbenchProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bridge = useMemo(
    () =>
      createMiroFishNovelBridge({
        simulationRuns,
        loadSnapshot: () => buildWorldSimulationSnapshot(storage),
        onNavigate: (view: MiroFishNovelView) => {
          if (view === "overview") return;
          if (view === "reports") return;
          // The current React console remains the authority for creating and
          // controlling runs. The Vue surface only requests that console when
          // a future view needs an editable scenario.
          if (view === "dynamics" || view === "causal" || view === "council") {
            return;
          }
        },
      }),
    [simulationRuns, storage],
  );

  useEffect(() => {
    if (!isActive || !hostRef.current) return;
    const unmount = mountMiroFishNovelLab(hostRef.current, {
      bridge,
      initialView: "overview",
    });
    return unmount;
  }, [bridge, isActive]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" />
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-2 text-xs text-[var(--ink-muted)]">
        <span>Vue 微应用已绑定当前小说项目，数据由 MyAgents Host 提供。</span>
        <button
          type="button"
          onClick={onOpenConsole}
          className="rounded border border-[var(--line)] px-2 py-1 font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
        >
          打开运行控制台
        </button>
      </div>
    </div>
  );
}
