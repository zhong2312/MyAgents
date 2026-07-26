import type { WorkbenchStorage } from "@/workbench-sdk";

import {
  CULTIVATION_ECOLOGY_SCHEMA_VERSION,
  cultivationEcologySchema,
  type CultivationEcology,
} from "../../../shared/novel-cultivation-ecology-schema";
import { cloneDefaultCultivationEcology } from "./cultivationEcologyDefaults";
import { rebuildCultivationAudits } from "./cultivationEcologyAudit";
import { createFormationBackdropPreset } from "./formationBackdropPresets";

export const CULTIVATION_ECOLOGY_PATH = "world/cultivation-ecology.json";

function serialize(value: CultivationEcology): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeResourceGradeEffects(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as { systems?: unknown };
  if (!Array.isArray(root.systems)) return value;

  const normalized = {
    ...root,
    schemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION,
    systems: root.systems.map((system) => {
      if (!system || typeof system !== "object" || Array.isArray(system))
        return system;
      const systemValue = system as {
        resources?: unknown;
        formations?: unknown;
        projection?: unknown;
        trackInteractions?: unknown;
        progressionTracks?: unknown;
      };
      const resources = systemValue.resources;
      const formations = systemValue.formations;

      return {
        ...systemValue,
        trackInteractions: systemValue.trackInteractions,
        projection: normalizeProjection(
          (systemValue as { projection?: unknown }).projection,
        ),
        progressionTracks: Array.isArray(systemValue.progressionTracks)
          ? systemValue.progressionTracks.map(normalizeProgressionTrack)
          : systemValue.progressionTracks,
        formations: Array.isArray(formations)
          ? formations.map(normalizeFormationExtensions)
          : formations,
        resources: Array.isArray(resources)
          ? resources.map((resource) => {
              if (
                !resource ||
                typeof resource !== "object" ||
                Array.isArray(resource)
              )
                return resource;
              const resourceValue = resource as { grades?: unknown };
              if (!Array.isArray(resourceValue.grades)) return resource;

              return {
                ...resourceValue,
                grades: resourceValue.grades.map((grade) => {
                  if (
                    !grade ||
                    typeof grade !== "object" ||
                    Array.isArray(grade)
                  )
                    return grade;
                  return "effect" in grade ? grade : { ...grade, effect: "" };
                }),
              };
            })
          : resources,
      };
    }),
  };
  return normalized;
}

function normalizeProgressionTrack(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const track = value as Record<string, unknown>;
  if (!Array.isArray(track.levels)) return value;
  return {
    ...track,
    levels: track.levels.map((level) => {
      if (!level || typeof level !== "object" || Array.isArray(level))
        return level;
      const levelValue = level as Record<string, unknown>;
      if (Array.isArray(levelValue.subStages)) return level;
      const levelId =
        typeof levelValue.id === "string" ? levelValue.id : "level";
      return {
        ...levelValue,
        subStages: [
          createMigratedSubStage(levelId, "early", "前期", 0),
          createMigratedSubStage(levelId, "middle", "中期", 1),
          createMigratedSubStage(levelId, "late", "后期", 2),
        ],
      };
    }),
  };
}

function createMigratedSubStage(
  levelId: string,
  suffix: string,
  name: string,
  order: number,
) {
  return {
    id: `${levelId}-stage-${suffix}`,
    name,
    summary: "",
    order,
    metricThresholds: [],
    entryConditions: [],
    completionConditions: [],
    resourceRequirements: [],
    naturalAbilityIds: [],
    methodIds: [],
  };
}

