import { useEffect, useMemo, useRef } from "react";

import type {
  WorkbenchSimulationRuns,
  WorkbenchStorage,
} from "@/workbench-sdk";

import { buildWorldSimulationSnapshot } from "./worldSimulationSnapshot";
import { buildWorldGraphData } from "./mirofish/worldGraphData";
import {
  buildCouncilRoundPrompt,
  buildCouncilSystemPrompt,
  COUNCIL_SCENE_ID,
  parseCouncilOutput,
  type CouncilRoundInput,
} from "./mirofish/councilRound";
import { createCouncilRepository } from "./mirofish/councilRepository";
import type { ManuscriptAiRunRequest } from "./ManuscriptStudio";
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
  readonly onAiRun?: (request: ManuscriptAiRunRequest) => Promise<string>;
  readonly initialView?: MiroFishNovelView;
}

export default function MiroFishNovelWorkbench({
  storage,
  simulationRuns,
  isActive,
  onOpenConsole,
  onAiRun,
  initialView = "overview",
}: MiroFishNovelWorkbenchProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bridge = useMemo(
    () =>
      createMiroFishNovelBridge({
        simulationRuns,
        loadSnapshot: () => buildWorldSimulationSnapshot(storage),
        // 融合投影：知识图谱 + 世界推演快照（行动主体/地点/已发生事件）。
        // 快照构建失败（如旧项目缺 world/rules.json）时降级为纯知识图谱。
        loadWorldGraph: async () => {
          const simulation = await buildWorldSimulationSnapshot(storage).catch(
            () => null,
          );
          return buildWorldGraphData(storage, simulation);
        },
        // 圆桌会商：逐轮调用模型场景驱动发言与投票（不依赖 MiroFish 伴服）。
        runCouncilRound: async (input: CouncilRoundInput) => {
          if (!onAiRun) throw new Error("当前没有可用模型，无法发起圆桌会商");
          const output = await onAiRun({
            sceneId: COUNCIL_SCENE_ID,
            label: `圆桌会商 · ${input.round}/${input.maxRounds} 轮`,
            systemPrompt: buildCouncilSystemPrompt(),
            prompt: buildCouncilRoundPrompt(input),
          });
          return parseCouncilOutput(output);
        },
        saveCouncilSession: async (session) => {
          const repository = createCouncilRepository(storage);
          const loaded = await repository.load();
          const next = [
            session,
            ...loaded.value.sessions.filter(
              (item) =>
                item.topic !== session.topic ||
                item.actorIds.join("\u0000") !== session.actorIds.join("\u0000"),
            ),
          ].slice(0, 50);
          await repository.save(loaded, next);
        },
        loadCouncilSessions: async () => {
          const repository = createCouncilRepository(storage);
          const loaded = await repository.load();
          return loaded.value.sessions;
        },
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
    [onAiRun, simulationRuns, storage],
  );

  useEffect(() => {
    if (!isActive || !hostRef.current) return;
    const unmount = mountMiroFishNovelLab(hostRef.current, {
      bridge,
      initialView,
    });
    return unmount;
  }, [bridge, initialView, isActive]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--paper)]">
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" />
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-4 py-2 text-xs text-[var(--ink-muted)]">
        <span>世界实验室与当前小说项目保持同步。</span>
        <button
          type="button"
          onClick={onOpenConsole}
          className="rounded border border-[var(--line)] px-2 py-1 font-medium text-[var(--ink)] hover:bg-[var(--hover-bg)]"
        >
          运行控制台
        </button>
      </div>
    </div>
  );
}
