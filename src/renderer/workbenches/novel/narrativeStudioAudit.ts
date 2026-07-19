import {
  resolveCreativeProfile,
  type CreativeDefinitionScope,
  type CreativeProfile,
  type InspirationLibrary,
  type NarrativeChecklistItem,
  type NarrativeDesign,
  type NarrativeObjectKind,
  type ResolvedCreativeDefinition,
} from "./narrativeStudioSchema";

export interface NarrativeAuditIssue {
  readonly id: string;
  readonly severity: "error" | "warning" | "suggestion";
  readonly source: string;
  readonly title: string;
  readonly detail: string;
  readonly targetKind: NarrativeObjectKind | null;
  readonly targetId: string | null;
}

function addMissingReferences(
  issues: NarrativeAuditIssue[],
  source: string,
  ownerKind: NarrativeObjectKind,
  ownerId: string,
  ownerTitle: string,
  relationLabel: string,
  ids: readonly string[],
  existing: ReadonlySet<string>,
) {
  ids.forEach((id) => {
    if (existing.has(id)) return;
    issues.push({
      id: `missing:${ownerKind}:${ownerId}:${relationLabel}:${id}`,
      severity: "error",
      source,
      title: `${ownerTitle} 存在失效引用`,
      detail: `${relationLabel}指向不存在的对象：${id}`,
      targetKind: ownerKind,
      targetId: ownerId,
    });
  });
}

function auditStructureCycles(
  structures: NarrativeDesign["structures"],
  issues: NarrativeAuditIssue[],
): void {
  const structureById = new Map(structures.map((item) => [item.id, item]));
  const reportedCycles = new Set<string>();

  structures.forEach((start) => {
    const path: string[] = [];
    const positionById = new Map<string, number>();
    let currentId: string | null = start.id;

    while (currentId && structureById.has(currentId)) {
      const cycleStart = positionById.get(currentId);
      if (cycleStart !== undefined) {
        const cycleIds = path.slice(cycleStart);
        const cycleKey = [...cycleIds].sort().join("|");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          const cycleLabels = cycleIds.map(
            (id) => structureById.get(id)?.title ?? id,
          );
          issues.push({
            id: `structure-cycle:${cycleKey}`,
            severity: "error",
            source: "通用内核",
            title: `${cycleLabels[0]} 存在父级循环`,
            detail: `${cycleLabels.join(" -> ")} -> ${cycleLabels[0]}`,
            targetKind: "structure",
            targetId: cycleIds[0] ?? null,
          });
        }
        break;
      }

      positionById.set(currentId, path.length);
      path.push(currentId);
      currentId = structureById.get(currentId)?.parentId ?? null;
    }
  });
}

function auditChecklist(
  issues: NarrativeAuditIssue[],
  ownerKind: NarrativeObjectKind,
  ownerId: string,
  ownerTitle: string,
  scope: CreativeDefinitionScope,
  checklist: readonly NarrativeChecklistItem[],
  definitions: readonly ResolvedCreativeDefinition[],
): void {
  const applicableDefinitions = definitions.filter(
    (definition) =>
      definition.category === "check" && definition.scope === scope,
  );
  const definitionById = new Map(
    applicableDefinitions.map((definition) => [definition.id, definition]),
  );
  const attachedDefinitionIds = new Set(
    checklist.flatMap((item) =>
      item.sourceDefinitionId ? [item.sourceDefinitionId] : [],
    ),
  );

  applicableDefinitions.forEach((definition) => {
    if (attachedDefinitionIds.has(definition.id)) return;
    issues.push({
      id: `unattached-check:${ownerKind}:${ownerId}:${definition.id}`,
      severity: "warning",
      source: definition.layerName,
      title: `${ownerTitle} 尚未执行 ${definition.name}`,
      detail: definition.description || "当前创作方案要求执行该检查项。",
      targetKind: ownerKind,
      targetId: ownerId,
    });
  });

  checklist.forEach((check) => {
    const source = check.sourceDefinitionId
      ? definitionById.get(check.sourceDefinitionId)
      : undefined;
    if (check.sourceDefinitionId && !source) {
      issues.push({
        id: `inactive-check:${ownerKind}:${ownerId}:${check.id}`,
        severity: "suggestion",
        source: "创作方案",
        title: `${ownerTitle} 保留了已停用检查`,
        detail: `${check.label} 的来源定义 ${check.sourceDefinitionId} 当前未启用。`,
        targetKind: ownerKind,
        targetId: ownerId,
      });
    }
    if (check.status !== "pending") return;
    issues.push({
      id: `check:${ownerKind}:${ownerId}:${check.id}`,
      severity: "warning",
      source: source?.layerName ?? "项目检查项",
      title: `${ownerTitle} 尚未通过验收`,
      detail: check.label,
      targetKind: ownerKind,
      targetId: ownerId,
    });
  });
}

