import type {
  AuditIssue,
  CultivationEcology,
  CultivationSystem,
} from "../../../shared/novel-cultivation-ecology-schema";

type IssueTarget =
  | "system"
  | "theory"
  | "method"
  | "topology"
  | "level"
  | "resource"
  | "ability"
  | "formation"
  | "transition"
  | "foundation"
  | "relation";

export interface CultivationAuditOptions {
  readonly itemIds?: ReadonlySet<string>;
}

export function calculateCultivationCompleteness(system: CultivationSystem): number {
  const levels = system.progressionTracks.reduce((total, track) => total + track.levels.length, 0);
  const topologyCount = system.methods.reduce((total, method) => total + method.operationTopologies.length, 0);
  const core = [
    system.projection.originIds.length > 0,
    system.projection.manifestationIds.length > 0,
    system.progressionTracks.length > 0,
    levels > 0,
  ].filter(Boolean).length / 4;
  const structure = [
    Boolean(system.theoryModel.statement.trim()),
    system.theoryModel.nodeCatalog.length > 0,
    system.resources.length > 0,
    system.transitions.length > 0 || system.progressionTracks.some((track) => track.transitions.length > 0),
    topologyCount > 0,
  ].filter(Boolean).length / 5;
  const extension = [
    system.formations.length > 0,
    system.foundations.length > 0,
    system.constraints.length > 0,
    system.methods.some((method) => method.courses.length > 0),
  ].filter(Boolean).length / 4;
  const narrative = system.summary.trim() && system.constraints.some((constraint) => constraint.narrativePrompt?.trim()) ? 1 : 0;
  return Math.round((core * 40 + structure * 35 + extension * 15 + narrative * 10));
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
    fingerprint: fingerprint ?? `${targetType}:${targetId ?? ""}:${title}:${message}`,
    severity,
    targetType,
    targetId,
    title,
    message,
    suggestion,
    resolved: false,
  };
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
  const nodeIds = new Set(
    system.theoryModel.nodeCatalog.map((item) => item.id),
  );
  const levelIds = new Set(
    system.progressionTracks.flatMap((track) =>
      track.levels.map((level) => level.id),
    ),
  );
  const metricIds = new Set(
    system.progressionTracks.flatMap((track) =>
      track.metrics.map((metric) => metric.id),
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
    requirements: readonly { resourceId: string; substituteResourceIds: readonly string[] }[],
    targetType: IssueTarget,
    targetId: string,
    label: string,
  ) => {
    requirements.forEach((requirement) => {
      checkRefs([requirement.resourceId], resourceIds, targetType, targetId, label);
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
  const originProjectionNodeIds = new Set([
    ...origins.keys(),
    ...manifestationIds,
  ]);
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
  });
  system.projection.originBindings?.forEach((binding) => {
    checkRefs(
      [binding.sourceId],
      originProjectionNodeIds,
      "system",
      system.id,
      "本源绑定",
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
    track.levels.forEach((level) => {
      level.metricThresholds.forEach((item) => {
        if (!metricIds.has(item.metricId))
          add(
            "error",
            "level",
            level.id,
            "阶段指标引用不存在",
            `阶段 ${level.name} 引用了不存在的指标 ${item.metricId}。`,
            "从当前成长轨道的指标中选择。",
          );
      });
      checkResourceRequirements(level.resourceRequirements, "level", level.id, "阶段资源");
      checkRefs(
        level.naturalAbilityIds,
        abilityIds,
        "level",
        level.id,
        "阶段自然能力",
      );
      checkRefs(level.methodIds, methodIds, "level", level.id, "阶段法门");
    });
    track.transitions.forEach((transition) => {
      checkRefs(
        [transition.fromLevelId, transition.toLevelId].filter(
          (id): id is string => Boolean(id),
        ),
        levelIds,
        "transition",
        transition.id,
        "轨道转换阶段",
      );
      checkRefs(
        transition.methodIds,
        methodIds,
        "transition",
        transition.id,
        "转换法门",
      );
      checkResourceRequirements(transition.resourceRequirements, "transition", transition.id, "转换资源");
    });
  });

  const interactionIds = new Set(system.progressionTracks.map((track) => track.id));
  const interactionGraph = new Map<string, string[]>();
  (system.trackInteractions ?? []).forEach((interaction) => {
    if (!interactionIds.has(interaction.sourceTrackId) || !interactionIds.has(interaction.targetTrackId)) {
      add("error", "system", system.id, "轨道交叉规则引用不存在", `交叉规则 ${interaction.name} 的源轨道或目标轨道不存在。`, "重新选择有效的成长轨道。", `track-interaction:${interaction.id}:reference`);
    }
    if (interaction.sourceTrackId === interaction.targetTrackId) {
      add("error", "system", system.id, "轨道交叉规则自引用", `交叉规则 ${interaction.name} 不能把同一轨道作为源和目标。`, "选择不同的源轨道与目标轨道。", `track-interaction:${interaction.id}:self`);
    }
    if (interaction.kind === "dependency" || interaction.kind === "cross-breakthrough")
      interactionGraph.set(interaction.sourceTrackId, [...(interactionGraph.get(interaction.sourceTrackId) ?? []), interaction.targetTrackId]);
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
  if ([...interactionIds].some(visit)) {
    add("error", "system", system.id, "轨道交叉规则存在循环依赖", "跨轨道依赖形成闭环，无法确定先后顺序。", "拆分循环依赖，或为循环增加明确的终止条件。");
  }

  system.methods.forEach((method) => {
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
        course.resourceRequirements.flatMap((item) => item.substituteResourceIds),
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
    checkRefs(
      ability.scriptureSource?.methodId ? [ability.scriptureSource.methodId] : [],
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
    if (!ability.cast.reserve?.trim() || !ability.cast.overloadThreshold?.trim())
      add("warning", "ability", ability.id, "能力缺少储备或过载边界", "能力释放没有声明最低储备或过载阈值。", "补充储备、持续消耗、欠费结果和过载阈值。");
  });

  const topologyOwners = new Map(
    system.methods.flatMap((method) =>
      method.operationTopologies.map((topology) => [topology.id, method.id] as const),
    ),
  );
  system.formations.forEach((formation) => {
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
      formation.resourceRequirements.flatMap((item) => item.substituteResourceIds),
      resourceIds,
      "formation",
      formation.id,
      "阵法替代资源",
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

  system.foundations.forEach((foundation) =>
    checkRefs(
      foundation.affectedTracks,
      trackIds,
      "foundation",
      foundation.id,
      "根基影响轨道",
    ),
  );
  system.resources.forEach((resource) => {
    checkRefs(
      resource.bestLevelId ? [resource.bestLevelId] : [],
      levelIds,
      "resource",
      resource.id,
      "资源最佳阶段",
    );
    checkRefs(resource.usableLevelIds, levelIds, "resource", resource.id, "资源可用阶段");
  });
  system.transitions.forEach((transition) => {
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
      transition.resourceRequirements.flatMap((item) => item.substituteResourceIds),
      resourceIds,
      "transition",
      transition.id,
      "突破替代资源",
    );
  });
  ecology.crossSystemRelations.forEach((relation) => {
    if (
      relation.sourceSystemId !== system.id &&
      relation.targetSystemId !== system.id
    )
      return;
    if (
      !ecology.systems.some(
        (candidate) => candidate.id === relation.sourceSystemId,
      ) ||
      !ecology.systems.some(
        (candidate) => candidate.id === relation.targetSystemId,
      )
    )
      add(
        "error",
        "relation",
        relation.id,
        "跨体系关系引用不存在",
        "关系的源体系或目标体系不存在。",
        "选择当前项目中已存在的修行体系。",
      );
    if (relation.sourceSystemId === relation.targetSystemId)
      add("error", "relation", relation.id, "跨体系关系自引用", "源体系与目标体系不能是同一个体系。", "选择两个不同的修行体系。");
  });
  return issues;
}

export function rebuildCultivationAudits(
  ecology: CultivationEcology,
  options: CultivationAuditOptions = {},
): CultivationEcology {
  const issueKey = (issue: AuditIssue) =>
    issue.fingerprint ?? `${issue.targetType}:${issue.targetId ?? ""}:${issue.title}:${issue.message}`;
  const legacyIssueKey = (issue: AuditIssue) =>
    `${issue.targetType}:${issue.targetId ?? ""}:${issue.title}`;
  return {
    ...ecology,
    systems: ecology.systems.map((system) => {
      const previous = new Map<string, boolean>();
      system.audit.forEach((issue) => {
        previous.set(issueKey(issue), issue.resolved);
        previous.set(legacyIssueKey(issue), issue.resolved);
      });
      return {
      ...system,
      audit: auditSystem(system, ecology, options).map((issue) => ({
        ...issue,
        resolved: previous.get(issueKey(issue)) ?? previous.get(legacyIssueKey(issue)) ?? issue.resolved,
      })),
    };
    }),
  };
}