function normalizeFormationExtensions(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const formation = value as Record<string, unknown>;
  const formationId =
    typeof formation.id === "string" ? formation.id : "formation";
  // Stable migration IDs keep repeated parsing idempotent until the upgraded file is persisted.
  const defaultRings = [
    {
      id: `${formationId}-ring-inner`,
      name: "内枢",
      radius: 115,
      style: "double",
      color: "#d9c98f",
      strokeWidth: 2,
      rotation: 0,
      rotating: false,
      runes: "",
      visible: true,
      order: 0,
    },
    {
      id: `${formationId}-ring-pattern`,
      name: "纹环",
      radius: 220,
      style: "runic",
      color: "#74aab7",
      strokeWidth: 1.5,
      rotation: 0,
      rotating: false,
      runes: "道生纹 · 纹生阵 · 气循其理 · ",
      visible: true,
      order: 1,
    },
    {
      id: `${formationId}-ring-domain`,
      name: "域环",
      radius: 330,
      style: "polygon",
      color: "#a87858",
      strokeWidth: 1.5,
      rotation: 30,
      rotating: false,
      runes: "",
      visible: true,
      order: 2,
    },
    {
      id: `${formationId}-ring-boundary`,
      name: "天盘",
      radius: 420,
      style: "double",
      color: "#cdbb8c",
      strokeWidth: 3,
      rotation: 0,
      rotating: false,
      runes: "天地为盘 · 万物为子 · 大道为纹 · 人心为眼 · ",
      visible: true,
      order: 3,
    },
  ];
  const design =
    formation.design &&
    typeof formation.design === "object" &&
    !Array.isArray(formation.design)
      ? (formation.design as Record<string, unknown>)
      : null;
  const fallbackBackdrop = createFormationBackdropPreset(
    "classic",
    (index) => `${formationId}-backdrop-${index + 1}`,
  );
  const palette =
    design?.palette &&
    typeof design.palette === "object" &&
    !Array.isArray(design.palette)
      ? design.palette
      : fallbackBackdrop.palette;
  const effects =
    design?.effects &&
    typeof design.effects === "object" &&
    !Array.isArray(design.effects)
      ? design.effects
      : fallbackBackdrop.effects;
  const backdropLayers =
    design && Array.isArray(design.backdropLayers)
      ? design.backdropLayers
      : fallbackBackdrop.backdropLayers;
  const rings = design
    ? Array.isArray(design.rings)
      ? design.rings
      : defaultRings
    : defaultRings;
  const outerRingId =
    rings.length > 0 &&
    rings[rings.length - 1] &&
    typeof rings[rings.length - 1] === "object" &&
    !Array.isArray(rings[rings.length - 1])
      ? ((rings[rings.length - 1] as Record<string, unknown>).id as string)
      : null;
  const elementLabels = {
    source: "源",
    foundation: "基",
    pattern: "纹",
    eye: "眼",
    domain: "域",
    law: "则",
  } as const;
  const elementColors = {
    source: "#d7aa55",
    foundation: "#a87858",
    pattern: "#74aab7",
    eye: "#d9c98f",
    domain: "#8b87b8",
    law: "#b96c62",
  } as const;
  const elementCycle = [
    "source",
    "foundation",
    "pattern",
    "domain",
    "law",
  ] as const;
  const sourceNodes = Array.isArray(formation.nodes) ? formation.nodes : [];
  const nodes = sourceNodes.map((node, index) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const current = node as Record<string, unknown>;
    const identity = `${String(current.kind ?? "")} ${String(current.name ?? "")}`;
    const inferredElement = /eye|阵眼/iu.test(identity)
      ? "eye"
      : elementCycle[index % elementCycle.length];
    const element =
      typeof current.element === "string" && current.element in elementLabels
        ? (current.element as keyof typeof elementLabels)
        : inferredElement;
    const position =
      current.position &&
      typeof current.position === "object" &&
      !Array.isArray(current.position)
        ? (current.position as Record<string, unknown>)
        : null;
    const x = typeof position?.x === "number" ? position.x : 50;
    const y = typeof position?.y === "number" ? position.y : 50;
    const inferredAngle =
      ((Math.atan2(y - 50, x - 50) * 180) / Math.PI + 90 + 360) % 360;
    return {
      ...current,
      ringId:
        "ringId" in current
          ? current.ringId
          : element === "eye"
            ? null
            : outerRingId,
      angle: current.angle ?? inferredAngle,
      size: current.size ?? (element === "eye" ? 92 : 72),
      color: current.color ?? elementColors[element],
      glyph: current.glyph ?? elementLabels[element],
      element,
      nodeStyle: current.nodeStyle ?? "seal",
    };
  });
  const nodeById = new Map(
    nodes.flatMap((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return [];
      const current = node as Record<string, unknown>;
      return typeof current.id === "string"
        ? [[current.id, current] as const]
        : [];
    }),
  );
  const sourceEdges = Array.isArray(formation.edges) ? formation.edges : [];
  const edges = sourceEdges.map((edge) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) return edge;
    const current = edge as Record<string, unknown>;
    const from =
      typeof current.fromNodeId === "string"
        ? nodeById.get(current.fromNodeId)
        : undefined;
    const to =
      typeof current.toNodeId === "string"
        ? nodeById.get(current.toNodeId)
        : undefined;
    return {
      ...current,
      name:
        current.name ??
        `${String(from?.name ?? current.fromNodeId ?? "阵元")} · ${String(to?.name ?? current.toNodeId ?? "阵元")}`,
      flowType: current.flowType ?? "灵流",
      lineStyle: current.lineStyle ?? "bezier",
      color: current.color ?? from?.color ?? "#d9b86c",
      animated: current.animated ?? true,
    };
  });
  return {
    ...formation,
    design: {
      layout: "concentric",
      canvasStyle: "mystic",
      ...fallbackBackdrop,
      ...design,
      palette,
      effects,
      backdropLayers,
      rings,
    },
    nodes,
    edges,
  };
}

