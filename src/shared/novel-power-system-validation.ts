import type {
  PowerCatalog,
  PowerConditionGroup,
  PowerConnections,
  PowerEntityReference,
  PowerSystemEntityKind,
  PowerSystemIndex,
  PowerSystemMeta,
  PowerSystemRecord,
} from "./novel-power-system-schema";

export interface PowerSystemLibraryValidationInput {
  readonly meta: PowerSystemMeta;
  readonly index: PowerSystemIndex;
  readonly catalog: PowerCatalog;
  readonly connections: PowerConnections;
  readonly records: ReadonlyMap<string, PowerSystemRecord>;
}

function catalogTargets(catalog: PowerCatalog): Map<string, string> {
  return new Map(
    [
      ...catalog.foundations,
      ...catalog.mediums,
      ...catalog.principles,
      ...catalog.resources,
      ...catalog.theories,
      ...catalog.methods,
      ...catalog.capabilities,
    ].map((item) => [item.id, item.kind] as const),
  );
}

function systemTargets(
  record: PowerSystemRecord,
): Map<string, PowerSystemEntityKind> {
  const targets = new Map<string, PowerSystemEntityKind>([
    [record.id, "system"],
  ]);
  record.tracks.forEach((track) => {
    targets.set(track.id, "track");
    track.states.forEach((state) => targets.set(state.id, "state"));
    track.transitions.forEach((transition) =>
      targets.set(transition.id, "transition"),
    );
  });
  record.dimensions.forEach((dimension) =>
    targets.set(
      dimension.id,
      dimension.category === "quality"
        ? "quality-dimension"
        : "boundary-dimension",
    ),
  );
  return targets;
}

