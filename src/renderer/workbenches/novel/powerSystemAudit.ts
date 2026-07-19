import type { PowerSystemRecord } from "./powerSystemSchema";

export interface PowerSystemAuditIssue {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  readonly targetKind?: "system" | "element" | "track" | "rule" | "dimension";
  readonly targetId?: string;
}

export function auditPowerSystem(
  record: PowerSystemRecord,
): readonly PowerSystemAuditIssue[] {
  const issues: PowerSystemAuditIssue[] = [];
  const origins = record.elements.filter((item) => item.kind === "origin");
  const capabilities = record.elements.filter(
    (item) => item.kind === "capability",
  );

  if (
    record.designContract.explanation === "explicit" &&
    origins.length === 0
  ) {
    issues.push({
      id: "missing-origin",
      severity: "warning",
      title: "缺少力量来源",
      detail: "体系声明为明确解释，但尚未定义力量从哪里产生。",
      targetKind: "system",
      targetId: record.id,
    });
  }
  if (
    record.designContract.progression !== "none" &&
    record.tracks.length === 0
  ) {
    issues.push({
      id: "missing-track",
      severity: "error",
      title: "缺少状态轨道",
      detail: "体系声明存在成长结构，但没有任何状态轨道。",
      targetKind: "system",
      targetId: record.id,
    });
  }
  if (
    record.designContract.progression === "single-track" &&
    record.tracks.length > 1
  ) {
    issues.push({
      id: "too-many-tracks",
      severity: "error",
      title: "状态轨道超过设计契约",
      detail: "体系声明为单轨成长，但当前存在多条状态轨道。",
      targetKind: "system",
      targetId: record.id,
    });
  }

  record.tracks.forEach((track) => {
    if (track.states.length === 0) {
      issues.push({
        id: `empty-track-${track.id}`,
        severity: "warning",
        title: `“${track.name}”没有状态`,
        detail: "空轨道不会为人物提供任何可引用的状态。",
        targetKind: "track",
        targetId: track.id,
      });
      return;
    }
    const incoming = new Set(track.transitions.map((item) => item.toStateId));
    const orderedStates = [...track.states].sort(
      (left, right) => left.order - right.order,
    );
    orderedStates.slice(1).forEach((state) => {
      if (!incoming.has(state.id) && track.mode !== "unordered") {
        issues.push({
          id: `unreachable-${track.id}-${state.id}`,
          severity: "warning",
          title: `状态“${state.name}”不可达`,
          detail: `轨道“${track.name}”中没有任何转换进入该状态。`,
          targetKind: "track",
          targetId: track.id,
        });
      }
    });
  });

  if (record.designContract.costPolicy !== "optional") {
    capabilities.forEach((capability) => {
      const scopedCosts = record.rules.some(
        (rule) =>
          rule.costs.length > 0 &&
          (rule.scopeElementIds.length === 0 ||
            rule.scopeElementIds.includes(capability.id)),
      );
      const resourceRelation = record.relations.some(
        (relation) =>
          relation.toId === capability.id &&
          (relation.kind === "consumes" || relation.kind === "requires"),
      );
      if (!scopedCosts && !resourceRelation) {
        issues.push({
          id: `costless-${capability.id}`,
          severity:
            record.designContract.costPolicy === "required" ? "error" : "info",
          title: `能力“${capability.name}”没有成本约束`,
          detail: "尚未发现资源消耗、前置需求或带代价的适用规则。",
          targetKind: "element",
          targetId: capability.id,
        });
      }
    });
  }

  record.rules.forEach((rule) => {
    if (rule.effects.length === 0) {
      issues.push({
        id: `effectless-rule-${rule.id}`,
        severity: "warning",
        title: `规则“${rule.name}”没有结果`,
        detail: "规则可以保留未知条件，但至少需要描述成立后的结果。",
        targetKind: "rule",
        targetId: rule.id,
      });
    }
    if (
      rule.metadata.authority === "exception" &&
      rule.conditions.clauses.length === 0
    ) {
      issues.push({
        id: `unconditional-exception-${rule.id}`,
        severity: "error",
        title: `例外规则“${rule.name}”缺少触发条件`,
        detail: "无条件例外会覆盖体系默认规则，必须明确何时成立。",
        targetKind: "rule",
        targetId: rule.id,
      });
    }
  });

  record.benchmarks.forEach((benchmark) => {
    benchmark.values.forEach((value) => {
      if (
        value.minimum !== null &&
        value.maximum !== null &&
        value.minimum > value.maximum
      ) {
        issues.push({
          id: `invalid-range-${benchmark.id}-${value.dimensionId}`,
          severity: "error",
          title: `标尺“${benchmark.name}”区间颠倒`,
          detail: "维度下限不能高于上限。",
          targetKind: "dimension",
          targetId: value.dimensionId,
        });
      }
    });
  });

  if (issues.length === 0) {
    issues.push({
      id: "audit-clean",
      severity: "info",
      title: "未发现结构性问题",
      detail: "当前结果只代表结构与设计契约一致，仍需作者判断叙事效果。",
    });
  }
  return issues;
}
