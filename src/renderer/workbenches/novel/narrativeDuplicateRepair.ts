import type {
  NarrativeEngineering,
  PlotLine,
  StoryArc,
} from "./narrativeEngineeringSchema";

export interface NarrativeDuplicateRepairPlan {
  readonly lineIdMap: ReadonlyMap<string, string>;
  readonly arcIdMap: ReadonlyMap<string, string>;
}

function sameLineIdentity(left: PlotLine, right: PlotLine): boolean {
  return (
    left.title === right.title &&
    left.kind === right.kind &&
    left.storyRole === right.storyRole &&
    left.protagonistCharacterId === right.protagonistCharacterId &&
    left.premise === right.premise
  );
}

function sameArcIdentity(
  left: StoryArc,
  right: StoryArc,
  lineIdMap: ReadonlyMap<string, string>,
): boolean {
  const normalizedRightLineIds = right.lineIds.map(
    (lineId) => lineIdMap.get(lineId) ?? lineId,
  );
  return (
    left.title === right.title &&
    left.kind === right.kind &&
    left.characterId === right.characterId &&
    left.characterArcStageId === right.characterArcStageId &&
    left.characterArcStageTitle === right.characterArcStageTitle &&
    left.lineIds.length === normalizedRightLineIds.length &&
    left.lineIds.every(
      (lineId, index) => lineId === normalizedRightLineIds[index],
    )
  );
}

/**
 * Identifies the specific legacy failure mode where an AI proposal duplicated an
 * existing empty-node record instead of updating it. Both records must otherwise
 * describe the same object, so intentional same-title records are never merged.
 */
export function planNarrativeDuplicateRepair(
  library: NarrativeEngineering,
): NarrativeDuplicateRepairPlan {
  const lineIdMap = new Map<string, string>();
  for (const legacy of library.lines.filter(
    (line) => line.keyNodes.length === 0,
  )) {
    const duplicate = library.lines.find(
      (candidate) =>
        candidate.id !== legacy.id &&
        candidate.keyNodes.length > 0 &&
        !lineIdMap.has(candidate.id) &&
        sameLineIdentity(legacy, candidate),
    );
    if (duplicate) lineIdMap.set(duplicate.id, legacy.id);
  }

  const arcIdMap = new Map<string, string>();
  for (const legacy of library.arcs.filter((arc) => arc.keyNodes.length === 0)) {
    const duplicate = library.arcs.find(
      (candidate) =>
        candidate.id !== legacy.id &&
        candidate.keyNodes.length > 0 &&
        !arcIdMap.has(candidate.id) &&
        sameArcIdentity(legacy, candidate, lineIdMap),
    );
    if (duplicate) arcIdMap.set(duplicate.id, legacy.id);
  }

  return { lineIdMap, arcIdMap };
}

export function hasNarrativeDuplicateRepair(
  plan: NarrativeDuplicateRepairPlan,
): boolean {
  return plan.lineIdMap.size > 0 || plan.arcIdMap.size > 0;
}

function replaceIds(
  ids: readonly string[],
  replacements: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(ids.map((id) => replacements.get(id) ?? id))];
}

export function applyNarrativeDuplicateRepair(
  library: NarrativeEngineering,
  plan = planNarrativeDuplicateRepair(library),
): NarrativeEngineering {
  if (!hasNarrativeDuplicateRepair(plan)) return library;

  const enrichedLines = new Map(
    [...plan.lineIdMap].map(([duplicateId, legacyId]) => [
      legacyId,
      library.lines.find((line) => line.id === duplicateId)!,
    ]),
  );
  const enrichedArcs = new Map(
    [...plan.arcIdMap].map(([duplicateId, legacyId]) => [
      legacyId,
      library.arcs.find((arc) => arc.id === duplicateId)!,
    ]),
  );

  return {
    ...library,
    lines: library.lines
      .filter((line) => !plan.lineIdMap.has(line.id))
      .map((line) => {
        const enriched = enrichedLines.get(line.id);
        return enriched ? { ...line, keyNodes: enriched.keyNodes } : line;
      }),
    arcs: library.arcs
      .filter((arc) => !plan.arcIdMap.has(arc.id))
      .map((arc) => {
        const enriched = enrichedArcs.get(arc.id);
        return {
          ...(enriched ? { ...arc, keyNodes: enriched.keyNodes } : arc),
          lineIds: replaceIds(arc.lineIds, plan.lineIdMap),
        };
      }),
    chapters: library.chapters.map((chapter) => ({
      ...chapter,
      lineIds: replaceIds(chapter.lineIds, plan.lineIdMap),
      arcIds: replaceIds(chapter.arcIds, plan.arcIdMap),
      sections: chapter.sections.map((section) => ({
        ...section,
        lineIds: replaceIds(section.lineIds, plan.lineIdMap),
        arcIds: replaceIds(section.arcIds, plan.arcIdMap),
      })),
    })),
  };
}
