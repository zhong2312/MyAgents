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

function buildIssue(
  systemId: string,
  index: number,
  severity: AuditIssue["severity"],
  targetType: IssueTarget,
  targetId: string | null,
  title: string,
  message: string,
  suggestion: string,
): AuditIssue {
  return {
    id: `${systemId}-audit-${index}`,
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

  const origins = new Map(
    ecology.worldOrigins.map((origin) => [origin.id, origin]),
  );
  const manifestationIds = new Set(
    ecology.worldOrigins.flatMap((origin) =>
      origin.manifestations.map((manifestation) => manifestation.id),
    ),
  );
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
      checkRefs(
        level.resourceRequirements.map((item) => item.resourceId),
        resourceIds,
        "level",
        level.id,
        "阶段资源",
      );
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
      checkRefs(
        transition.resourceRequirements.map((item) => item.resourceId),
        resourceIds,
        "transition",
        transition.id,
        "转换资源",
      );
    });
  });

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
  });

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
      formation.abilityIds,
      abilityIds,
      "formation",
      formation.id,
      "阵法能力",
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
  });
  return issues;
}

export function rebuildCultivationAudits(
  ecology: CultivationEcology,
  options: CultivationAuditOptions = {},
): CultivationEcology {
  return {
    ...ecology,
    systems: ecology.systems.map((system) => ({
      ...system,
      audit: [...auditSystem(system, ecology, options)],
    })),
  };
}
