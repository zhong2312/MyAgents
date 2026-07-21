import type {
  PowerCatalog,
  PowerConnection,
  PowerConnections,
  PowerEntityReference,
  PowerSystemRecord,
} from "./powerSystemSchema";

export interface PowerSystemAuditIssue {
  readonly id: string;
  readonly severity: "error" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  readonly targetKind?:
    | "system"
    | "track"
    | "state"
    | "transition"
    | "dimension"
    | "catalog"
    | "connection";
  readonly targetId?: string;
}

function catalogEntityIds(catalog: PowerCatalog): Set<string> {
  return new Set([
    ...catalog.foundations.map((item) => item.id),
    ...catalog.mediums.map((item) => item.id),
    ...catalog.principles.map((item) => item.id),
    ...catalog.resources.map((item) => item.id),
    ...catalog.theories.map((item) => item.id),
    ...catalog.methods.map((item) => item.id),
    ...catalog.capabilities.map((item) => item.id),
  ]);
}

function systemEntityIds(record: PowerSystemRecord): Set<string> {
  return new Set([
    record.id,
    ...record.dimensions.map((item) => item.id),
    ...record.tracks.flatMap((track) => [
      track.id,
      ...track.states.map((state) => state.id),
      ...track.transitions.map((transition) => transition.id),
    ]),
  ]);
}

function referenceExists(
  reference: PowerEntityReference,
  record: PowerSystemRecord,
  catalogIds: ReadonlySet<string>,
  systemIds: ReadonlySet<string>,
): boolean {
  if (reference.namespace === "catalog") {
    return catalogIds.has(reference.targetId);
  }
  if (reference.namespace === "external") return true;
  if (!systemIds.has(reference.systemId)) return false;
  if (reference.systemId !== record.id) return true;
  return systemEntityIds(record).has(reference.targetId);
}

function connectionTouchesSystem(
  connection: PowerConnection,
  systemId: string,
): boolean {
  return [connection.source, connection.target].some(
    (reference) =>
      reference.namespace === "system" && reference.systemId === systemId,
  );
}

