import type {
  SimulationEvent,
  SimulationEntityRef,
  SimulationBoundary,
  SimulationRound,
  SimulationRun,
  SimulationTimeScale,
} from "../entities/simulationSchema";

export interface SimulationCharacterSnapshot {
  readonly id: string;
  readonly name: string;
  readonly currentLocationId?: string | null;
  readonly currentLocationLabel?: string | null;
  readonly status?: string;
  readonly age?: string;
  readonly baseLifespan?: string;
  readonly goals?: string;
  readonly motivation?: string;
  readonly factionId?: string | null;
  readonly resources?: readonly string[];
  /** 只有存在结构化完成时间时，调度器才会把行动完成边界交给 AI 推演。 */
  readonly nextActionTime?: number | null;
  readonly nextActionLabel?: string | null;
  readonly alive?: boolean;
}

export interface SimulationFactionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly summary?: string;
  readonly territoryIds?: readonly string[];
  readonly territoryLabels?: readonly string[];
  readonly resources?: readonly string[];
  readonly strategy?: string;
  readonly nextActionTime?: number | null;
  readonly nextActionLabel?: string | null;
  readonly alive?: boolean;
}

export interface SimulationLocationSnapshot {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly nodeId?: string | null;
}

export interface SimulationTimelineSnapshot {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly timeLabel?: string;
  readonly time?: number | null;
  readonly characterIds?: readonly string[];
  readonly factionIds?: readonly string[];
  readonly locationIds?: readonly string[];
}

export interface SimulationBaselineChapterSnapshot {
  readonly id: string;
  readonly displayNumber: number;
  readonly title: string;
  readonly path: string;
  readonly content: string;
}

export interface SimulationScheduledBoundary {
  readonly kind: SimulationBoundary["kind"];
  readonly time: number;
  readonly reason: string;
  readonly sourceEntity?: SimulationEntityRef | null;
  readonly sourceEventId?: string | null;
}

export interface SimulationEngineInputs {
  readonly characterCount: number;
  readonly factionCount: number;
  readonly locationCount: number;
  readonly timelineEventCount: number;
  readonly observationSpaceId?: string | null;
  readonly observationSpaceLabel?: string;
  readonly characters?: readonly SimulationCharacterSnapshot[];
  readonly factions?: readonly SimulationFactionSnapshot[];
  readonly locations?: readonly SimulationLocationSnapshot[];
  readonly timelineEvents?: readonly SimulationTimelineSnapshot[];
  readonly baselineChapter?: SimulationBaselineChapterSnapshot | null;
  readonly scheduledBoundaries?: readonly SimulationScheduledBoundary[];
  readonly diagnostics?: readonly string[];
}

export interface SimulationAdvanceResult {
  readonly run: SimulationRun;
  readonly round: SimulationRound;
  readonly events: readonly SimulationEvent[];
}

const SCALE_DAYS: Record<SimulationTimeScale, number> = {
  day: 1,
  month: 30,
  year: 365,
  century: 36_500,
  millennium: 365_000,
  era: 3_650_000,
  "ten-thousand-year": 3_650_000,
  "ten-million-year": 3_650_000_000,
  "hundred-million-year": 36_500_000_000,
};

export function simulationScaleDays(
  scale: SimulationTimeScale,
  amount = 1,
): number {
  return SCALE_DAYS[scale] * Math.max(1, Math.floor(amount));
}

export function formatSimulationTime(days: number): string {
  const safeDays = Math.max(0, Math.floor(days));
  const year = Math.floor(safeDays / 365);
  const dayOfYear = safeDays % 365;
  if (safeDays === 0) return "故事起点";
  if (safeDays < 30) return `第 ${dayOfYear + 1} 天`;
  if (safeDays < 365) return `第 ${Math.floor(dayOfYear / 30) + 1} 月`;
  if (safeDays < 36_500) return `第 ${year} 年`;
  if (safeDays < 365_000) return `第 ${Math.floor(year / 100) + 1} 世纪`;
  if (year < 10_000) return `第 ${Math.floor(year / 1000) + 1} 千年`;
  if (year < 10_000_000) return `第 ${Math.floor(year / 10_000) + 1} 万年`;
  if (year < 100_000_000)
    return `第 ${Math.floor(year / 10_000_000) + 1} 千万年`;
  return `第 ${Math.floor(year / 100_000_000) + 1} 亿年`;
}