export function validatePowerSystemLibrary(
  input: PowerSystemLibraryValidationInput,
): readonly string[] {
  const errors: string[] = [];
  const typeIds = new Set<string>();
  input.meta.systemTypes.forEach((type) => {
    if (typeIds.has(type.id)) errors.push(`力量体系类型 id 重复：${type.id}`);
    typeIds.add(type.id);
  });

  const systemIds = new Set<string>();
  const targetsBySystem = new Map<string, Map<string, PowerSystemEntityKind>>();
  input.index.systems.forEach((entry) => {
    if (systemIds.has(entry.id)) {
      errors.push(`力量体系索引 id 重复：${entry.id}`);
    }
    systemIds.add(entry.id);
    if (!typeIds.has(entry.typeId)) {
      errors.push(`力量体系“${entry.name}”引用了不存在的类型：${entry.typeId}`);
    }
    if (
      entry.recordPath !== `world/power-systems/records/${entry.id}.json` ||
      entry.pagePath !== `world/power-systems/pages/${entry.id}.md`
    ) {
      errors.push(`力量体系“${entry.name}”的记录或说明路径与 id 不一致`);
    }
    const record = input.records.get(entry.id);
    if (!record) {
      errors.push(`力量体系“${entry.name}”缺少结构化记录`);
      return;
    }
    if (record.id !== entry.id) {
      errors.push(`力量体系“${entry.name}”的索引与记录 id 不一致`);
    }
    if (
      record.name !== entry.name ||
      record.typeId !== entry.typeId ||
      record.status !== entry.status ||
      record.summary !== entry.summary ||
      record.updatedAt !== entry.updatedAt
    ) {
      errors.push(`力量体系“${entry.name}”的索引摘要与记录不一致`);
    }
    if (!typeIds.has(record.typeId)) {
      errors.push(`力量体系“${record.name}”引用了不存在的类型`);
    }
    targetsBySystem.set(entry.id, systemTargets(record));
  });

  const catalogById = catalogTargets(input.catalog);
  const validateReference = (
    reference: PowerEntityReference,
    owner: string,
  ): void => {
    if (reference.namespace === "external") return;
    if (reference.namespace === "catalog") {
      if (catalogById.get(reference.targetId) !== reference.kind) {
        errors.push(
          `${owner}引用了不存在或类型不符的共享对象：${reference.targetId}`,
        );
      }
      return;
    }
    if (!systemIds.has(reference.systemId)) {
      errors.push(`${owner}引用了不存在的力量体系：${reference.systemId}`);
      return;
    }
    if (
      targetsBySystem.get(reference.systemId)?.get(reference.targetId) !==
      reference.kind
    ) {
      errors.push(
        `${owner}引用了不存在或类型不符的体系对象：${reference.targetId}`,
      );
    }
  };
  const validateConditions = (group: PowerConditionGroup, owner: string) => {
    group.clauses.forEach((clause) => {
      if (clause.subjectRef) {
        validateReference(clause.subjectRef, `${owner}的条件“${clause.id}”`);
      }
    });
  };

  input.catalog.theories.forEach((theory) =>
    theory.substrateRefs.forEach((reference) =>
      validateReference(reference, `理论“${theory.name}”`),
    ),
  );
  input.catalog.methods.forEach((method) =>
    method.theoryRefs.forEach((reference) =>
      validateReference(reference, `发展方法“${method.name}”`),
    ),
  );

  input.index.systems.forEach((entry) => {
    const record = input.records.get(entry.id);
    if (!record) return;
    const dimensions = new Map(
      record.dimensions.map(
        (dimension) => [dimension.id, dimension.category] as const,
      ),
    );
    record.tracks.forEach((track) => {
      track.states.forEach((state) => {
        validateConditions(
          state.contract.entryConditions,
          `状态“${state.name}”的进入条件`,
        );
        validateConditions(
          state.contract.maintenanceConditions,
          `状态“${state.name}”的维持条件`,
        );
        validateConditions(
          state.contract.exitConditions,
          `状态“${state.name}”的退出条件`,
        );
        state.contract.baseQualities.forEach((value) => {
          if (dimensions.get(value.dimensionId) !== "quality") {
            errors.push(
              `状态“${state.name}”的质量值引用了不存在或类型不符的维度：${value.dimensionId}`,
            );
          }
        });
        state.contract.baseBoundaries.forEach((value) => {
          if (dimensions.get(value.dimensionId) !== "boundary") {
            errors.push(
              `状态“${state.name}”的边界值引用了不存在或类型不符的维度：${value.dimensionId}`,
            );
          }
        });
      });
      track.transitions.forEach((transition) =>
        validateConditions(transition.conditions, `转换“${transition.name}”`),
      );
    });
  });

  input.connections.connections.forEach((connection) => {
    const owner = `连接“${connection.id}”`;
    validateReference(connection.source, owner);
    validateReference(connection.target, owner);
    validateConditions(connection.conditions, owner);
    if (connection.kind === "method-application") {
      if (connection.theoryRef) validateReference(connection.theoryRef, owner);
      const targetRecord =
        connection.target.namespace === "system"
          ? input.records.get(connection.target.systemId)
          : undefined;
      const dimensions = new Map(
        (targetRecord?.dimensions ?? []).map(
          (dimension) => [dimension.id, dimension.category] as const,
        ),
      );
      connection.qualityEffects.forEach((effect) => {
        if (dimensions.get(effect.dimensionId) !== "quality") {
          errors.push(
            `${owner}的质量效果引用了不存在或类型不符的维度：${effect.dimensionId}`,
          );
        }
      });
      connection.boundaryEffects.forEach((effect) => {
        if (dimensions.get(effect.dimensionId) !== "boundary") {
          errors.push(
            `${owner}的边界效果引用了不存在或类型不符的维度：${effect.dimensionId}`,
          );
        }
      });
    }
    if (connection.kind === "resource-requirement") {
      connection.substituteRefs.forEach((reference) =>
        validateReference(reference, `${owner}的替代资源`),
      );
    }
  });

  return errors;
}
