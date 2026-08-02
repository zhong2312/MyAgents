import { describe, expect, it } from "vitest";

import type { CharacterRecord } from "../../../shared/workbenches/novel/characterLibrarySchema";
import type { FactionRecord } from "./factionLibrarySchema";

import {
  applyAdoptionToCharacter,
  applyAdoptionToFaction,
  resolveStateChangeAdoption,
} from "./worldSimulationAdoption";

describe("resolveStateChangeAdoption", () => {
  it("把人物状态变更解析为可采纳的人物字段写入", () => {
    const result = resolveStateChangeAdoption({
      entityId: "character-actor-1",
      field: "currentRealm",
      before: "筑基",
      after: "金丹",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adoption).toMatchObject({
      kind: "character",
      targetId: "actor-1",
      field: "currentRealm",
      after: "金丹",
      before: "筑基",
    });
  });

  it("把势力状态子字段解析为 state 前缀字段", () => {
    const result = resolveStateChangeAdoption({
      entityId: "faction-faction-1",
      field: "publicSupport",
      before: "高",
      after: "低",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adoption).toMatchObject({
      kind: "faction",
      targetId: "faction-1",
      field: "state.publicSupport",
      after: "低",
    });
  });

  it("拒绝非人物/势力实体", () => {
    const result = resolveStateChangeAdoption({
      entityId: "world",
      field: "season",
      before: "春",
      after: "夏",
    });
    expect(result.ok).toBe(false);
  });

  it("拒绝不在白名单的字段与不可写结果", () => {
    expect(
      resolveStateChangeAdoption({
        entityId: "character-actor-1",
        field: "secrets",
        before: null,
        after: "密谋",
      }).ok,
    ).toBe(false);
    expect(
      resolveStateChangeAdoption({
        entityId: "character-actor-1",
        field: "goals",
        before: null,
        after: { nested: true },
      }).ok,
    ).toBe(false);
  });
});

describe("applyAdoptionTo*", () => {
  const character = {
    id: "actor-1",
    name: "陆沉渊",
    status: "",
    summary: "",
    currentRealm: "筑基",
    goals: "",
    motivation: "",
    alias: "",
    roleWeight: "main",
    archetype: "",
    alignment: "",
    identities: [],
    age: "",
    realmProgressNodes: [],
    baseLifespan: "",
    lifespanLoss: "",
    spiritRoot: "",
    daoBody: "",
    cultivationMethod: "",
    cultivationProfile: {
      systemId: null,
      trackId: null,
      levelId: null,
      methodIds: [],
      abilityIds: [],
      resourceBalances: {},
      activeConstraintIds: [],
      breakthroughHistory: [],
    },
    gender: "",
    raceId: "",
    soulId: "",
    groupIds: [],
    hometown: "",
    appearance: "",
    personality: "",
    values: "",
    strengths: "",
    weaknesses: "",
    fears: "",
    innerConflict: "",
    background: "",
    abilities: "",
    speechStyle: "",
    habits: "",
    signatureItem: "",
    storyRole: "",
    arc: "",
    firstAppearance: "",
    completeness: 0,
    relations: [],
    appearances: [],
    arcStages: [],
    inventory: [],
  } as CharacterRecord;

  it("更新人物字段并保留其余内容", () => {
    const next = applyAdoptionToCharacter(character, "currentRealm", "金丹");
    expect(next.currentRealm).toBe("金丹");
    expect(next.name).toBe("陆沉渊");
    expect(next.goals).toBe("");
  });

  const faction = {
    id: "faction-1",
    name: "镇夜司",
    type: "",
    status: "active",
    summary: "",
    state: {
      governance: "",
      military: "",
      economy: "",
      publicSupport: "高",
      territorialIntegrity: "",
    },
    territories: [],
    members: [],
    assets: [],
    resources: [],
    organizationUnits: [],
    relations: [],
    rights: [],
    links: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as FactionRecord;

  it("更新势力 state 子字段并保留其余内容", () => {
    const next = applyAdoptionToFaction(
      faction,
      "state.publicSupport",
      "低",
    );
    expect(next.state.publicSupport).toBe("低");
    expect(next.name).toBe("镇夜司");
    expect(next.status).toBe("active");
  });
});
