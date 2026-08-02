import type { WorkbenchStorage } from "@/workbench-sdk";
import { createEmptyWorldSimulationState, parseWorldSimulationState, serializeWorldSimulationState, WORLD_SIMULATION_WORLD_PATH, type WorldSimulationState } from "./worldSimulationWorldSchema";

export interface LoadedWorldSimulationState { readonly value: WorldSimulationState; readonly content: string; }

export function createWorldSimulationWorldRepository(storage: WorkbenchStorage) {
  return {
    async load(projectId: string): Promise<LoadedWorldSimulationState> {
      if (!storage.isAvailable) throw new Error("世界推演仅在 MyAgents 桌面端可用");
      const [info] = await storage.stat([WORLD_SIMULATION_WORLD_PATH]);
      if (info?.exists) { const file = await storage.readText(WORLD_SIMULATION_WORLD_PATH); return Object.freeze({ value: parseWorldSimulationState(file.content), content: file.content }); }
      const empty = createEmptyWorldSimulationState(projectId);
      const file = await storage.createText(WORLD_SIMULATION_WORLD_PATH, serializeWorldSimulationState(empty), { createParents: true });
      return Object.freeze({ value: empty, content: file.content });
    },
    async save(current: LoadedWorldSimulationState, value: WorldSimulationState): Promise<LoadedWorldSimulationState> {
      const file = await storage.writeText(WORLD_SIMULATION_WORLD_PATH, serializeWorldSimulationState(value), { expectedContent: current.content });
      return Object.freeze({ value: parseWorldSimulationState(file.content), content: file.content });
    },
  };
}

