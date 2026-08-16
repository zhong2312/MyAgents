import type {
  CultivationEcology,
  CultivationSystem,
  ResourceRequirement,
} from "./cultivationEcologySchema";

export interface CultivationEcologyValidationOptions {
  readonly itemIds?: ReadonlySet<string>;
}

function collectSystemAssetIds(system: CultivationSystem): ReadonlySet<string> {
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
      ...track.transitions.map((transition) => transition.id),
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

export function validateCultivationEcology(
  ecology: CultivationEcology,
  options: CultivationEcologyValidationOptions = {},
): readonly string[] {
  const errors: string[] = [];
  const add = (message: string) => errors.push(message);
  const globalIds = new Map<string, string>();
  const register = (id: string, label: string) => {
    const previous = globalIds.get(id);
    if (previous) add(`${label}“${id}”与${previous}重复`);
    else globalIds.set(id, label);
  };

  const origins = new Map(
    ecology.worldOrigins.map((origin) => [origin.id, origin]),
  );
  const manifestations = new Map<string, string>();
  ecology.worldOrigins.forEach((origin) => {
    register(origin.id, "世界本源");
    origin.manifestations.forEach((manifestation) => {
      register(manifestation.id, "本源显化");
      manifestations.set(manifestation.id, origin.id);
      if (
        manifestation.sourceId &&
        manifestation.sourceId !== origin.id &&
        !origin.manifestations.some(
          (item) => item.id === manifestation.sourceId,
        )
      )
        add(
          `本源“${origin.id}”的显化“${manifestation.id}”引用了同一本源外的来源节点“${manifestation.sourceId}”`,
        );
    });
    const localIds = new Set([
      origin.id,
      ...origin.manifestations.map((manifestation) => manifestation.id),
    ]);
    origin.relations.forEach((relation) => {
      register(relation.id, "本源关系");
      if (!localIds.has(relation.sourceId) || !localIds.has(relation.targetId))
        add(`本源关系“${relation.id}”的端点不属于本源“${origin.id}”`);
    });
  });

  const projectedOriginIds = new Set<string>();
  const projectedManifestationIds = new Set<string>();
  ecology.systems.forEach((system) => {
    register(system.id, "修行体系");
    system.projection.originIds.forEach((id) => {
      if (projectedOriginIds.has(`${system.id}:${id}`))
        add(`体系“${system.id}”重复投影本源“${id}”`);
      projectedOriginIds.add(`${system.id}:${id}`);
      if (!origins.has(id)) add(`体系“${system.id}”投影了不存在的本源“${id}”`);
    });
    system.projection.manifestationIds.forEach((id) => {
      if (projectedManifestationIds.has(`${system.id}:${id}`))
        add(`体系“${system.id}”重复投影显化“${id}”`);
      projectedManifestationIds.add(`${system.id}:${id}`);
      const owner = manifestations.get(id);
      if (!owner) add(`体系“${system.id}”投影了不存在的显化“${id}”`);
      else if (!system.projection.originIds.includes(owner))
        add(`体系“${system.id}”投影的显化“${id}”所属本源未被投影`);
    });
    system.projection.originBindings?.forEach((binding) => {
      const owner = manifestations.get(binding.sourceId);
      if (!origins.has(binding.sourceId) && !owner)
        add(
          `体系“${system.id}”的本源绑定引用了不存在的节点“${binding.sourceId}”`,
        );
      if (owner && !system.projection.originIds.includes(owner))
        add(
          `体系“${system.id}”的本源绑定“${binding.sourceId}”所属本源未被投影`,
        );
      if (binding.role === "manifestation" && !owner)
        add(`体系“${system.id}”的显化绑定“${binding.sourceId}”不是显化节点`);
      if ((binding.role === "primary" || binding.role === "secondary") && owner)
        add(`体系“${system.id}”的本源绑定“${binding.sourceId}”实际是显化节点`);
    });

    const nodeIds = new Set(
      system.theoryModel.nodeCatalog.map((node) => node.id),
    );
    const trackIds = new Set(system.progressionTracks.map((track) => track.id));
    const levelIds = new Set(
      system.progressionTracks.flatMap((track) =>
        track.levels.map((level) => level.id),
      ),
    );
    const methodIds = new Set(system.methods.map((method) => method.id));
    const resourceIds = new Set(
      system.resources.map((resource) => resource.id),
    );
    const abilityIds = new Set(system.abilities.map((ability) => ability.id));
    const topologyIds = new Set(
      system.methods.flatMap((method) =>
        method.operationTopologies.map((topology) => topology.id),
      ),
    );
    const check = (
      ids: readonly string[],
      valid: ReadonlySet<string>,
      label: string,
    ) => {
      ids.forEach((id) => {
        if (!valid.has(id))
          add(`体系“${system.id}”的${label}引用了不存在的 ID“${id}”`);
      });
    };
    const checkRequirements = (
      requirements: readonly ResourceRequirement[],
      label: string,
    ) => {
      requirements.forEach((requirement) => {
        check([requirement.resourceId], resourceIds, `${label}资源`);
        check(
          requirement.substituteResourceIds,
          resourceIds,
          `${label}替代资源`,
        );
      });
    };

    system.theoryModel.nodeCatalog.forEach((node) =>
      register(node.id, "理论节点"),
    );
    system.progressionTracks.forEach((track) => {
      register(track.id, "成长轨道");
      track.metrics.forEach((metric) => register(metric.id, "成长指标"));
      track.levels.forEach((level, levelIndex) => {
        register(level.id, "境界");
        if (level.order !== levelIndex)
          add(
            `成长轨道“${track.id}”的境界“${level.id}”顺序应为 ${levelIndex}，实际为 ${level.order}`,
          );
        check(
          level.metricThresholds.map((item) => item.metricId),
          new Set(track.metrics.map((metric) => metric.id)),
          "境界指标",
        );
        check(level.naturalAbilityIds, abilityIds, "境界自然能力");
        check(level.methodIds, methodIds, "境界法门");
        checkRequirements(level.resourceRequirements, "境界");
        level.subStages.forEach((stage, stageIndex) => {
          register(stage.id, "境内阶段");
          if (stage.order !== stageIndex)
            add(
              `境界“${level.id}”的阶段“${stage.id}”顺序应为 ${stageIndex}，实际为 ${stage.order}`,
            );
          check(
            stage.metricThresholds.map((item) => item.metricId),
            new Set(track.metrics.map((metric) => metric.id)),
            "境内阶段指标",
          );
          check(stage.naturalAbilityIds, abilityIds, "境内阶段自然能力");
          check(stage.methodIds, methodIds, "境内阶段法门");
          checkRequirements(stage.resourceRequirements, "境内阶段");
        });
      });
      track.transitions.forEach((transition) => {
        register(transition.id, "轨道跃迁");
        check(
          [transition.fromLevelId, transition.toLevelId].filter(
            (id): id is string => Boolean(id),
          ),
          new Set(track.levels.map((level) => level.id)),
          "轨道跃迁境界",
        );
        check(transition.methodIds, methodIds, "轨道跃迁法门");
        checkRequirements(transition.resourceRequirements, "轨道跃迁");
      });
    });
    (system.trackInteractions ?? []).forEach((interaction) => {
      register(interaction.id, "轨道交叉规则");
      check(
        [interaction.sourceTrackId, interaction.targetTrackId],
        trackIds,
        "轨道交叉规则轨道",
      );
      if (interaction.sourceTrackId === interaction.targetTrackId)
        add(`体系“${system.id}”的轨道交叉规则“${interaction.id}”不能自引用`);
    });
    const graph = new Map<string, string[]>();
    (system.trackInteractions ?? []).forEach((interaction) => {
      if (
        ["dependency", "cross-breakthrough", "synchronization"].includes(
          interaction.kind,
        )
      )
        graph.set(interaction.sourceTrackId, [
          ...(graph.get(interaction.sourceTrackId) ?? []),
          interaction.targetTrackId,
        ]);
    });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const cycle = (graph.get(id) ?? []).some(visit);
      visiting.delete(id);
      visited.add(id);
      return cycle;
    };
    if ([...trackIds].some(visit))
      add(`体系“${system.id}”的轨道交叉规则存在循环依赖`);

    system.methods.forEach((method) => {
      register(method.id, "法门");
      check(
        [
          method.coverage.startLevelId,
          method.coverage.stableLimitId,
          method.coverage.theoryLimitId,
          method.coverage.absoluteLimitId,
        ].filter((id): id is string => Boolean(id)),
        levelIds,
        "法门覆盖阶段",
      );
      if (options.itemIds) check(method.itemIds, options.itemIds, "法门物品");
      method.courses.forEach((course) => {
        register(course.id, "法门课程");
        check(course.levelId ? [course.levelId] : [], levelIds, "法门课程阶段");
        checkRequirements(course.resourceRequirements, "法门课程");
      });
      method.operationTopologies.forEach((topology) => {
        register(topology.id, "运行拓扑");
        const topologyNodeIds = new Set(topology.nodes.map((node) => node.id));
        topology.nodes.forEach((node) => {
          register(node.id, "拓扑节点");
          check([node.theoryNodeId], nodeIds, "拓扑理论节点");
        });
        topology.edges.forEach((edge) => {
          register(edge.id, "拓扑边");
          check(
            [edge.fromNodeId, edge.toNodeId],
            topologyNodeIds,
            "拓扑边节点",
          );
        });
      });
    });
    system.abilities.forEach((ability) => {
      register(ability.id, "能力");
      check(
        ability.unlockLevelId ? [ability.unlockLevelId] : [],
        levelIds,
        "能力解锁阶段",
      );
      check(ability.trainingRequirements.methodIds, methodIds, "能力训练法门");
      checkRequirements(
        ability.trainingRequirements.resourceRequirements,
        "能力训练",
      );
      check(
        ability.cast.fullPowerLevelId ? [ability.cast.fullPowerLevelId] : [],
        levelIds,
        "能力完整发挥阶段",
      );
      check(
        ability.scriptureSource?.methodId
          ? [ability.scriptureSource.methodId]
          : [],
        methodIds,
        "秘籍来源法门",
      );
      if (options.itemIds)
        check(
          ability.scriptureSource?.itemIds ?? [],
          options.itemIds,
          "秘籍物品",
        );
    });
    system.formations.forEach((formation) => {
      register(formation.id, "阵法");
      check(formation.theoryNodeIds, nodeIds, "阵法理论节点");
      check(formation.requiredLevelIds, levelIds, "阵法阶段");
      check(formation.methodIds, methodIds, "阵法法门");
      check(formation.operationTopologyIds ?? [], topologyIds, "阵法运行拓扑");
      check(formation.abilityIds, abilityIds, "阵法能力");
      checkRequirements(formation.resourceRequirements, "阵法");
      if (options.itemIds)
        check(formation.itemIds, options.itemIds, "阵法物品");
      const ringIds = new Set(formation.design.rings.map((ring) => ring.id));
      const nodeIdsInFormation = new Set(
        formation.nodes.map((node) => node.id),
      );
      formation.nodes.forEach((node) => {
        register(node.id, "阵法节点");
        check(
          node.theoryNodeId ? [node.theoryNodeId] : [],
          nodeIds,
          "阵法节点理论",
        );
        check(node.ringId ? [node.ringId] : [], ringIds, "阵法节点阵环");
      });
      formation.edges.forEach((edge) => {
        register(edge.id, "阵法边");
        check(
          [edge.fromNodeId, edge.toNodeId],
          nodeIdsInFormation,
          "阵法边节点",
        );
      });
      formation.design.rings.forEach((ring) => register(ring.id, "阵环"));
      formation.design.backdropLayers.forEach((layer) =>
        register(layer.id, "阵法底纹"),
      );
    });
    system.foundations.forEach((foundation) => {
      register(foundation.id, "根基");
      check(foundation.affectedTracks, trackIds, "根基影响轨道");
    });
    system.resources.forEach((resource) => {
      register(resource.id, "资源");
      resource.grades.forEach((grade) => register(grade.id, "资源品阶"));
      check(
        resource.bestLevelId ? [resource.bestLevelId] : [],
        levelIds,
        "资源最佳阶段",
      );
      check(resource.usableLevelIds, levelIds, "资源可用阶段");
    });
    system.transitions.forEach((transition) => {
      register(transition.id, "体系跃迁");
      check(
        [transition.fromLevelId, transition.toLevelId].filter(
          (id): id is string => Boolean(id),
        ),
        levelIds,
        "体系跃迁境界",
      );
      check(transition.methodIds, methodIds, "体系跃迁法门");
      checkRequirements(transition.resourceRequirements, "体系跃迁");
    });
    system.constraints.forEach((constraint) => register(constraint.id, "约束"));

    // The full asset catalogue is used by cross-system relation validation.
  });

  const systemIds = new Set(ecology.systems.map((system) => system.id));
  ecology.crossSystemRelations.forEach((relation) => {
    register(relation.id, "跨体系关系");
    checkRelationSystem(relation.sourceSystemId, systemIds, relation.id, add);
    checkRelationSystem(relation.targetSystemId, systemIds, relation.id, add);
    if (relation.sourceSystemId === relation.targetSystemId)
      add(`跨体系关系“${relation.id}”不能引用同一个体系两次`);
    const validAssets = new Set<string>();
    ecology.systems
      .filter((system) =>
        [relation.sourceSystemId, relation.targetSystemId].includes(system.id),
      )
      .forEach((system) =>
        collectSystemAssetIds(system).forEach((id) => validAssets.add(id)),
      );
    (relation.affectedAssetIds ?? []).forEach((id) => {
      if (!validAssets.has(id))
        add(`跨体系关系“${relation.id}”引用了不属于两端体系的资产“${id}”`);
    });
  });
  return errors;
}

function checkRelationSystem(
  id: string,
  valid: ReadonlySet<string>,
  relationId: string,
  add: (message: string) => void,
): void {
  if (!valid.has(id)) add(`跨体系关系“${relationId}”引用了不存在的体系“${id}”`);
}