export function auditPowerSystem(
  record: PowerSystemRecord,
  catalog: PowerCatalog,
  connections: PowerConnections,
  systemIds: ReadonlySet<string>,
): readonly PowerSystemAuditIssue[] {
  const issues: PowerSystemAuditIssue[] = [];
  const catalogIds = catalogEntityIds(catalog);
  const localConnections = connections.connections.filter((connection) =>
    connectionTouchesSystem(connection, record.id),
  );
  const relevantCatalogIds = new Set(
    localConnections.flatMap((connection) =>
      [connection.source, connection.target]
        .filter((reference) => reference.namespace === "catalog")
        .map((reference) => reference.targetId),
    ),
  );
  catalog.methods
    .filter((method) => relevantCatalogIds.has(method.id))
    .forEach((method) =>
      method.theoryRefs.forEach((reference) =>
        relevantCatalogIds.add(reference.targetId),
      ),
    );

  if (
    record.designContract.progression !== "none" &&
    record.tracks.length === 0
  ) {
    issues.push({
      id: "missing-progression-track",
      severity: "error",
      title: "缺少成长轨道",
      detail: "体系声明存在成长结构，但没有任何境界、等级、形态或控制轨道。",
      targetKind: "system",
      targetId: record.id,
    });
  }
  if (
    record.designContract.progression === "single-track" &&
    record.tracks.length > 1
  ) {
    issues.push({
      id: "too-many-progression-tracks",
      severity: "error",
      title: "成长轨道超过设计契约",
      detail: "体系声明为单轨成长，但当前存在多条成长轨道。",
      targetKind: "system",
      targetId: record.id,
    });
  }

  const qualityDimensions = new Set(
    record.dimensions
      .filter((dimension) => dimension.category === "quality")
      .map((dimension) => dimension.id),
  );
  const boundaryDimensions = new Set(
    record.dimensions
      .filter((dimension) => dimension.category === "boundary")
      .map((dimension) => dimension.id),
  );

  record.tracks.forEach((track) => {
    if (track.states.length === 0) {
      issues.push({
        id: `empty-track-${track.id}`,
        severity: "warning",
        title: `成长轨道“${track.name}”没有状态`,
        detail: "空轨道无法表达修炼境界、异能控制阶段、魔法等级或形态变化。",
        targetKind: "track",
        targetId: track.id,
      });
      return;
    }
    const incoming = new Set(
      track.transitions.map((transition) => transition.toStateId),
    );
    [...track.states]
      .sort((left, right) => left.order - right.order)
      .slice(1)
      .forEach((state) => {
        if (!incoming.has(state.id) && track.mode !== "unordered") {
          issues.push({
            id: `unreachable-state-${track.id}-${state.id}`,
            severity: "warning",
            title: `状态“${state.name}”不可达`,
            detail: `轨道“${track.name}”中没有任何转换进入该状态。`,
            targetKind: "state",
            targetId: state.id,
          });
        }
      });

    track.states.forEach((state) => {
      if (
        record.designContract.theoryPolicy === "explicit" &&
        state.contract.cognition.representationType === "unknown"
      ) {
        issues.push({
          id: `state-cognition-unknown-${state.id}`,
          severity: "warning",
          title: `状态“${state.name}”缺少认知或控制模型`,
          detail:
            "显式理论体系应说明进入这一状态需要怎样的记忆、空间、算法、身体或情绪控制模式。",
          targetKind: "state",
          targetId: state.id,
        });
      }
      if (
        boundaryDimensions.size > 0 &&
        state.contract.baseBoundaries.length === 0
      ) {
        issues.push({
          id: `state-boundary-empty-${state.id}`,
          severity: "warning",
          title: `状态“${state.name}”没有能力边界`,
          detail: "至少应描述储量、吞吐、范围、持续时间或承载能力中的一项。",
          targetKind: "state",
          targetId: state.id,
        });
      }
      state.contract.baseQualities.forEach((value) => {
        if (!qualityDimensions.has(value.dimensionId)) {
          issues.push({
            id: `state-quality-kind-${state.id}-${value.dimensionId}`,
            severity: "error",
            title: `状态“${state.name}”错误使用了边界维度`,
            detail: `“${value.dimensionId}”不是质量维度。`,
            targetKind: "state",
            targetId: state.id,
          });
        }
      });
      state.contract.baseBoundaries.forEach((value) => {
        if (!boundaryDimensions.has(value.dimensionId)) {
          issues.push({
            id: `state-boundary-kind-${state.id}-${value.dimensionId}`,
            severity: "error",
            title: `状态“${state.name}”错误使用了质量维度`,
            detail: `“${value.dimensionId}”不是边界维度。`,
            targetKind: "state",
            targetId: state.id,
          });
        }
      });
    });

    track.transitions.forEach((transition) => {
      if (transition.outcomes.length === 0) {
        issues.push({
          id: `transition-without-outcome-${transition.id}`,
          severity: "warning",
          title: `转换“${transition.name}”没有成功结果`,
          detail: "突破、觉醒、升级或变形应说明成功后发生什么。",
          targetKind: "transition",
          targetId: transition.id,
        });
      }
    });
  });

  const theoryIds = new Set(catalog.theories.map((theory) => theory.id));
  catalog.methods
    .filter((method) => relevantCatalogIds.has(method.id))
    .forEach((method) => {
      if (
        record.designContract.theoryPolicy === "explicit" &&
        method.theoryRefs.length === 0
      ) {
        issues.push({
          id: `method-without-theory-${method.id}`,
          severity: "warning",
          title: `发展方法“${method.name}”没有理论模型`,
          detail:
            "显式理论体系中的功法、冥想、训练或改造流程应说明为什么有效。",
          targetKind: "catalog",
          targetId: method.id,
        });
      }
      method.theoryRefs.forEach((reference) => {
        if (!theoryIds.has(reference.targetId)) {
          issues.push({
            id: `method-theory-missing-${method.id}-${reference.targetId}`,
            severity: "error",
            title: `发展方法“${method.name}”引用了不存在的理论`,
            detail: `理论 ID “${reference.targetId}”不在共享目录中。`,
            targetKind: "catalog",
            targetId: method.id,
          });
        }
      });
    });

  catalog.theories
    .filter((theory) => relevantCatalogIds.has(theory.id))
    .forEach((theory) => {
      if (
        theory.operations.length === 0 &&
        theory.representationType !== "unknown"
      ) {
        issues.push({
          id: `theory-without-operation-${theory.id}`,
          severity: "warning",
          title: `理论“${theory.name}”没有基础操作`,
          detail:
            "补充循环、压缩、转换、共振、自组织等操作，才能解释方法的运行过程。",
          targetKind: "catalog",
          targetId: theory.id,
        });
      }
    });

  catalog.capabilities
    .filter((capability) => relevantCatalogIds.has(capability.id))
    .forEach((capability) => {
      if (!capability.effect.trim()) {
        issues.push({
          id: `capability-without-effect-${capability.id}`,
          severity: "error",
          title: `能力“${capability.name}”没有效果`,
          detail: "能力必须说明它改变了什么，才能参与因果、边界和反制检查。",
          targetKind: "catalog",
          targetId: capability.id,
        });
      }
      if (
        capability.limitations.length === 0 &&
        capability.countermeasures.length === 0
      ) {
        issues.push({
          id: `capability-without-boundary-${capability.id}`,
          severity: "warning",
          title: `能力“${capability.name}”缺少限制或反制`,
          detail:
            "能力至少应有适用边界、副作用、资源成本或可被利用的反制方式。",
          targetKind: "catalog",
          targetId: capability.id,
        });
      }
    });

  localConnections.forEach((connection) => {
    for (const endpoint of [connection.source, connection.target]) {
      if (!referenceExists(endpoint, record, catalogIds, systemIds)) {
        issues.push({
          id: `connection-reference-${connection.id}-${endpoint.targetId}`,
          severity: "error",
          title: `连接“${connection.id}”存在失效引用`,
          detail: `对象 ID “${endpoint.targetId}”不存在或不属于指定体系。`,
          targetKind: "connection",
          targetId: connection.id,
        });
      }
    }
    if (
      connection.kind === "method-application" &&
      !connection.executionModel.trim()
    ) {
      issues.push({
        id: `method-application-model-${connection.id}`,
        severity: "warning",
        title: "方法应用缺少具体执行模型",
        detail: "同一方法在不同状态可能采用不同路径、法阵、训练或控制模型。",
        targetKind: "connection",
        targetId: connection.id,
      });
    }
    if (
      connection.kind === "resource-requirement" &&
      connection.amount.minimum !== null &&
      connection.amount.maximum !== null &&
      connection.amount.minimum > connection.amount.maximum
    ) {
      issues.push({
        id: `resource-range-${connection.id}`,
        severity: "error",
        title: "资源需求区间颠倒",
        detail: "资源最小需求不能高于最大需求。",
        targetKind: "connection",
        targetId: connection.id,
      });
    }
  });

  return issues;
}
