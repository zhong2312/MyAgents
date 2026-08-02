import type { CharacterRecord } from "../../../shared/workbenches/novel/characterLibrarySchema";
import type { FactionRecord } from "./factionLibrarySchema";

/**
 * 世界推演结果落库闭环：把引擎返回的 stateChanges（entityId/field/before/after）
 * 解析为可写入人物库/势力库的结构化变更。
 *
 * 规则：
 * - entityId 前缀 `character-` → 人物；`faction-` → 势力；其他实体（如“世界”）
 *   暂不支持自动采纳，返回不可采纳原因。
 * - field 经归一化后必须在目标库的可写字段白名单内，否则拒绝（防脏写）。
 * - after 必须是字符串（引擎返回的自由字段可能是任意 JSON，只有标量可写）。
 */

export interface StateChangeAdoption {
  readonly kind: "character" | "faction";
  /** 去掉前缀后的库内 id。 */
  readonly targetId: string;
  /** 归一化后的库字段名（faction 的 state 子字段以 `state.` 前缀表达）。 */
  readonly field: string;
  readonly after: string;
  readonly before: string | null;
}

export type AdoptionResolution =
  | { readonly ok: true; readonly adoption: StateChangeAdoption }
  | { readonly ok: false; readonly reason: string };

const CHARACTER_WRITABLE: ReadonlyMap<string, string> = new Map([
  ["status", "status"],
  ["summary", "summary"],
  ["currentrealm", "currentRealm"],
  ["goals", "goals"],
  ["motivation", "motivation"],
  ["hometown", "hometown"],
  ["personality", "personality"],
  ["values", "values"],
  ["strengths", "strengths"],
  ["weaknesses", "weaknesses"],
  ["fears", "fears"],
  ["innerconflict", "innerConflict"],
  ["background", "background"],
  ["abilities", "abilities"],
  ["storyrole", "storyRole"],
  ["arc", "arc"],
  ["firstappearance", "firstAppearance"],
  ["archetype", "archetype"],
  ["alignment", "alignment"],
  ["age", "age"],
  ["alias", "alias"],
]);

const FACTION_WRITABLE: ReadonlyMap<string, string> = new Map([
  ["status", "status"],
  ["summary", "summary"],
  ["state.governance", "state.governance"],
  ["state.military", "state.military"],
  ["state.economy", "state.economy"],
  ["state.publicsupport", "state.publicSupport"],
  ["state.territorialintegrity", "state.territorialIntegrity"],
]);

/** 引擎可能直接给出不带 state. 前缀的势力状态子字段，归一化时自动补齐。 */
const FACTION_STATE_SUBFIELD: ReadonlyMap<string, string> = new Map([
  ["governance", "governance"],
  ["military", "military"],
  ["economy", "economy"],
  ["publicsupport", "publicSupport"],
  ["territorialintegrity", "territorialIntegrity"],
]);

function normalizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

export function resolveStateChangeAdoption(change: {
  readonly entityId?: unknown;
  readonly field?: unknown;
  readonly after?: unknown;
  readonly before?: unknown;
}): AdoptionResolution {
  const entityId = typeof change.entityId === "string" ? change.entityId : "";
  const after = scalarText(change.after);
  if (after === null) {
    return { ok: false, reason: "变更结果不是可写文本" };
  }
  const before = scalarText(change.before);
  const normalized = normalizeField(change.field);

  if (entityId.startsWith("character-")) {
    const targetId = entityId.slice("character-".length);
    if (!targetId) return { ok: false, reason: "人物 id 为空" };
    const field = CHARACTER_WRITABLE.get(normalized);
    if (!field) {
      return { ok: false, reason: `人物字段“${normalized}”不可采纳` };
    }
    return {
      ok: true,
      adoption: {
        kind: "character",
        targetId,
        field,
        after,
        before,
      },
    };
  }

  if (entityId.startsWith("faction-")) {
    const targetId = entityId.slice("faction-".length);
    if (!targetId) return { ok: false, reason: "势力 id 为空" };
    const field =
      FACTION_WRITABLE.get(normalized) ??
      (FACTION_STATE_SUBFIELD.has(normalized)
        ? `state.${FACTION_STATE_SUBFIELD.get(normalized)}`
        : undefined);
    if (!field) {
      return { ok: false, reason: `势力字段“${normalized}”不可采纳` };
    }
    return {
      ok: true,
      adoption: {
        kind: "faction",
        targetId,
        field,
        after,
        before,
      },
    };
  }

  return { ok: false, reason: "实体不属于人物或势力，暂不支持自动采纳" };
}

export function applyAdoptionToCharacter(
  character: CharacterRecord,
  field: string,
  value: string,
): CharacterRecord {
  return { ...character, [field]: value };
}

export function applyAdoptionToFaction(
  faction: FactionRecord,
  field: string,
  value: string,
): FactionRecord {
  if (field.startsWith("state.")) {
    const key = field.slice("state.".length) as keyof FactionRecord["state"];
    return {
      ...faction,
      state: { ...faction.state, [key]: value },
      updatedAt: new Date().toISOString(),
    };
  }
  return { ...faction, [field]: value, updatedAt: new Date().toISOString() };
}