function normalizeProjection(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const projection = value as Record<string, unknown>;
  return {
    ...projection,
    originBindings:
      projection.originBindings === undefined ? [] : projection.originBindings,
  };
}

function parse(content: string): CultivationEcology {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `修行生态 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = cultivationEcologySchema.safeParse(
    normalizeResourceGradeEffects(parsed),
  );
  if (!result.success) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("；"),
    );
  }
  return result.data;
}

function readSchemaVersion(content: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" ? version : null;
}

export function createCultivationEcologyInitializationFiles(): readonly {
  readonly path: string;
  readonly content: string;
}[] {
  return [
    {
      path: CULTIVATION_ECOLOGY_PATH,
      content: serialize(cloneDefaultCultivationEcology()),
    },
  ];
}

export function createCultivationEcologyRepository(storage: WorkbenchStorage) {
  const loadExisting = async () => {
    const file = await storage.readText(CULTIVATION_ECOLOGY_PATH);
    const schemaVersion = readSchemaVersion(file.content);
    if (
      schemaVersion !== null &&
      schemaVersion > CULTIVATION_ECOLOGY_SCHEMA_VERSION
    ) {
      throw new Error(
        `修行生态数据版本 ${schemaVersion} 高于当前支持版本 ${CULTIVATION_ECOLOGY_SCHEMA_VERSION}，请先升级应用。`,
      );
    }
    if (schemaVersion === CULTIVATION_ECOLOGY_SCHEMA_VERSION) {
      return {
        ecology: rebuildCultivationAudits(parse(file.content)),
        content: file.content,
      };
    }
    // 旧版本与无版本数据只做结构化默认补全，不覆盖现有字段，并用 expectedContent 原子升级版本号。
    const migrated = parse(file.content);
    const migratedWithVersion = {
      ...migrated,
      schemaVersion: CULTIVATION_ECOLOGY_SCHEMA_VERSION,
    };
    const auditedMigrated = rebuildCultivationAudits(migratedWithVersion);
    const migratedContent = serialize(auditedMigrated);
    const replacement = await storage.writeText(
      CULTIVATION_ECOLOGY_PATH,
      migratedContent,
      { expectedContent: file.content },
    );
    return {
      ecology: parse(replacement.content),
      content: replacement.content,
    };
  };

  return {
    async load() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_PATH]);
      if (!entry?.exists) return null;
      return loadExisting();
    },
    async initialize() {
      const [entry] = await storage.stat([CULTIVATION_ECOLOGY_PATH]);
      if (entry?.exists) return loadExisting();
      const ecology = cloneDefaultCultivationEcology();
      const audited = rebuildCultivationAudits(ecology);
      const content = serialize(audited);
      await storage.createText(CULTIVATION_ECOLOGY_PATH, content, {
        createParents: true,
      });
      return { ecology: audited, content };
    },
    async save(ecology: CultivationEcology, expectedContent: string) {
      const next = cultivationEcologySchema.parse({
        ...rebuildCultivationAudits(ecology),
        updatedAt: new Date().toISOString(),
      });
      const file = await storage.writeText(
        CULTIVATION_ECOLOGY_PATH,
        serialize(next),
        { expectedContent },
      );
      return { ecology: parse(file.content), content: file.content };
    },
  };
}