export function formatSimulationSpan(
  scale: SimulationTimeScale,
  amount = 1,
): string {
  const value = Math.max(1, Math.floor(amount));
  if (value === 1) {
    return {
      day: "一天",
      month: "一个月",
      year: "一年",
      century: "一百年",
      millennium: "一千年",
      era: "一万年",
      "ten-thousand-year": "一万年",
      "ten-million-year": "一千万年",
      "hundred-million-year": "一亿年",
    }[scale];
  }
  const labels: Record<SimulationTimeScale, string> = {
    day: "天",
    month: "个月",
    year: "年",
    century: "年",
    millennium: "年",
    era: "年",
    "ten-thousand-year": "万年",
    "ten-million-year": "千万年",
    "hundred-million-year": "亿年",
  };
  const multiplier: Record<SimulationTimeScale, number> = {
    day: 1,
    month: 1,
    year: 1,
    century: 100,
    millennium: 1_000,
    era: 10_000,
    "ten-thousand-year": 1,
    "ten-million-year": 1,
    "hundred-million-year": 1,
  };
  return `${(value * multiplier[scale]).toLocaleString("zh-CN")}${labels[scale]}`;
}

function eventId(
  run: SimulationRun,
  roundIndex: number,
  position: number,
): string {
  return `${run.id}-r${roundIndex}-e${position}`;
}

function ref(
  type: SimulationEntityRef["type"],
  id: string,
  label: string,
): SimulationEntityRef {
  return { type, id, label };
}

function createEvent(
  run: SimulationRun,
  roundIndex: number,
  position: number,
  input: Omit<
    SimulationEvent,
    | "id"
    | "actorRefs"
    | "locationRef"
    | "targetRefs"
    | "triggerFacts"
    | "decision"
    | "action"
    | "stateChanges"
    | "uncertainty"
  > &
    Partial<
      Pick<
        SimulationEvent,
        | "actorRefs"
        | "locationRef"
        | "targetRefs"
        | "triggerFacts"
        | "decision"
        | "action"
        | "stateChanges"
        | "uncertainty"
      >
    >,
): SimulationEvent {
  return {
    id: eventId(run, roundIndex, position),
    actorRefs: [],
    locationRef: null,
    targetRefs: [],
    triggerFacts: [],
    decision: "",
    action: "",
    stateChanges: [],
    uncertainty: "",
    ...input,
  };
}

