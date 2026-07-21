import type {
  WorkbenchSimulationRun,
  WorkbenchSimulationScenario,
  WorkbenchStorage,
} from "@/workbench-sdk";

import {
  WORLD_SIMULATION_SCENARIOS_PATH,
  createEmptyWorldSimulationProjectFile,
  normalizeSimulationScenario,
  parseWorldSimulationProjectFile,
  serializeWorldSimulationProjectFile,
  simulationRunReference,
  type WorldSimulationProjectFile,
} from "./worldSimulationSchema";

export interface LoadedWorldSimulationProject {
  readonly value: WorldSimulationProjectFile;
  readonly content: string;
}

export interface WorldSimulationRepository {
  load(): Promise<LoadedWorldSimulationProject>;
  saveScenario(
    current: LoadedWorldSimulationProject,
    scenario: WorkbenchSimulationScenario,
  ): Promise<LoadedWorldSimulationProject>;
  removeScenario(
    current: LoadedWorldSimulationProject,
    scenarioId: string,
  ): Promise<LoadedWorldSimulationProject>;
  saveRunReference(
    current: LoadedWorldSimulationProject,
    run: WorkbenchSimulationRun,
  ): Promise<LoadedWorldSimulationProject>;
}

async function save(
  storage: WorkbenchStorage,
  current: LoadedWorldSimulationProject,
  value: WorldSimulationProjectFile,
): Promise<LoadedWorldSimulationProject> {
  const content = serializeWorldSimulationProjectFile(value);
  const file = await storage.writeText(
    WORLD_SIMULATION_SCENARIOS_PATH,
    content,
    { expectedContent: current.content },
  );
  return Object.freeze({
    value: parseWorldSimulationProjectFile(file.content),
    content: file.content,
  });
}

export function createWorldSimulationInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: WORLD_SIMULATION_SCENARIOS_PATH,
      content: serializeWorldSimulationProjectFile(
        createEmptyWorldSimulationProjectFile(),
      ),
    },
  ];
}

export function createWorldSimulationRepository(
  storage: WorkbenchStorage,
): WorldSimulationRepository {
  const repository: WorldSimulationRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("世界推演仅在 MyAgents 桌面端可用");
      }
      const initial = createWorldSimulationInitializationFiles()[0];
      const [info] = await storage.stat([initial.path]);
      let file;
      if (info?.exists) {
        file = await storage.readText(initial.path);
      } else {
        try {
          file = await storage.createText(initial.path, initial.content, {
            createParents: true,
          });
        } catch {
          file = await storage.readText(initial.path);
        }
      }
      return Object.freeze({
        value: parseWorldSimulationProjectFile(file.content),
        content: file.content,
      });
    },

    async saveScenario(
      current: LoadedWorldSimulationProject,
      scenario: WorkbenchSimulationScenario,
    ) {
      const parsed = normalizeSimulationScenario(scenario);
      const scenarios = current.value.scenarios.filter(
        (item) => item.id !== parsed.id,
      );
      scenarios.push({
        ...parsed,
        selectedActorIds: [...parsed.selectedActorIds],
        seedEvents: [...parsed.seedEvents],
        constraints: [...parsed.constraints],
      });
      scenarios.sort((left, right) => left.name.localeCompare(right.name));
      return save(storage, current, { ...current.value, scenarios });
    },

    async removeScenario(
      current: LoadedWorldSimulationProject,
      scenarioId: string,
    ) {
      return save(storage, current, {
        ...current.value,
        scenarios: current.value.scenarios.filter(
          (item) => item.id !== scenarioId,
        ),
      });
    },

    async saveRunReference(
      current: LoadedWorldSimulationProject,
      run: WorkbenchSimulationRun,
    ) {
      const reference = simulationRunReference(run);
      const runReferences = current.value.runReferences.filter(
        (item) => item.runId !== reference.runId,
      );
      runReferences.unshift(reference);
      return save(storage, current, {
        ...current.value,
        runReferences: runReferences.slice(0, 100),
      });
    },
  };
  return Object.freeze(repository);
}