export function auditNarrativeStudio(
  narrative: NarrativeDesign,
  inspirations: InspirationLibrary,
  profile: CreativeProfile,
  chapterIds: ReadonlySet<string>,
): readonly NarrativeAuditIssue[] {
  const issues: NarrativeAuditIssue[] = [];
  const structureIds = new Set(narrative.structures.map((item) => item.id));
  const threadIds = new Set(narrative.threads.map((item) => item.id));
  const arcIds = new Set(narrative.arcs.map((item) => item.id));
  const nodeIds = new Set(narrative.nodes.map((item) => item.id));
  const expectationIds = new Set(
    narrative.expectations.map((item) => item.id),
  );
  const chapterPlanIds = new Set(
    narrative.chapterPlans.map((item) => item.id),
  );
  const objectIds: Readonly<Record<NarrativeObjectKind, ReadonlySet<string>>> = {
    structure: structureIds,
    thread: threadIds,
    arc: arcIds,
    node: nodeIds,
    expectation: expectationIds,
    "chapter-plan": chapterPlanIds,
  };
  const resolvedProfile = resolveCreativeProfile(profile);

  auditStructureCycles(narrative.structures, issues);

  narrative.structures.forEach((item) => {
    if (item.parentId && !structureIds.has(item.parentId)) {
      addMissingReferences(
        issues,
        "通用内核",
        "structure",
        item.id,
        item.title,
        "上级结构",
        [item.parentId],
        structureIds,
      );
    }
    auditChecklist(
      issues,
      "structure",
      item.id,
      item.title,
      "structure",
      item.acceptanceCriteria,
      resolvedProfile.definitions,
    );
  });

  narrative.threads.forEach((item) => {
    auditChecklist(
      issues,
      "thread",
      item.id,
      item.title,
      "thread",
      item.checklist,
      resolvedProfile.definitions,
    );
  });

  narrative.arcs.forEach((item) => {
    addMissingReferences(
      issues,
      "通用内核",
      "arc",
      item.id,
      item.title,
      "线路",
      item.threadIds,
      threadIds,
    );
    addMissingReferences(
      issues,
      "通用内核",
      "arc",
      item.id,
      item.title,
      "结构",
      item.stages.flatMap((stage) =>
        stage.structureId ? [stage.structureId] : [],
      ),
      structureIds,
    );
    addMissingReferences(
      issues,
      "通用内核",
      "arc",
      item.id,
      item.title,
      "章节锚点",
      item.stages.flatMap((stage) =>
        stage.chapterId ? [stage.chapterId] : [],
      ),
      chapterIds,
    );
    if (item.stages.length < 2) {
      issues.push({
        id: `arc-stages:${item.id}`,
        severity: "suggestion",
        source: "通用内核",
        title: `${item.title} 尚未形成完整变化`,
        detail: "故事弧至少需要起点和终点两个状态。",
        targetKind: "arc",
        targetId: item.id,
      });
    }
    auditChecklist(
      issues,
      "arc",
      item.id,
      item.title,
      "arc",
      item.checklist,
      resolvedProfile.definitions,
    );
  });

  narrative.nodes.forEach((item) => {
    addMissingReferences(issues, "通用内核", "node", item.id, item.title, "线路", item.threadIds, threadIds);
    addMissingReferences(issues, "通用内核", "node", item.id, item.title, "故事弧", item.arcIds, arcIds);
    addMissingReferences(
      issues,
      "通用内核",
      "node",
      item.id,
      item.title,
      "结构",
      item.structureId ? [item.structureId] : [],
      structureIds,
    );
    addMissingReferences(
      issues,
      "通用内核",
      "node",
      item.id,
      item.title,
      "章节锚点",
      item.chapterId ? [item.chapterId] : [],
      chapterIds,
    );
    if (!item.threadIds.length) {
      issues.push({
        id: `node-thread:${item.id}`,
        severity: "suggestion",
        source: "通用内核",
        title: `${item.title} 尚未接入叙事线路`,
        detail: "孤立节点不会出现在任何线路推进中。",
        targetKind: "node",
        targetId: item.id,
      });
    }
    auditChecklist(
      issues,
      "node",
      item.id,
      item.title,
      "node",
      item.checklist,
      resolvedProfile.definitions,
    );
  });

  narrative.expectations.forEach((item) => {
    addMissingReferences(issues, "通用内核", "expectation", item.id, item.title, "线路", item.threadIds, threadIds);
    const fulfillments = item.milestones.filter(
      (milestone) => milestone.kind === "fulfill",
    );
    if (item.status === "open" && !fulfillments.length) {
      issues.push({
        id: `expectation-payoff:${item.id}`,
        severity: "warning",
        source: "通用内核",
        title: `${item.title} 尚未安排兑现`,
        detail: "开放期待至少应有一个计划兑现节点。",
        targetKind: "expectation",
        targetId: item.id,
      });
    }
    item.milestones
      .filter(
        (milestone) =>
          milestone.chapterId && !chapterIds.has(milestone.chapterId),
      )
      .forEach((milestone) => {
        issues.push({
          id: `actual-chapter:${item.id}:${milestone.id}`,
          severity: "error",
          source: "通用内核",
          title: `${item.title} 的章节锚点不存在`,
          detail: `${milestone.label} 指向 ${milestone.chapterId}`,
          targetKind: "expectation",
          targetId: item.id,
        });
      });
    auditChecklist(
      issues,
      "expectation",
      item.id,
      item.title,
      "expectation",
      item.checklist,
      resolvedProfile.definitions,
    );
  });

  const requiredChapterFields = resolvedProfile.definitions.filter(
    (item) =>
      item.category === "field" && item.scope === "chapter" && item.required,
  );
  narrative.chapterPlans.forEach((item) => {
    addMissingReferences(issues, "通用内核", "chapter-plan", item.id, item.title, "线路", item.threadIds, threadIds);
    addMissingReferences(issues, "通用内核", "chapter-plan", item.id, item.title, "故事弧", item.arcIds, arcIds);
    addMissingReferences(issues, "通用内核", "chapter-plan", item.id, item.title, "期待", item.expectationIds, expectationIds);
    addMissingReferences(
      issues,
      "通用内核",
      "chapter-plan",
      item.id,
      item.title,
      "正文章节",
      item.chapterId ? [item.chapterId] : [],
      chapterIds,
    );
    if (!item.objective.trim()) {
      issues.push({
        id: `chapter-objective:${item.id}`,
        severity: "warning",
        source: "通用内核",
        title: `${item.title} 缺少章节目标`,
        detail: "章节目标为空，无法判断本章是否完成推进。",
        targetKind: "chapter-plan",
        targetId: item.id,
      });
    }
    requiredChapterFields.forEach((field) => {
      if (item.deliveryValues[field.id]?.trim()) return;
      issues.push({
        id: `required-delivery:${item.id}:${field.id}`,
        severity: "warning",
        source: field.layerName,
        title: `${item.title} 缺少 ${field.name}`,
        detail: field.description || "该交付字段由当前创作方案声明为必填。",
        targetKind: "chapter-plan",
        targetId: item.id,
      });
    });
    auditChecklist(
      issues,
      "chapter-plan",
      item.id,
      item.title,
      "chapter",
      item.checklist,
      resolvedProfile.definitions,
    );
  });

  const chapterPlanGroups = new Map<string, typeof narrative.chapterPlans>();
  narrative.chapterPlans.forEach((plan) => {
    if (!plan.chapterId) return;
    chapterPlanGroups.set(plan.chapterId, [
      ...(chapterPlanGroups.get(plan.chapterId) ?? []),
      plan,
    ]);
  });
  chapterPlanGroups.forEach((plans, chapterId) => {
    if (plans.length < 2) return;
    issues.push({
      id: `duplicate-chapter-plan:${chapterId}`,
      severity: "error",
      source: "通用内核",
      title: "同一正文章节关联了多个章节计划",
      detail: plans.map((plan) => plan.title).join("、"),
      targetKind: "chapter-plan",
      targetId: plans[0]?.id ?? null,
    });
  });

  narrative.relations.forEach((relation) => {
    if (!objectIds[relation.fromKind].has(relation.fromId)) {
      issues.push({
        id: `relation-from:${relation.id}`,
        severity: "error",
        source: "通用内核",
        title: "关系起点不存在",
        detail: `${relation.fromKind} / ${relation.fromId}`,
        targetKind: null,
        targetId: null,
      });
    }
    if (!objectIds[relation.toKind].has(relation.toId)) {
      issues.push({
        id: `relation-to:${relation.id}`,
        severity: "error",
        source: "通用内核",
        title: "关系终点不存在",
        detail: `${relation.toKind} / ${relation.toId}`,
        targetKind: null,
        targetId: null,
      });
    }
  });

  inspirations.adoptions.forEach((adoption) => {
    if (objectIds[adoption.targetKind].has(adoption.targetId)) return;
    issues.push({
      id: `adoption-target:${adoption.id}`,
      severity: "error",
      source: "灵感采用关系",
      title: `${adoption.targetLabel} 已不存在`,
      detail: "采用记录被保留，但目标对象引用已经失效。",
      targetKind: null,
      targetId: null,
    });
  });

  resolvedProfile.conflicts.forEach((conflict) => {
    issues.push({
      id: `profile:${conflict.id}`,
      severity: conflict.severity,
      source: "创作方案",
      title: "创作方案存在阻断冲突",
      detail: conflict.message,
      targetKind: null,
      targetId: null,
    });
  });

  return Object.freeze(issues);
}