function periodicEvents(
  run: SimulationRun,
  round: SimulationRound,
  inputs: SimulationEngineInputs,
  position: number,
): SimulationEvent[] {
  const crossedYear =
    Math.floor(round.endTime / 365) > Math.floor(round.startTime / 365);
  const crossedMillennium =
    Math.floor(round.endTime / 365_000) > Math.floor(round.startTime / 365_000);
  if (crossedMillennium) {
    return [
      createEvent(run, round.index, position, {
        kind: "world-process",
        title: "灵气与秘境周期进入 AI 聚合窗口",
        summary: `时间边界只确认本轮跨越一千年周期，秘境、灵脉和修炼传统的具体变化仍需 AI 依据正式资料生成；观察范围为${inputs.observationSpaceLabel ?? "当前空间"}。`,
        time: round.endTime,
        certainty: "aggregated",
        source: "rule",
        entityRefs: [ref("world", "world-process", "世界过程")],
        actorRefs: [],
        locationRef: inputs.observationSpaceId
          ? ref(
              "location",
              inputs.observationSpaceId,
              inputs.observationSpaceLabel ?? inputs.observationSpaceId,
            )
          : null,
        targetRefs: [],
        triggerFacts: [
          {
            id: "rule-secret-realm-cycle",
            label: "周期边界",
            value: "跨越一千年",
            sourcePath: null,
          },
        ],
        decision: "",
        action: "把聚合时间边界交给 AI 生成周期过程",
        stateChanges: [],
        uncertainty:
          "具体秘境位置、影响范围和受影响主体尚未由 AI 根据正式资料生成。",
        causeEventIds: [],
        propagations: [],
        ruleIds: ["secret-realm-cycle"],
      }),
    ];
  }
  if (crossedYear) {
    return [
      createEvent(run, round.index, position, {
        kind: "world-process",
        title: "年度人口与资源 AI 推演边界",
        summary:
          "时间边界确认本轮跨越年度；AI 只依据正式资料生成节日、出生、死亡和灾害故事，不把未知细节扩写成确定事实。",
        time: round.endTime,
        certainty: "confirmed",
        source: "rule",
        entityRefs: [ref("world", "annual-cycle", "年度世界过程")],
        actorRefs: [],
        locationRef: inputs.observationSpaceId
          ? ref(
              "location",
              inputs.observationSpaceId,
              inputs.observationSpaceLabel ?? inputs.observationSpaceId,
            )
          : null,
        targetRefs: [],
        triggerFacts: [
          {
            id: "rule-annual-cycle",
            label: "周期边界",
            value: "跨越年度",
            sourcePath: null,
          },
        ],
        decision: "",
        action: "把年度人口、季节和资源边界交给 AI 生成",
        stateChanges: [],
        uncertainty:
          "具体节日、出生、死亡和灾害只有在正式资料与时间边界支持时才会由 AI 生成。",
        causeEventIds: [],
        propagations: [],
        ruleIds: ["annual-festival", "population-lifecycle"],
      }),
    ];
  }
  return [];
}

function chooseBoundary(
  run: SimulationRun,
  inputs: SimulationEngineInputs,
): {
  readonly endTime: number;
  readonly boundary: SimulationBoundary;
  readonly nextBoundary: SimulationBoundary | null;
} {
  const startTime = run.currentTime;
  const scaleEnd = Math.min(
    run.endTime,
    startTime + simulationScaleDays(run.timeScale, run.timeStep),
  );
  const candidates: SimulationScheduledBoundary[] = [
    ...(inputs.scheduledBoundaries ?? []),
    ...(inputs.characters ?? [])
      .filter((character) => character.alive !== false)
      .flatMap((character) =>
        typeof character.nextActionTime === "number"
          ? [
              {
                kind: "action-complete" as const,
                time: character.nextActionTime,
                reason: `${character.name}的${character.nextActionLabel ?? "当前行动"}完成`,
                sourceEntity: ref("character", character.id, character.name),
                sourceEventId: null,
              },
            ]
          : [],
      ),
    ...(inputs.factions ?? [])
      .filter((faction) => faction.alive !== false)
      .flatMap((faction) =>
        typeof faction.nextActionTime === "number"
          ? [
              {
                kind: "resource-node" as const,
                time: faction.nextActionTime,
                reason: `${faction.name}的${faction.nextActionLabel ?? "战略周期"}到达`,
                sourceEntity: ref("faction", faction.id, faction.name),
                sourceEventId: null,
              },
            ]
          : [],
      ),
    ...(inputs.timelineEvents ?? []).flatMap((event) =>
      typeof event.time === "number"
        ? [
            {
              kind: "timeline-fact" as const,
              time: event.time,
              reason: `正式时间线事件“${event.title}”到达`,
              sourceEntity: ref("world", "world-process", "正式时间线"),
              sourceEventId: event.id,
            },
          ]
        : [],
    ),
  ];
  const next = candidates
    .filter(
      (candidate) =>
        Number.isInteger(candidate.time) &&
        candidate.time > startTime &&
        candidate.time <= scaleEnd &&
        candidate.time <= run.endTime,
    )
    .sort((left, right) => left.time - right.time)[0];
  const endTime = next?.time ?? scaleEnd;
  const following = candidates
    .filter(
      (candidate) =>
        Number.isInteger(candidate.time) &&
        candidate.time > endTime &&
        candidate.time <= run.endTime,
    )
    .sort((left, right) => left.time - right.time)[0];
  const nextBoundary = following
    ? {
        kind: following.kind,
        reason: following.reason,
        scheduledAt: following.time,
        sourceEntity: following.sourceEntity ?? null,
        sourceEventId: following.sourceEventId ?? null,
      }
    : endTime >= run.endTime
      ? null
      : {
          kind: "scale-limit" as const,
          reason: `达到当前${formatSimulationSpan(run.timeScale, run.timeStep)}尺度上限`,
          scheduledAt: Math.min(
            run.endTime,
            endTime + simulationScaleDays(run.timeScale, run.timeStep),
          ),
          sourceEntity: null,
          sourceEventId: null,
        };
  return {
    endTime,
    boundary: {
      kind: next?.kind ?? (endTime >= run.endTime ? "run-end" : "scale-limit"),
      reason:
        next?.reason ??
        (endTime >= run.endTime
          ? "运行终点到达"
          : `达到当前${formatSimulationSpan(run.timeScale, run.timeStep)}尺度上限`),
      scheduledAt: endTime,
      sourceEntity: next?.sourceEntity ?? null,
      sourceEventId: next?.sourceEventId ?? null,
    },
    nextBoundary,
  };
}

