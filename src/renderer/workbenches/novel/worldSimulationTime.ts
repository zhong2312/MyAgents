import type {
  SimulationCalendar,
  TimeScale,
  WorldDuration,
  WorldInstant,
} from "./worldSimulationV2Schema";

const INTEGER_PATTERN = /^-?\d+$/u;

export const TIME_SCALE_LABELS: Readonly<Record<TimeScale, string>> = Object.freeze({
  day: "日",
  month: "月",
  year: "年",
  century: "百年",
  millennium: "千年",
  "ten-thousand-years": "万年",
  "hundred-billion-years": "千亿年",
  "trillion-years": "万亿年",
});

export function parseWorldTick(value: string): bigint {
  if (!INTEGER_PATTERN.test(value)) throw new Error(`无效的世界时间坐标：${value}`);
  return BigInt(value);
}

export function compareWorldTicks(left: string, right: string): number {
  const a = parseWorldTick(left);
  const b = parseWorldTick(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addWorldTicks(value: string, delta: string | bigint): string {
  return (parseWorldTick(value) + (typeof delta === "bigint" ? delta : parseWorldTick(delta))).toString();
}

export function subtractWorldTicks(left: string, right: string): string {
  return (parseWorldTick(left) - parseWorldTick(right)).toString();
}

export function scaleToDays(scale: TimeScale, calendar: SimulationCalendar): bigint {
  const year = BigInt(calendar.daysPerMonth) * BigInt(calendar.monthsPerYear);
  switch (scale) {
    case "day": return 1n;
    case "month": return BigInt(calendar.daysPerMonth);
    case "year": return year;
    case "century": return year * 100n;
    case "millennium": return year * 1_000n;
    case "ten-thousand-years": return year * 10_000n;
    case "hundred-billion-years": return year * 100_000_000_000n;
    case "trillion-years": return year * 1_000_000_000_000n;
  }
}

export function durationToDays(duration: WorldDuration, calendar: SimulationCalendar): bigint {
  const amount = parseWorldTick(duration.amount);
  if (amount <= 0n) throw new Error("推演时长必须大于 0");
  if (duration.unit === "era") {
    return amount * parseWorldTick(calendar.eraYears) * scaleToDays("year", calendar);
  }
  return amount * scaleToDays(duration.unit, calendar);
}

export function formatWorldInstant(sortKey: string, calendar: SimulationCalendar): string {
  const tick = parseWorldTick(sortKey);
  const sign = tick < 0n ? "前" : "第";
  const absolute = tick < 0n ? -tick : tick;
  const yearDays = scaleToDays("year", calendar);
  if (absolute >= yearDays) {
    const years = absolute / yearDays;
    const remainder = absolute % yearDays;
    if (remainder === 0n) return `${sign} ${years.toString()} 年`;
    const month = remainder / BigInt(calendar.daysPerMonth);
    const day = remainder % BigInt(calendar.daysPerMonth);
    return `${sign} ${years.toString()} 年 ${month.toString()} 月 ${day.toString()} 日`;
  }
  return `${sign} ${absolute.toString()} 日`;
}

export function createWorldInstant(
  sortKey: string,
  calendar: SimulationCalendar,
  precision: WorldInstant["precision"] = "exact",
): WorldInstant {
  parseWorldTick(sortKey);
  return {
    calendarId: calendar.id,
    sortKey,
    precision,
    displayText: formatWorldInstant(sortKey, calendar),
  };
}

export function resolveEventScale(stepDays: bigint, calendar: SimulationCalendar): TimeScale {
  const ordered: readonly TimeScale[] = [
    "trillion-years",
    "hundred-billion-years",
    "ten-thousand-years",
    "millennium",
    "century",
    "year",
    "month",
    "day",
  ];
  return ordered.find((scale) => stepDays >= scaleToDays(scale, calendar)) ?? "day";
}

export function chooseAdaptiveStep(
  currentSortKey: string,
  endSortKey: string,
  remainingSteps: number,
  calendar: SimulationCalendar,
): bigint {
  const remaining = parseWorldTick(endSortKey) - parseWorldTick(currentSortKey);
  if (remaining <= 0n) return 0n;
  if (remainingSteps <= 1) return remaining;
  const safeSteps = BigInt(Math.max(1, remainingSteps));
  const target = remaining / safeSteps || 1n;
  const scales: readonly TimeScale[] = [
    "trillion-years",
    "hundred-billion-years",
    "ten-thousand-years",
    "millennium",
    "century",
    "year",
    "month",
    "day",
  ];
  const boundary = scales
    .map((scale) => scaleToDays(scale, calendar))
    .find((days) => days <= target) ?? 1n;
  const proposed = boundary > remaining ? remaining : boundary;
  return proposed > 0n ? proposed : 1n;
}

export function progressRatio(start: string, end: string, current: string): number {
  const total = parseWorldTick(end) - parseWorldTick(start);
  if (total <= 0n) return 1;
  const progressed = parseWorldTick(current) - parseWorldTick(start);
  const scaled = Number((progressed * 10_000n) / total) / 10_000;
  return Math.max(0, Math.min(1, scaled));
}
