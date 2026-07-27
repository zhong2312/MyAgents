import type {
  AuditIssue,
  CultivationEcology,
  ResourceRequirement,
  CultivationSystem,
} from "../../../shared/novel-cultivation-ecology-schema";

type IssueTarget =
  | "system"
  | "theory"
  | "method"
  | "topology"
  | "level"
  | "level-stage"
  | "resource"
  | "ability"
  | "formation"
  | "transition"
  | "foundation"
  | "constraint"
  | "relation";

export interface CultivationAuditOptions {
  readonly itemIds?: ReadonlySet<string>;
}

export function calculateCultivationCompleteness(
  system: CultivationSystem,
): number {
  const levels = system.progressionTracks.reduce(
    (total, track) => total + track.levels.length,
    0,
  );
  const topologyCount = system.methods.reduce(
    (total, method) => total + method.operationTopologies.length,
    0,
  );
  const core =
    [
      system.projection.originIds.length > 0,
      system.projection.manifestationIds.length > 0,
      system.progressionTracks.length > 0,
      levels > 0,
    ].filter(Boolean).length / 4;
  const structure =
    [
      Boolean(system.theoryModel.statement.trim()),
      system.theoryModel.nodeCatalog.length > 0,
      system.resources.length > 0,
      system.transitions.length > 0 ||
        system.progressionTracks.some((track) => track.transitions.length > 0),
      topologyCount > 0,
    ].filter(Boolean).length / 5;
  const extension =
    [
      system.formations.length > 0,
      system.foundations.length > 0,
      system.constraints.length > 0,
      system.methods.some((method) => method.courses.length > 0),
    ].filter(Boolean).length / 4;
  const narrative =
    system.summary.trim() &&
    system.constraints.some((constraint) => constraint.narrativePrompt?.trim())
      ? 1
      : 0;
  const fieldQuality =
    [
      Boolean(system.projection.access.trim()),
      Boolean(system.projection.translation.trim()),
      system.methods.some(
        (method) => method.formula.trim() && method.coverage.startLevelId,
      ),
      system.abilities.some(
        (ability) => ability.effect.trim() && ability.cast.amount.trim(),
      ),
      system.resources.some(
        (resource) => resource.summary.trim() && resource.supply.trim(),
      ),
    ].filter(Boolean).length / 5;
  return Math.round(
    core * 35 +
      structure * 30 +
      extension * 15 +
      fieldQuality * 10 +
      narrative * 10,
  );
}

function buildIssue(
  systemId: string,
  index: number,
  severity: AuditIssue["severity"],
  targetType: IssueTarget,
  targetId: string | null,
  title: string,
  message: string,
  suggestion: string,
  fingerprint?: string,
): AuditIssue {
  return {
    id: `${systemId}-audit-${index}`,
    fingerprint:
      fingerprint ?? `${targetType}:${targetId ?? ""}:${title}:${message}`,
    severity,
    targetType,
    targetId,
    title,
    message,
    suggestion,
    resolved: false,
  };
}

function collectCultivationSystemAssetIds(
  system: CultivationSystem,
): ReadonlySet<string> {
  return new Set([
    system.id,
    ...system.theoryModel.nodeCatalog.map((node) => node.id),
    ...system.progressionTracks.flatMap((track) => [
      track.id,
      ...track.metrics.map((metric) => metric.id),
      ...track.levels.flatMap((level) => [
        level.id,
        ...level.subStages.map((stage) => stage.id),
      ]),
      ...track.transitions.flatMap((transition) => [
        transition.id,
        ...transition.methodIds,
      ]),
    ]),
    ...(system.trackInteractions ?? []).map((interaction) => interaction.id),
    ...system.resources.flatMap((resource) => [
      resource.id,
      ...resource.grades.map((grade) => grade.id),
    ]),
    ...system.methods.flatMap((method) => [
      method.id,
      ...method.operationTopologies.flatMap((topology) => [
        topology.id,
        ...topology.nodes.map((node) => node.id),
        ...topology.edges.map((edge) => edge.id),
      ]),
      ...method.courses.map((course) => course.id),
    ]),
    ...system.abilities.map((ability) => ability.id),
    ...system.formations.flatMap((formation) => [
      formation.id,
      ...formation.nodes.map((node) => node.id),
      ...formation.edges.map((edge) => edge.id),
      ...formation.design.rings.map((ring) => ring.id),
      ...formation.design.backdropLayers.map((layer) => layer.id),
    ]),
    ...system.foundations.map((foundation) => foundation.id),
    ...system.transitions.map((transition) => transition.id),
    ...system.constraints.map((constraint) => constraint.id),
  ]);
}