function locationForCharacter(
  character: SimulationCharacterSnapshot,
  inputs: SimulationEngineInputs,
): SimulationEntityRef | null {
  if (character.currentLocationId) {
    const location = inputs.locations?.find(
      (item) => item.id === character.currentLocationId,
    );
    return ref(
      "location",
      character.currentLocationId,
      character.currentLocationLabel ??
        location?.name ??
        character.currentLocationId,
    );
  }
  return inputs.observationSpaceId
    ? ref(
        "location",
        inputs.observationSpaceId,
        inputs.observationSpaceLabel ?? inputs.observationSpaceId,
      )
    : null;
}

function timelineEventRefs(
  event: SimulationTimelineSnapshot,
  inputs: SimulationEngineInputs,
): {
  readonly entityRefs: SimulationEntityRef[];
  readonly actorRefs: SimulationEntityRef[];
  readonly locationRef: SimulationEntityRef | null;
} {
  const characters = (event.characterIds ?? [])
    .map((id) => inputs.characters?.find((item) => item.id === id))
    .filter((item): item is SimulationCharacterSnapshot => Boolean(item));
  const factions = (event.factionIds ?? [])
    .map((id) => inputs.factions?.find((item) => item.id === id))
    .filter((item): item is SimulationFactionSnapshot => Boolean(item));
  const locations = (event.locationIds ?? [])
    .map((id) => inputs.locations?.find((item) => item.id === id))
    .filter((item): item is SimulationLocationSnapshot => Boolean(item));
  const actorRefs = [
    ...characters.map((item) => ref("character", item.id, item.name)),
    ...factions.map((item) => ref("faction", item.id, item.name)),
  ];
  const locationRef = locations[0]
    ? ref("location", locations[0].id, locations[0].name)
    : null;
  return {
    actorRefs,
    locationRef,
    entityRefs: [
      ...actorRefs,
      ...locations.map((item) => ref("location", item.id, item.name)),
    ],
  };
}

