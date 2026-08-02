import type { WorkbenchSimulationScenario, WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";
import {
  type ExecutedWorldEvent,
  type ScheduledWorldEvent,
  type SimulationActorState,
  type SimulationRegion,
  type WorldSimulationState,
} from "./worldSimulationWorldSchema";

export function toBigInt(value: string | number | bigint): bigint {
  try { return BigInt(value); } catch { return 0n; }
}

export function compareTicks(left: string, right: string): number {
  const a = toBigInt(left); const b = toBigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addTicks(value: string, amount: string | number | bigint): string {
  return (toBigInt(value) + toBigInt(amount)).toString();
}

export function formatWorldTick(tick: string, unit: WorldSimulationState["timeUnit"]): string {
  const value = toBigInt(tick).toString();
  const names = { tick: "刻", day: "天", month: "月", year: "年", era: "纪元" } as const;
  return `第 ${value} ${names[unit]}`;
}

function activityFor(kind: ScheduledWorldEvent["kind"]): SimulationRegion["activity"] {
  if (kind === "catastrophe") return "catastrophe";
  if (kind === "milestone") return "war";
  if (kind === "emergent") return "tense";
  return "stable";
}

function applyField(current: string | undefined, operation: string, value: string): string {
  if (operation === "set" || operation === "trigger") return value;
  const numericCurrent = Number(current ?? 0); const numericValue = Number(value);
  if (operation === "multiply" && Number.isFinite(numericCurrent * numericValue)) return String(numericCurrent * numericValue);
  if (operation === "add" && Number.isFinite(numericCurrent + numericValue)) return String(numericCurrent + numericValue);
  return value;
}

function dueEvents(state: WorldSimulationState, targetTick: string): ScheduledWorldEvent[] {
  const executed = new Set(state.executedEvents.map((event) => event.id));
  return state.scheduledEvents
    .filter((event) => compareTicks(event.startTick, state.currentTick) > 0 && compareTicks(event.startTick, targetTick) <= 0 && !executed.has(event.id))
    .sort((a, b) => compareTicks(a.startTick, b.startTick) || b.priority - a.priority || a.id.localeCompare(b.id));
}

function nextEventTick(state: WorldSimulationState): string | null {
  const candidates = state.scheduledEvents
    .map((event) => event.startTick)
    .filter((tick) => compareTicks(tick, state.currentTick) > 0)
    .sort(compareTicks);
  return candidates[0] ?? null;
}

export interface WorldAdvanceResult {
  readonly state: WorldSimulationState;
  readonly events: readonly ExecutedWorldEvent[];
  readonly silent: boolean;
}

export function advanceTo(state: WorldSimulationState, targetTick: string): WorldAdvanceResult {
  if (compareTicks(targetTick, state.currentTick) <= 0) return { state, events: [], silent: true };
  const events = dueEvents(state, targetTick);
  let regions = state.regions.map((region) => ({ ...region, pressure: Math.max(0, region.pressure - 0.15), state: { ...region.state } }));
  let actors: SimulationActorState[] = state.actors.map((actor) => ({ ...actor, status: "idle", intent: "", state: { ...actor.state } }));
  const worldState = { ...state.worldState };
  const executed: ExecutedWorldEvent[] = [];
  for (const event of events) {
    const changes: ExecutedWorldEvent["changes"] = [];
    const affected = new Set(event.regionIds);
    regions = regions.map((region) => {
      if (!affected.has(region.id)) return region;
      const nextPressure = Math.min(100, Math.max(0, region.pressure + (event.kind === "catastrophe" ? 35 : event.kind === "milestone" ? 18 : event.kind === "emergent" ? 8 : 2)));
      return { ...region, pressure: nextPressure, activity: activityFor(event.kind) };
    });
    actors = actors.map((actor) => {
      if (!event.actorIds.includes(actor.id)) return actor;
      return { ...actor, status: "acting", intent: event.title };
    });
    for (const effect of event.effects) {
      if (effect.targetType === "world") {
        const before = worldState[effect.field] ?? null;
        const after = applyField(before ?? undefined, effect.operation, effect.value);
        worldState[effect.field] = after;
        changes.push({ targetType: effect.targetType, targetId: effect.targetId, field: effect.field, before, after, reason: effect.reason });
      } else if (effect.targetType === "region") {
        regions = regions.map((region) => {
          if (region.id !== effect.targetId) return region;
          const before = region.state[effect.field] ?? null;
          const after = applyField(before ?? undefined, effect.operation, effect.value);
          changes.push({ targetType: effect.targetType, targetId: effect.targetId, field: effect.field, before, after, reason: effect.reason });
          return { ...region, state: { ...region.state, [effect.field]: after } };
        });
      } else {
        actors = actors.map((actor) => {
          if (actor.id !== effect.targetId) return actor;
          const before = actor.state[effect.field] ?? null;
          const after = applyField(before ?? undefined, effect.operation, effect.value);
          changes.push({ targetType: effect.targetType, targetId: effect.targetId, field: effect.field, before, after, reason: effect.reason });
          return { ...actor, state: { ...actor.state, [effect.field]: after } };
        });
      }
    }
    executed.push({ id: event.id, tick: event.startTick, title: event.title, summary: event.description, kind: event.kind, regionIds: event.regionIds, actorIds: event.actorIds, changes });
  }
  const next: WorldSimulationState = { ...state, currentTick: targetTick, currentLabel: formatWorldTick(targetTick, state.timeUnit), regions, actors, worldState, executedEvents: [...state.executedEvents, ...executed] };
  return { state: next, events: executed, silent: events.length === 0 };
}

export function advanceToNextEvent(state: WorldSimulationState): WorldAdvanceResult {
  const target = nextEventTick(state) ?? addTicks(state.currentTick, 1);
  return advanceTo(state, target);
}

export function advanceBy(state: WorldSimulationState, duration: string | number | bigint): WorldAdvanceResult {
  const target = addTicks(state.currentTick, duration);
  const capped = state.endTick && compareTicks(target, state.endTick) > 0 ? state.endTick : target;
  return advanceTo(state, capped);
}

export function createWorldSimulationState(
  snapshot: WorkbenchSimulationWorldSnapshot,
  scenario: WorkbenchSimulationScenario,
  seedRegionIds: readonly string[] = [],
): WorldSimulationState {
  const regions: SimulationRegion[] = snapshot.locations.map((location) => ({ id: location.id, name: location.name, parentId: location.parentId, activity: "quiet", pressure: 0, state: {} }));
  const actors: SimulationActorState[] = snapshot.actors.map((actor) => ({ id: actor.id, name: actor.name, kind: actor.kind, locationId: actor.locationId, status: "idle", intent: "", state: {} }));
  const scheduledEvents: ScheduledWorldEvent[] = snapshot.timelineEvents.map((event, index) => ({ id: `timeline-${event.id}`, title: event.title, description: event.summary, startTick: String(index + 1), endTick: null, regionIds: [...event.locationIds], actorIds: [...event.actorIds], kind: "planned", priority: 0, effects: [] }));
  const seedEvents: ScheduledWorldEvent[] = scenario.seedEvents.map((raw, index) => {
    const match = raw.match(/^\s*(\d+)\s*(?:\||:)\s*(.+)$/u);
    const title = match?.[2]?.trim() || raw;
    const startTick = match?.[1] || String(index + 1);
    return { id: `seed-${scenario.id}-${index + 1}`, title, description: title, startTick, endTick: null, regionIds: [...seedRegionIds], actorIds: [...scenario.selectedActorIds], kind: "emergent", priority: 10, effects: [] };
  });
  return { schemaVersion: 1, projectId: snapshot.projectId, calendarId: "xian-tu", currentTick: "0", currentLabel: "第 0 天", timeUnit: "day", endTick: null, regions, actors, scheduledEvents: [...scheduledEvents, ...seedEvents], executedEvents: [], worldState: {} };
}
