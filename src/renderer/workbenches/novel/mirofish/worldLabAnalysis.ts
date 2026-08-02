import type { WorkbenchSimulationWorldSnapshot } from "@/workbench-sdk";

/**
 * 传播态势分析：从世界快照（行动主体 + 已发生事件）计算影响力指标与
 * 主体共现关系。纯函数，便于单元测试。
 */

export interface ActorInfluence {
  readonly actorId: string;
  readonly name: string;
  readonly kind: string;
  readonly eventCount: number;
  readonly connectionCount: number;
}

export interface ActorCooccurrence {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly count: number;
}

export interface DynamicsAnalysis {
  readonly actors: readonly ActorInfluence[];
  readonly cooccurrences: readonly ActorCooccurrence[];
}

export function analyzeActorInfluence(
  snapshot: WorkbenchSimulationWorldSnapshot,
): DynamicsAnalysis {
  const actorById = new Map(
    snapshot.actors.map((actor) => [actor.id, actor]),
  );
  const eventCount = new Map<string, number>();
  const connectionSet = new Set<string>();
  const cooccurrenceCount = new Map<string, number>();

  for (const event of snapshot.timelineEvents) {
    const ids = event.actorIds.filter((id) => actorById.has(id));
    for (const id of ids) {
      eventCount.set(id, (eventCount.get(id) ?? 0) + 1);
    }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [left, right] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        connectionSet.add(`${left}::${right}`);
        const key = `${left}::${right}`;
        cooccurrenceCount.set(key, (cooccurrenceCount.get(key) ?? 0) + 1);
      }
    }
  }

  const actors = snapshot.actors
    .map((actor) => ({
      actorId: actor.id,
      name: actor.name,
      kind: actor.kind,
      eventCount: eventCount.get(actor.id) ?? 0,
      connectionCount: [...connectionSet].filter((pair) =>
        pair.startsWith(`${actor.id}::`) || pair.endsWith(`::${actor.id}`),
      ).length,
    }))
    .filter((item) => item.eventCount > 0 || item.connectionCount > 0)
    .sort(
      (left, right) =>
        right.eventCount - left.eventCount ||
        right.connectionCount - left.connectionCount ||
        left.name.localeCompare(right.name, "zh-CN"),
    );

  const cooccurrences = [...cooccurrenceCount.entries()]
    .map(([key, count]) => {
      const [left, right] = key.split("::");
      const leftActor = actorById.get(left);
      const rightActor = actorById.get(right);
      return {
        sourceId: left,
        sourceName: leftActor?.name ?? left,
        targetId: right,
        targetName: rightActor?.name ?? right,
        count,
      };
    })
    .sort((a, b) => b.count - a.count);

  return Object.freeze({
    actors: Object.freeze(actors),
    cooccurrences: Object.freeze(cooccurrences),
  });
}