export function advanceSimulationRun(
  run: SimulationRun,
  inputs: SimulationEngineInputs,
  now = new Date().toISOString(),
): SimulationAdvanceResult {
  if (run.status === "running") throw new Error("当前运行正在进行 AI 推演");
  if (run.currentTime >= run.endTime) throw new Error("当前运行已到达终止时间");
  const index = run.roundsCompleted + 1;
  const startTime = run.currentTime;
  const { endTime, boundary, nextBoundary } = chooseBoundary(run, inputs);
  const round: SimulationRound = {
    id: `${run.id}-round-${index}`,
    index,
    status: "completed",
    startTime,
    endTime,
    eventIds: [],
    narrative: "",
    boundary,
    nextBoundary,
    checkpoint: true,
    createdAt: now,
    completedAt: now,
  };
  const events: SimulationEvent[] = [];
  const periodic = periodicEvents(run, round, inputs, events.length);
  events.push(...periodic);

  const timelineEvents = (inputs.timelineEvents ?? []).filter(
    (event) => event.time === endTime,
  );
  timelineEvents.forEach((timelineEvent) => {
    const refs = timelineEventRefs(timelineEvent, inputs);
    events.push(
      createEvent(run, round.index, events.length, {
        kind: "world-process",
        title: timelineEvent.title,
        summary:
          timelineEvent.summary ||
          `正式时间线事件“${timelineEvent.title}”在本轮到达。`,
        time: endTime,
        certainty: "confirmed",
        source: "rule",
        entityRefs: refs.entityRefs.length
          ? refs.entityRefs
          : [ref("world", "world-process", "正式时间线")],
        actorRefs: refs.actorRefs,
        locationRef: refs.locationRef,
        targetRefs: [],
        triggerFacts: [
          {
            id: `${timelineEvent.id}-fact`,
            label: "正式时间线事实",
            value: timelineEvent.summary || timelineEvent.title,
            sourcePath: `timeline/events/${timelineEvent.id}.json`,
          },
        ],
        decision: "",
        action: "按正式时间线事实进入观察窗口",
        stateChanges: [],
        uncertainty:
          "正式事件的后续影响仍需交给 AI，分别从人物、势力和空间资料继续推演。",
        causeEventIds: [],
        propagations: [],
        ruleIds: ["timeline-fact"],
      }),
    );
  });

  (inputs.characters ?? [])
    .filter(
      (character) =>
        character.alive !== false && character.nextActionTime === endTime,
    )
    .forEach((character) => {
      const actor = ref("character", character.id, character.name);
      const location = locationForCharacter(character, inputs);
      const actionLabel = character.nextActionLabel ?? "当前行动";
      events.push(
        createEvent(run, round.index, events.length, {
          kind: "character-action",
          title: `${character.name}完成${actionLabel}`,
          summary: `${character.name}在${location?.label ?? "未确定地点"}完成“${actionLabel}”；这是由结构化完成时间提供给 AI 的行动边界，后续影响由 AI 继续推演。`,
          time: endTime,
          certainty: "confirmed",
          source: "character",
          entityRefs: [actor, ...(location ? [location] : [])],
          actorRefs: [actor],
          locationRef: location,
          targetRefs: [],
          triggerFacts: [
            {
              id: `${character.id}-action-boundary`,
              label: "行动完成边界",
              value: `${actionLabel}完成时间 = ${endTime}`,
              sourcePath: null,
            },
            ...(character.goals
              ? [
                  {
                    id: `${character.id}-goal`,
                    label: "人物目标",
                    value: character.goals,
                    sourcePath: null,
                  },
                ]
              : []),
            ...(character.motivation
              ? [
                  {
                    id: `${character.id}-motivation`,
                    label: "人物动机",
                    value: character.motivation,
                    sourcePath: null,
                  },
                ]
              : []),
          ],
          decision: character.motivation || "沿当前目标执行已开始行动",
          action: `完成${actionLabel}`,
          stateChanges: [
            {
              entityRef: actor,
              field: "currentAction",
              before: actionLabel,
              after: "已完成",
            },
          ],
          uncertainty:
            "遭遇、知识变化和对他人的影响尚未由 AI 生成，交由 AI 候选层补充。",
          causeEventIds: periodic.map((event) => event.id),
          propagations: [],
          ruleIds: ["character-action", "action-completion"],
        }),
      );
    });

  (inputs.factions ?? [])
    .filter(
      (faction) =>
        faction.alive !== false && faction.nextActionTime === endTime,
    )
    .forEach((faction) => {
      const actor = ref("faction", faction.id, faction.name);
      const locationId = faction.territoryIds?.[0];
      const location = locationId
        ? ref(
            "location",
            locationId,
            faction.territoryLabels?.[0] ??
              inputs.locations?.find((item) => item.id === locationId)?.name ??
              locationId,
          )
        : null;
      const actionLabel = faction.nextActionLabel ?? "战略周期";
      events.push(
        createEvent(run, round.index, events.length, {
          kind: "faction-strategy",
          title: `${faction.name}完成${actionLabel}`,
          summary: `${faction.name}在${location?.label ?? "未确定领地"}完成“${actionLabel}”；时间边界只确认周期到达，战争、外交或资源结果交由 AI 继续推演。`,
          time: endTime,
          certainty: "confirmed",
          source: "faction",
          entityRefs: [actor, ...(location ? [location] : [])],
          actorRefs: [actor],
          locationRef: location,
          targetRefs: [],
          triggerFacts: [
            {
              id: `${faction.id}-strategy-boundary`,
              label: "势力周期边界",
              value: `${actionLabel}到达时间 = ${endTime}`,
              sourcePath: null,
            },
            ...(faction.strategy
              ? [
                  {
                    id: `${faction.id}-strategy`,
                    label: "当前战略",
                    value: faction.strategy,
                    sourcePath: null,
                  },
                ]
              : []),
          ],
          decision: faction.strategy || "按既有战略完成本周期动作",
          action: `完成${actionLabel}`,
          stateChanges: [
            {
              entityRef: actor,
              field: "currentAction",
              before: actionLabel,
              after: "已完成",
            },
          ],
          uncertainty:
            "预算、关系和领土影响尚未由 AI 生成，交由 AI 候选层补充。",
          causeEventIds: periodic.map((event) => event.id),
          propagations: [],
          ruleIds: ["faction-strategy", "action-completion"],
        }),
      );
    });

  if (!events.length) {
    events.push(
      createEvent(run, round.index, 0, {
        kind: "diagnostic",
        title: "本轮 AI 尚未生成具体事件",
        summary: `时间推进至${formatSimulationTime(endTime)}，但当前冻结基线没有在此窗口到期的结构化行动、正式时间线事实或时间边界支持；不会用泛化事件填充结果。`,
        time: endTime,
        certainty: "blocked",
        source: "system",
        entityRefs: [],
        triggerFacts: [
          {
            id: "simulation-boundary",
            label: "本轮边界",
            value: boundary.reason,
            sourcePath: null,
          },
          ...(inputs.diagnostics ?? []).map((diagnostic, position) => ({
            id: `diagnostic-${position}`,
            label: "输入诊断",
            value: diagnostic,
            sourcePath: null,
          })),
        ],
        decision: "不生成没有证据支持的故事",
        action: "保存检查点并等待下一个有意义边界",
        stateChanges: [],
        uncertainty:
          "需要补充结构化行动、正式资料或时间线事实后，AI 才可能生成确定事件。",
        causeEventIds: [],
        propagations: [],
        ruleIds: ["input-diagnostics"],
      }),
    );
  }
  const nextRun: SimulationRun = {
    ...run,
    status: endTime >= run.endTime ? "completed" : "paused",
    currentTime: endTime,
    currentRoundId: round.id,
    roundsCompleted: run.roundsCompleted + 1,
    updatedAt: now,
  };
  const completedRound = {
    ...round,
    eventIds: events.map((event) => event.id),
  };
  return { run: nextRun, round: completedRound, events };
}