export function auditSystem(
  system: CultivationSystem,
  ecology: CultivationEcology,
  options: CultivationAuditOptions = {},
): readonly AuditIssue[] {
  const issues: AuditIssue[] = [];
  const add = (
    severity: AuditIssue["severity"],
    targetType: IssueTarget,
    targetId: string | null,
    title: string,
    message: string,
    suggestion: string,
    fingerprint?: string,
  ) => {
    issues.push(
      buildIssue(
        system.id,
        issues.length + 1,
        severity,
        targetType,
        targetId,
        title,
        message,
        suggestion,
        fingerprint,
      ),
    );
  };
  const seenIds = new Set<string>();
  const registerId = (
    id: string,
    label: string,
    targetType: IssueTarget,
    targetId: string,
  ) => {
    if (seenIds.has(id))
      add(
        "error",
        targetType,
        targetId,
        "体系内稳定 ID 重复",
        `${label} 使用了已被其他资产占用的稳定 ID ${id}。`,
        "为该资产生成新的稳定 ID，保证引用唯一。",
        `duplicate-id:${id}`,
      );
    else seenIds.add(id);
  };
  registerId(system.id, "体系", "system", system.id);
  const nodeIds = new Set(
    system.theoryModel.nodeCatalog.map((item) => item.id),
  );
  system.theoryModel.nodeCatalog.forEach((node) =>
    registerId(node.id, "理论节点", "theory", node.id),
  );
  const levelIds = new Set(
    system.progressionTracks.flatMap((track) =>
      track.levels.map((level) => level.id),
    ),
  );
  const methodIds = new Set(system.methods.map((method) => method.id));
  const resourceIds = new Set(system.resources.map((resource) => resource.id));
  const abilityIds = new Set(system.abilities.map((ability) => ability.id));
  const trackIds = new Set(system.progressionTracks.map((track) => track.id));
  const checkRefs = (
    ids: readonly string[],
    valid: Set<string>,
    targetType: IssueTarget,
    targetId: string,
    label: string,
  ) => {
    ids.forEach((id) => {
      if (!valid.has(id))
        add(
          "error",
          targetType,
          targetId,
          `${label}引用不存在`,
          `${label}引用了不存在的对象 ${id}。`,
          "改为当前体系中已存在的稳定 ID。",
        );
    });
  };
  const checkResourceRequirements = (
    requirements: readonly {
      resourceId: string;
      substituteResourceIds: readonly string[];
    }[],
    targetType: IssueTarget,
    targetId: string,
    label: string,
  ) => {
    requirements.forEach((requirement) => {
      checkRefs(
        [requirement.resourceId],
        resourceIds,
        targetType,
        targetId,
        label,
      );
      checkRefs(
        requirement.substituteResourceIds,
        resourceIds,
        targetType,
        targetId,
        `${label}替代资源`,
      );
    });
  };

  const origins = new Map(
    ecology.worldOrigins.map((origin) => [origin.id, origin]),
  );
  const manifestationIds = new Set(
    ecology.worldOrigins.flatMap((origin) =>
      origin.manifestations.map((manifestation) => manifestation.id),
    ),
  );
  const manifestationOwners = new Map(
    ecology.worldOrigins.flatMap((origin) =>
      origin.manifestations.map(
        (manifestation) => [manifestation.id, origin.id] as const,
      ),
    ),
  );
  const originProjectionNodeIds = new Set([
    ...origins.keys(),
    ...manifestationIds,
  ]);
  ecology.worldOrigins.forEach((origin) => {
    const nodeIdsInOrigin = new Set([
      origin.id,
      ...origin.manifestations.map((manifestation) => manifestation.id),
    ]);
    origin.manifestations.forEach((manifestation) => {
      if (
        manifestation.sourceId &&
        !nodeIdsInOrigin.has(manifestation.sourceId)
      )
        add(
          "error",
          "system",
          system.id,
          "世界本源显化来源不存在",
          `显化节点 ${manifestation.name} 的来源节点 ${manifestation.sourceId} 不属于其本源。`,
          "选择同一本源下的节点，或清空来源节点。",
          `origin:${origin.id}:manifestation:${manifestation.id}:source`,
        );
    });
    origin.relations.forEach((relation) => {
      if (
        !nodeIdsInOrigin.has(relation.sourceId) ||
        !nodeIdsInOrigin.has(relation.targetId)
      )
        add(
          "error",
          "system",
          system.id,
          "世界本源关系端点不存在",
          `本源关系 ${relation.name} 的来源或目标节点不属于 ${origin.name}。`,
          "重新选择同一本源下的关系端点。",
          `origin:${origin.id}:relation:${relation.id}:endpoint`,
        );
    });
  });
  system.projection.originIds.forEach((id) => {
    if (!origins.has(id))
      add(
        "error",
        "system",
        system.id,
        "世界本源投影引用不存在",
        `本源投影引用了不存在的世界本源 ${id}。`,
        "从世界本源工作台选择有效对象。",
      );
  });
  system.projection.manifestationIds.forEach((id) => {
    if (!manifestationIds.has(id))
      add(
        "error",
        "system",
        system.id,
        "本源显化引用不存在",
        `本源投影引用了不存在的显化节点 ${id}。`,
        "从世界本源的显化节点中选择。",
      );
    else if (
      !system.projection.originIds.includes(manifestationOwners.get(id) ?? "")
    )
      add(
        "error",
        "system",
        system.id,
        "本源显化不属于已选本源",
        `显化节点 ${id} 所属本源未包含在当前体系的本源投影中。`,
        "同时选择显化节点所属的世界本源，或移除该显化节点。",
      );
  });
  system.projection.originBindings?.forEach((binding) => {
    checkRefs(
      [binding.sourceId],
      originProjectionNodeIds,
      "system",
      system.id,
      "本源绑定",
    );
    const ownerId = manifestationOwners.get(binding.sourceId);
    if (ownerId && !system.projection.originIds.includes(ownerId))
      add(
        "error",
        "system",
        system.id,
        "本源绑定所属本源未投影",
        `绑定 ${binding.sourceId} 所属本源 ${ownerId} 未在当前体系本源列表中。`,
        "补充所属本源投影，或改绑到当前体系已选择的节点。",
      );
    if (
      binding.role === "manifestation" &&
      !manifestationOwners.has(binding.sourceId)
    )
      add(
        "error",
        "system",
        system.id,
        "显化绑定来源类型错误",
        `绑定 ${binding.sourceId} 标记为显化节点，但来源不是显化节点。`,
        "选择显化节点，或将绑定角色改为本源。",
      );
  });
  if (system.theoryModel.nodeCatalog.length === 0)
    add(
      "warning",
      "theory",
      system.id,
      "理论节点库为空",
      "法门和阵法无法引用体系共有结构。",
      "至少建立一个理论共有节点。",
    );

  system.progressionTracks.forEach((track) => {
    registerId(track.id, "成长轨道", "system", system.id);
    track.metrics.forEach((metric) =>
      registerId(metric.id, "成长指标", "system", system.id),
    );
    track.levels.forEach((level) => {
      registerId(level.id, "境界", "level", level.id);
      level.subStages.forEach((stage) =>
        registerId(stage.id, "境内阶段", "level-stage", stage.id),
      );
    });
    track.transitions.forEach((transition) =>
      registerId(transition.id, "轨道转换", "transition", transition.id),
    );
    const trackMetricIds = new Set(track.metrics.map((metric) => metric.id));
    track.levels.forEach((level) => {
      level.metricThresholds.forEach((item) => {
        if (!trackMetricIds.has(item.metricId))
          add(
            "error",
            "level",
            level.id,
            "境界指标引用不存在",
            `境界 ${level.name} 引用了不存在的指标 ${item.metricId}。`,
            "从当前成长轨道的指标中选择。",
          );
      });
      checkResourceRequirements(
        level.resourceRequirements,
        "level",
        level.id,
        "境界资源",
      );
      checkRefs(
        level.naturalAbilityIds,
        abilityIds,
        "level",
        level.id,
        "境界自然能力",
      );
      checkRefs(level.methodIds, methodIds, "level", level.id, "境界法门");
      level.subStages.forEach((stage) => {
        stage.metricThresholds.forEach((item) => {
          if (!trackMetricIds.has(item.metricId))
            add(
              "error",
              "level-stage",
              stage.id,
              "境内阶段指标引用不存在",
              `${level.name} · ${stage.name} 引用了不存在的指标 ${item.metricId}。`,
              "从当前成长轨道的指标中选择。",
            );
        });
        checkResourceRequirements(
          stage.resourceRequirements,
          "level-stage",
          stage.id,
          "境内阶段资源",
        );
        checkRefs(
          stage.naturalAbilityIds,
          abilityIds,
          "level-stage",
          stage.id,
          "境内阶段自然能力",
        );
        checkRefs(
          stage.methodIds,
          methodIds,
          "level-stage",
          stage.id,
          "境内阶段法门",
        );
      });
    });
    track.transitions.forEach((transition) => {
      if (transition.transitionType === "conversion")
        add(
          "warning",
          "transition",
          transition.id,
          "体系转换放置在成长轨道内",
          `转换 ${transition.name} 位于成长轨道内，轨道内跃迁应表达突破、觉醒或退化。`,
          "将体系级转换移动到“突破与转换”目录，或改为轨道内突破。",
          `transition:${transition.id}:track-scope`,
        );
      checkRefs(
        [transition.fromLevelId, transition.toLevelId].filter(
          (id): id is string => Boolean(id),
        ),
        levelIds,
        "transition",
        transition.id,
        "轨道转换境界",
      );
      checkRefs(
        transition.methodIds,
        methodIds,
        "transition",
        transition.id,
        "转换法门",
      );
      checkResourceRequirements(
        transition.resourceRequirements,
        "transition",
        transition.id,
        "转换资源",
      );
    });
  });

  (system.trackInteractions ?? []).forEach((interaction) =>
    registerId(interaction.id, "轨道交叉规则", "system", system.id),
  );

  const interactionGraph = new Map<string, string[]>();
  (system.trackInteractions ?? []).forEach((interaction) => {
    if (
      !trackIds.has(interaction.sourceTrackId) ||
      !trackIds.has(interaction.targetTrackId)
    ) {
      add(
        "error",
        "system",
        system.id,
        "轨道交叉规则引用不存在",
        `交叉规则 ${interaction.name} 的源轨道或目标轨道不存在。`,
        "重新选择有效的成长轨道。",
        `track-interaction:${interaction.id}:reference`,
      );
    }
    if (interaction.sourceTrackId === interaction.targetTrackId) {
      add(
        "error",
        "system",
        system.id,
        "轨道交叉规则自引用",
        `交叉规则 ${interaction.name} 不能把同一轨道作为源和目标。`,
        "选择不同的源轨道与目标轨道。",
        `track-interaction:${interaction.id}:self`,
      );
    }
    if (
      interaction.kind === "dependency" ||
      interaction.kind === "cross-breakthrough" ||
      interaction.kind === "synchronization"
    )
      interactionGraph.set(interaction.sourceTrackId, [
        ...(interactionGraph.get(interaction.sourceTrackId) ?? []),
        interaction.targetTrackId,
      ]);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (trackId: string): boolean => {
    if (visiting.has(trackId)) return true;
    if (visited.has(trackId)) return false;
    visiting.add(trackId);
    const cycle = (interactionGraph.get(trackId) ?? []).some(visit);
    visiting.delete(trackId);
    visited.add(trackId);
    return cycle;
  };
  if ([...trackIds].some(visit)) {
    add(
      "error",
      "system",
      system.id,
      "轨道交叉规则存在循环依赖",
      "跨轨道依赖形成闭环，无法确定先后顺序。",
      "拆分循环依赖，或为循环增加明确的终止条件。",
    );
  }

  system.methods.forEach((method) => {
    registerId(method.id, "法门", "method", method.id);
    method.operationTopologies.forEach((topology) => {
      registerId(topology.id, "运行拓扑", "topology", topology.id);
      topology.nodes.forEach((node) =>
        registerId(node.id, "拓扑节点", "topology", topology.id),
      );
      topology.edges.forEach((edge) =>
        registerId(edge.id, "拓扑边", "topology", topology.id),
      );
    });
    method.courses.forEach((course) =>
      registerId(course.id, "法门课程", "method", method.id),
    );
    if (options.itemIds)
      method.itemIds.forEach((itemId) => {
        if (!options.itemIds?.has(itemId))
          add(
            "error",
            "method",
            method.id,
            "法门物品引用不存在",
            `法门 ${method.name} 关联了物品库中不存在的物品 ${itemId}。`,
            "从物品库重新选择有效物品，或移除失效 ID。",
          );
      });
    checkRefs(
      [
        method.coverage.startLevelId,
        method.coverage.stableLimitId,
        method.coverage.theoryLimitId,
        method.coverage.absoluteLimitId,
      ].filter((id): id is string => Boolean(id)),
      levelIds,
      "method",
      method.id,
      "法门覆盖阶段",
    );
    if (method.operationTopologies.length === 0)
      add(
        "warning",
        "method",
        method.id,
        "法门缺少运行拓扑",
        "法门只有法诀，没有可验证的运行线路。",
        "至少添加一条法门运行拓扑。",
      );
    const coverageBoundaryEntries = [
      ["startLevelId", method.coverage.startLevelId],
      ["stableLimitId", method.coverage.stableLimitId],
      ["theoryLimitId", method.coverage.theoryLimitId],
      ["absoluteLimitId", method.coverage.absoluteLimitId],
    ] as const;
    const coverageBoundaries = coverageBoundaryEntries
      .filter((entry) => Boolean(entry[1]))
      .map(([kind, levelId]) => [kind, levelId as string] as const);
    const coverageLevelIds = new Set<string>();
    if (coverageBoundaries.length > 0) {
      const boundaryTracks = system.progressionTracks.filter((track) =>
        track.levels.some((level) =>
          coverageBoundaries.some(([, levelId]) => level.id === levelId),
        ),
      );
      if (boundaryTracks.length > 1)
        add(
          "error",
          "method",
          method.id,
          "法门 coverage 跨越多个成长轨道",
          `法门 ${method.name} 的 coverage 边界分布在多个成长轨道，无法形成单一阶段区间。`,
          "将 coverage 边界限制在同一成长轨道，或拆分为多部法门。",
          `method:${method.id}:coverage-track-scope`,
        );
      const boundaryTrack = boundaryTracks[0];
      if (boundaryTrack) {
        const orderedLevels = boundaryTrack.levels
          .slice()
          .sort((left, right) => left.order - right.order);
        const boundaryOrders = coverageBoundaries.map(([kind, levelId]) => ({
          kind,
          levelId,
          order: orderedLevels.find((level) => level.id === levelId)?.order,
        }));
        boundaryOrders.forEach((entry, index) => {
          const next = boundaryOrders[index + 1];
          if (entry.order === undefined || next?.order === undefined) return;
          if (entry.order > next.order)
            add(
              "error",
              "method",
              method.id,
              "法门 coverage 上限顺序错误",
              `法门 ${method.name} 的 ${entry.kind} 高于 ${next.kind}，覆盖区间无法按成长顺序解释。`,
              "按成长轨道顺序重新设置起始、稳定、理论和绝对上限。",
              `method:${method.id}:coverage-order:${entry.kind}:${next.kind}`,
            );
        });
        // 只有同时存在下界和上界时，才把 coverage 解释成完整的阶段区间。
        // 仅填写一个边界不能推断另一端，避免误报阶段侧法门关联。
        const lower = boundaryOrders.find((entry) => entry.kind === "startLevelId");
        const upper = boundaryOrders
          .filter((entry) => entry.kind !== "startLevelId")
          .at(-1);
        if (lower?.order !== undefined && upper?.order !== undefined) {
          orderedLevels
            .filter(
              (level) =>
                level.order >= lower.order! && level.order <= upper.order!,
            )
            .forEach((level) => coverageLevelIds.add(level.id));
        }
      }
      coverageBoundaries.forEach(([, levelId]) => coverageLevelIds.add(levelId));
    }
    const levelSideReferences = system.progressionTracks.flatMap((track) =>
      track.levels.flatMap((level) => [
        ...(level.methodIds.includes(method.id) ? [level.id] : []),
        ...level.subStages.flatMap((stage) =>
          stage.methodIds.includes(method.id) ? [level.id] : [],
        ),
      ]),
    );
    levelSideReferences.forEach((levelId) => {
      if (
        coverageBoundaries.length >= 2 &&
        coverageLevelIds.size > 0 &&
        !coverageLevelIds.has(levelId)
      )
        add(
          "warning",
          "method",
          method.id,
          "法门阶段关联超出覆盖范围",
          `法门 ${method.name} 在阶段 ${levelId} 被直接关联，但 coverage 未声明该阶段。`,
          "让 coverage 与阶段法门关联保持一致，或移除阶段侧关联。",
          `method:${method.id}:stage-coverage:${levelId}`,
        );
    });
    method.courses.forEach((course) => {
      checkRefs(
        course.levelId ? [course.levelId] : [],
        levelIds,
        "method",
        method.id,
        "法门课程阶段",
      );
      checkRefs(
        course.resourceRequirements.map((item) => item.resourceId),
        resourceIds,
        "method",
        method.id,
        "法门课程资源",
      );
      checkRefs(
        course.resourceRequirements.flatMap(
          (item) => item.substituteResourceIds,
        ),
        resourceIds,
        "method",
        method.id,
        "法门课程替代资源",
      );
    });
    method.operationTopologies.forEach((topology) => {
      const topologyNodeIds = new Set(topology.nodes.map((node) => node.id));
      topology.nodes.forEach((node) => {
        if (!nodeIds.has(node.theoryNodeId))
          add(
            "error",
            "topology",
            topology.id,
            "拓扑节点引用不存在",
            `拓扑节点 ${node.id} 没有对应的理论共有节点。`,
            "从当前体系理论节点库选择节点。",
          );
      });
      topology.edges.forEach((edge) => {
        if (
          !topologyNodeIds.has(edge.fromNodeId) ||
          !topologyNodeIds.has(edge.toNodeId)
        )
          add(
            "error",
            "topology",
            topology.id,
            "拓扑边连接不存在",
            `拓扑边 ${edge.id} 的起点或终点不存在。`,
            "删除悬空边，或重新选择拓扑节点。",
          );
      });
      if (topology.nodes.length > 0 && topology.edges.length === 0)
        add(
          "warning",
          "topology",
          topology.id,
          "运行拓扑没有边",
          "当前拓扑只有节点，没有可执行的流向。",
          "为拓扑节点补充有向边和收束规则。",
        );
    });
  });

  system.abilities.forEach((ability) => {
    registerId(ability.id, "能力", "ability", ability.id);
    if (options.itemIds && ability.scriptureSource)
      ability.scriptureSource.itemIds.forEach((itemId) => {
        if (!options.itemIds?.has(itemId))
          add(
            "error",
            "ability",
            ability.id,
            "秘籍物品引用不存在",
            `能力 ${ability.name} 的秘籍来源关联了物品库中不存在的物品 ${itemId}。`,
            "从物品库重新选择有效典籍物品，或移除失效 ID。",
          );
      });
    checkRefs(
      ability.unlockLevelId ? [ability.unlockLevelId] : [],
      levelIds,
      "ability",
      ability.id,
      "能力解锁阶段",
    );
    checkRefs(
      ability.trainingRequirements.methodIds,
      methodIds,
      "ability",
      ability.id,
      "能力训练法门",
    );
    checkRefs(
      ability.trainingRequirements.resourceRequirements.map(
        (item) => item.resourceId,
      ),
      resourceIds,
      "ability",
      ability.id,
      "能力训练资源",
    );
    checkRefs(
      ability.trainingRequirements.resourceRequirements.flatMap(
        (item) => item.substituteResourceIds,
      ),
      resourceIds,
      "ability",
      ability.id,
      "能力训练替代资源",
    );
    checkRefs(
      ability.cast.fullPowerLevelId ? [ability.cast.fullPowerLevelId] : [],
      levelIds,
      "ability",
      ability.id,
      "能力完整发挥阶段",
    );
    const levelSideAbilityReferences = system.progressionTracks.flatMap(
      (track) =>
        track.levels
          .filter((level) => level.naturalAbilityIds.includes(ability.id))
          .map((level) => level.id),
    );
    if (
      ability.acquisitionType === "natural" &&
      ability.unlockLevelId &&
      levelSideAbilityReferences.length > 0 &&
      !levelSideAbilityReferences.includes(ability.unlockLevelId)
    )
      add(
        "warning",
        "ability",
        ability.id,
        "能力解锁阶段与境界关联不一致",
        `能力 ${ability.name} 的 unlockLevelId 与阶段侧 naturalAbilityIds 不一致。`,
        "统一能力解锁阶段和境界自然能力关联。",
        `ability:${ability.id}:unlock-stage`,
      );
    checkRefs(
      ability.scriptureSource?.methodId
        ? [ability.scriptureSource.methodId]
        : [],
      methodIds,
      "ability",
      ability.id,
      "秘籍来源法门",
    );
    if (ability.acquisitionType === "scripture" && !ability.scriptureSource)
      add(
        "error",
        "ability",
        ability.id,
        "秘籍来源缺失",
        "秘籍修炼获得的能力没有秘籍来源。",
        "关联能力典籍或法门来源。",
      );
    if (
      ability.acquisitionType === "scripture" &&
      ability.trainingRequirements.methodIds.length === 0
    )
      add(
        "warning",
        "ability",
        ability.id,
        "秘籍能力缺少训练法门",
        "当前没有声明通过哪部法门课程训练。",
        "关联至少一部修行法门。",
      );
    if (
      ability.functionType === "offensive" &&
      !ability.amplificationModel.trim()
    )
      add(
        "warning",
        "ability",
        ability.id,
        "进攻能力缺少放大模型",
        "进攻类能力没有说明输入能量如何放大为输出。",
        "补充放大倍率、转换损耗、过载阈值和反制方式。",
      );
    if (!ability.cast.amount.trim() || !ability.cast.energyLabel.trim())
      add(
        "warning",
        "ability",
        ability.id,
        "能力释放消耗未定义",
        "能力缺少释放能量或消耗数量。",
        "区分修炼资源和每次释放的能量消耗。",
      );
    if (
      !ability.cast.reserve?.trim() ||
      !ability.cast.overloadThreshold?.trim()
    )
      add(
        "warning",
        "ability",
        ability.id,
        "能力缺少储备或过载边界",
        "能力释放没有声明最低储备或过载阈值。",
        "补充储备、持续消耗、欠费结果和过载阈值。",
      );
  });

  const topologyOwners = new Map(
    system.methods.flatMap((method) =>
      method.operationTopologies.map(
        (topology) => [topology.id, method.id] as const,
      ),
    ),
  );
  system.formations.forEach((formation) => {
    registerId(formation.id, "阵法", "formation", formation.id);
    formation.nodes.forEach((node) =>
      registerId(node.id, "阵法节点", "formation", formation.id),
    );
    formation.edges.forEach((edge) =>
      registerId(edge.id, "阵法边", "formation", formation.id),
    );
    formation.design.rings.forEach((ring) =>
      registerId(ring.id, "阵环", "formation", formation.id),
    );
    formation.design.backdropLayers.forEach((layer) =>
      registerId(layer.id, "阵法底纹", "formation", formation.id),
    );
    if (options.itemIds)
      formation.itemIds.forEach((itemId) => {
        if (!options.itemIds?.has(itemId))
          add(
            "error",
            "formation",
            formation.id,
            "阵法物品引用不存在",
            `阵法 ${formation.name} 关联了物品库中不存在的物品 ${itemId}。`,
            "从物品库重新选择有效阵图或阵材物品，或移除失效 ID。",
          );
      });
    checkRefs(
      formation.theoryNodeIds,
      nodeIds,
      "formation",
      formation.id,
      "阵法理论节点",
    );
    checkRefs(
      formation.requiredLevelIds,
      levelIds,
      "formation",
      formation.id,
      "阵法阶段",
    );
    checkRefs(
      formation.methodIds,
      methodIds,
      "formation",
      formation.id,
      "阵法法门",
    );
    checkRefs(
      formation.operationTopologyIds ?? [],
      new Set(topologyOwners.keys()),
      "formation",
      formation.id,
      "阵法运行拓扑",
    );
    (formation.operationTopologyIds ?? []).forEach((topologyId) => {
      const ownerMethodId = topologyOwners.get(topologyId);
      if (ownerMethodId && !formation.methodIds.includes(ownerMethodId))
        add(
          "error",
          "formation",
          formation.id,
          "阵法运行拓扑不属于阵法法门",
          `运行拓扑 ${topologyId} 属于法门 ${ownerMethodId}，但该法门不在阵法法门列表中。`,
          "先关联拓扑所属法门，或移除该运行拓扑。",
          `formation:${formation.id}:topology-owner:${topologyId}`,
        );
    });
    checkRefs(
      formation.abilityIds,
      abilityIds,
      "formation",
      formation.id,
      "阵法能力",
    );
    checkRefs(
      formation.resourceRequirements.map((item) => item.resourceId),
      resourceIds,
      "formation",
      formation.id,
      "阵法资源",
    );
    checkRefs(
      formation.resourceRequirements.flatMap(
        (item) => item.substituteResourceIds,
      ),
      resourceIds,
      "formation",
      formation.id,
      "阵法替代资源",
    );
    const ringIds = new Set<string>();
    formation.design.rings.forEach((ring) => {
      if (ringIds.has(ring.id))
        add(
          "error",
          "formation",
          formation.id,
          "阵环标识重复",
          `阵法 ${formation.name} 中存在重复阵环，节点绑定将无法唯一解析。`,
          "删除重复阵环，或为阵环重新生成唯一标识。",
          `formation:${formation.id}:duplicate-ring:${ring.id}`,
        );
      ringIds.add(ring.id);
    });
    const backdropLayerIds = new Set<string>();
    formation.design.backdropLayers.forEach((layer) => {
      if (backdropLayerIds.has(layer.id))
        add(
          "error",
          "formation",
          formation.id,
          "底纹标识重复",
          `阵法 ${formation.name} 中存在重复底纹，排序和编辑结果可能作用于错误图层。`,
          "删除重复底纹，或为底纹重新生成唯一标识。",
          `formation:${formation.id}:duplicate-backdrop:${layer.id}`,
        );
      backdropLayerIds.add(layer.id);
    });
    if (Object.values(formation.sixElements).every((value) => !value.trim()))
      add(
        "warning",
        "formation",
        formation.id,
        "阵法六元尚未定义",
        `阵法 ${formation.name} 尚未描述阵源、阵基、阵纹、阵眼、阵域与阵则。`,
        "至少明确六元结构的叙事职责，确保阵法规则能够完整解释。",
        `formation:${formation.id}:six-elements`,
      );
    const formationNodeIds = new Set(formation.nodes.map((node) => node.id));
    formation.nodes.forEach((node) => {
      if (node.theoryNodeId && !nodeIds.has(node.theoryNodeId))
        add(
          "error",
          "formation",
          formation.id,
          "阵法节点引用不存在",
          `阵法节点 ${node.name} 引用了不存在的理论节点。`,
          "从当前体系理论节点库选择。",
        );
      if (node.ringId && !ringIds.has(node.ringId))
        add(
          "error",
          "formation",
          formation.id,
          "阵法节点绑定阵环不存在",
          `阵法节点 ${node.name} 绑定了不存在的阵环。`,
          "重新选择有效阵环，或将节点改为自由定位。",
          `formation:${formation.id}:node-ring:${node.id}`,
        );
    });
    formation.edges.forEach((edge) => {
      if (
        !formationNodeIds.has(edge.fromNodeId) ||
        !formationNodeIds.has(edge.toNodeId)
      )
        add(
          "error",
          "formation",
          formation.id,
          "阵法流向断路",
          `阵法边 ${edge.id} 的起点或终点不存在。`,
          "补齐阵元，或删除悬空流向。",
        );
    });
    if (formation.nodes.length > 0 && formation.edges.length === 0)
      add(
        "warning",
        "formation",
        formation.id,
        "阵法缺少流向",
        "阵法只有阵元，没有可验证的阵内流向。",
        "添加阵元之间的有向流向。",
      );
  });

  system.foundations.forEach(
    (foundation) => (
      registerId(foundation.id, "根基", "foundation", foundation.id),
      checkRefs(
        foundation.affectedTracks,
        trackIds,
        "foundation",
        foundation.id,
        "根基影响轨道",
      )
    ),
  );
  const resourceConsumers: Array<{
    levelId: string | null;
    requirements: readonly ResourceRequirement[];
  }> = system.progressionTracks.flatMap((track) =>
    track.levels.flatMap((level) => [
      {
        levelId: level.id,
        requirements: level.resourceRequirements,
      },
      ...level.subStages.map((stage) => ({
        levelId: level.id,
        requirements: stage.resourceRequirements,
      })),
    ]),
  );
  system.methods.forEach((method) =>
    method.courses.forEach((course) =>
      resourceConsumers.push({
        levelId: course.levelId,
        requirements: course.resourceRequirements,
      }),
    ),
  );
  system.abilities.forEach((ability) =>
    resourceConsumers.push({
      levelId: ability.unlockLevelId,
      requirements: ability.trainingRequirements.resourceRequirements,
    }),
  );
  system.formations.forEach((formation) =>
    resourceConsumers.push({
      levelId: formation.requiredLevelIds[0] ?? null,
      requirements: formation.resourceRequirements,
    }),
  );
  system.resources.forEach((resource) => {
    registerId(resource.id, "资源", "resource", resource.id);
    resource.grades.forEach((grade) =>
      registerId(grade.id, "资源品阶", "resource", resource.id),
    );
    checkRefs(
      resource.bestLevelId ? [resource.bestLevelId] : [],
      levelIds,
      "resource",
      resource.id,
      "资源最佳阶段",
    );
    checkRefs(
      resource.usableLevelIds,
      levelIds,
      "resource",
      resource.id,
      "资源可用阶段",
    );
    if (resource.usableLevelIds.length > 0)
      resourceConsumers.forEach(({ levelId, requirements }) => {
        if (
          requirements.some(
            (requirement) =>
              requirement.resourceId === resource.id ||
              requirement.substituteResourceIds.includes(resource.id),
          ) &&
          levelId &&
          !resource.usableLevelIds.includes(levelId)
        )
          add(
            "warning",
            "resource",
            resource.id,
            "资源需求超出适用阶段",
            `资源 ${resource.name} 在阶段或课程 ${levelId} 被要求使用，但该阶段不在 usableLevelIds 中。`,
            "扩大资源适用阶段，或调整阶段、课程和能力的资源需求。",
            `resource:${resource.id}:level:${levelId}`,
          );
      });
  });
  system.transitions.forEach((transition) => {
    if (transition.transitionType !== "conversion")
      add(
        "warning",
        "transition",
        transition.id,
        "轨道跃迁放置在体系级容器",
        `体系级跃迁 ${transition.name} 当前类型为 ${transition.transitionType}，体系级容器只承载跨体系或跨轨道转换。`,
        "将其移动到对应成长轨道，或改为体系级转换。",
        `transition:${transition.id}:system-scope`,
      );
    registerId(transition.id, "体系转换", "transition", transition.id);
    checkRefs(
      [transition.fromLevelId, transition.toLevelId].filter(
        (id): id is string => Boolean(id),
      ),
      levelIds,
      "transition",
      transition.id,
      "突破阶段",
    );
    checkRefs(
      transition.methodIds,
      methodIds,
      "transition",
      transition.id,
      "突破法门",
    );
    checkRefs(
      transition.resourceRequirements.map((item) => item.resourceId),
      resourceIds,
      "transition",
      transition.id,
      "突破资源",
    );
    checkRefs(
      transition.resourceRequirements.flatMap(
        (item) => item.substituteResourceIds,
      ),
      resourceIds,
      "transition",
      transition.id,
      "突破替代资源",
    );
  });
  system.constraints.forEach((constraint) => {
    registerId(constraint.id, "约束", "constraint", constraint.id);
    if (!constraint.trigger.trim())
      add(
        "warning",
        "constraint",
        constraint.id,
        "约束缺少触发条件",
        `约束 ${constraint.name} 尚未说明何时生效。`,
        "补充触发条件和适用范围。",
        `constraint:${constraint.id}:trigger`,
      );
    if (!constraint.consequence.trim())
      add(
        "warning",
        "constraint",
        constraint.id,
        "约束缺少后果",
        `约束 ${constraint.name} 尚未定义触发后的实际后果。`,
        "补充可观察、可执行的后果。",
        `constraint:${constraint.id}:consequence`,
      );
    if (
      (constraint.category === "world-rule" ||
        constraint.category === "identity") &&
      !constraint.target?.trim()
    )
      add(
        "warning",
        "constraint",
        constraint.id,
        "约束作用对象未定义",
        `${constraint.name} 属于${constraint.category === "world-rule" ? "世界规则" : "身份限制"}，但没有声明作用对象。`,
        "填写受约束的对象、范围或身份条件。",
        `constraint:${constraint.id}:target`,
      );
    if (!constraint.reversible && !constraint.releaseMethod?.trim())
      add(
        "suggestion",
        "constraint",
        constraint.id,
        "不可逆约束缺少解除说明",
        `约束 ${constraint.name} 标记为不可逆，但没有记录是否存在特殊解除路径。`,
        "明确不可逆边界，或补充极端解除方式。",
        `constraint:${constraint.id}:release`,
      );
  });
  ecology.crossSystemRelations.forEach((relation) => {
    const sourceExists = ecology.systems.some(
      (candidate) => candidate.id === relation.sourceSystemId,
    );
    const targetExists = ecology.systems.some(
      (candidate) => candidate.id === relation.targetSystemId,
    );
    const belongsToSystem =
      relation.sourceSystemId === system.id ||
      relation.targetSystemId === system.id;
    // 两端都存在时，只在关联体系上展示一次；悬空关系则归档到首个体系，
    // 避免删除体系后关系完全失去审查归属。
    if (
      !belongsToSystem &&
      sourceExists &&
      targetExists
    )
      return;
    if (
      !belongsToSystem &&
      system.id !== ecology.systems[0]?.id
    )
      return;
    if (!sourceExists || !targetExists)
      add(
        "error",
        "relation",
        relation.id,
        "跨体系关系引用不存在",
        "关系的源体系或目标体系不存在。",
        "选择当前项目中已存在的修行体系。",
      );
    if (relation.sourceSystemId === relation.targetSystemId)
      add(
        "error",
        "relation",
        relation.id,
        "跨体系关系自引用",
        "源体系与目标体系不能是同一个体系。",
        "选择两个不同的修行体系。",
      );
    if (
      !relation.conversionRule.trim() &&
      ["转换", "继承", "依赖"].includes(relation.relation)
    )
      add(
        "warning",
        "relation",
        relation.id,
        "跨体系关系缺少规则",
        `${relation.relation}关系尚未定义转换或依赖规则。`,
        "补充条件、转换规则和风险边界。",
        `relation:${relation.id}:rule`,
      );
    if ((relation.affectedAssetIds ?? []).length > 0) {
      const source = ecology.systems.find(
        (candidate) => candidate.id === relation.sourceSystemId,
      );
      const target = ecology.systems.find(
        (candidate) => candidate.id === relation.targetSystemId,
      );
      const valid = new Set<string>();
      if (source)
        collectCultivationSystemAssetIds(source).forEach((id) => valid.add(id));
      if (target)
        collectCultivationSystemAssetIds(target).forEach((id) => valid.add(id));
      (relation.affectedAssetIds ?? []).forEach((assetId) => {
        if (!valid.has(assetId))
          add(
            "error",
            "relation",
            relation.id,
            "跨体系关系资产引用不存在",
            `关系 ${relation.name} 关联了源体系或目标体系之外的资产 ${assetId}。`,
            "选择源体系或目标体系中的有效资产，或移除该引用。",
          );
      });
    }
  });
  return issues;
}

export function rebuildCultivationAudits(
  ecology: CultivationEcology,
  options: CultivationAuditOptions = {},
): CultivationEcology {
  const issueKey = (issue: AuditIssue) =>
    issue.fingerprint ??
    `${issue.targetType}:${issue.targetId ?? ""}:${issue.title}:${issue.message}`;
  const legacyIssueKey = (issue: AuditIssue) =>
    `${issue.targetType}:${issue.targetId ?? ""}:${issue.title}`;
  const globalOwners = new Map<string, string[]>();
  ecology.systems.forEach((system) => {
    collectCultivationSystemAssetIds(system).forEach((id) => {
      globalOwners.set(id, [...(globalOwners.get(id) ?? []), system.id]);
    });
  });
  const globalDuplicates = new Map<string, string[]>();
  globalOwners.forEach((owners, id) => {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1) globalDuplicates.set(id, uniqueOwners);
  });
  return {
    ...ecology,
    systems: ecology.systems.map((system) => {
      const previous = new Map<string, boolean>();
      system.audit.forEach((issue) => {
        previous.set(issueKey(issue), issue.resolved);
        previous.set(legacyIssueKey(issue), issue.resolved);
      });
      const audited = auditSystem(system, ecology, options);
      const duplicateIssues = [...globalDuplicates.entries()]
        .filter(([, owners]) => owners.includes(system.id))
        .map(([id, owners], index) =>
          buildIssue(
            system.id,
            audited.length + index + 1,
            "error",
            "system",
            system.id,
            "体系间稳定 ID 重复",
            `稳定 ID ${id} 同时出现在多个修行体系（${owners.join("、")}）中，角色和跨体系关系将无法唯一解析。`,
            "为其中一个体系的资产重新生成稳定 ID，并同步更新所有引用。",
            `global-duplicate-id:${id}`,
          ),
        );
      return {
        ...system,
        audit: [...audited, ...duplicateIssues].map((issue) => ({
          ...issue,
          resolved:
            previous.get(issueKey(issue)) ??
            previous.get(legacyIssueKey(issue)) ??
            issue.resolved,
        })),
      };
    }),
  };
}
