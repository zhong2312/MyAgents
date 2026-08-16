export interface AzgaarMapPoint {
  readonly x: number;
  readonly y: number;
}

export interface AzgaarMapFeature {
  readonly id: string;
  readonly kind: "marker" | "label" | "polygon" | "route";
  readonly name: string;
  readonly entityRef: null;
  readonly layerId: string;
  readonly points: readonly AzgaarMapPoint[];
  readonly timeFrom: null;
  readonly timeTo: null;
  readonly props: Readonly<Record<string, string>>;
  readonly description: string;
}

type AzgaarEditableLayer =
  | "state"
  | "province"
  | "biome"
  | "lake"
  | "burg"
  | "marker"
  | "river"
  | "route"
  | "other";

export interface AzgaarMapFeatureSelection {
  /** 进入 MapDocument 的关键可编辑对象。 */
  readonly features: readonly AzgaarMapFeature[];
  /** 官方 Full 导出转换出的全部对象数量。 */
  readonly sourceCount: number;
  /** 保留在 SVG 底图中、未进入可编辑层的细节数量。 */
  readonly omittedCount: number;
  readonly retainedByLayer: Readonly<Record<string, number>>;
  readonly omittedByLayer: Readonly<Record<string, number>>;
}

/**
 * Full JSON 常包含数百城镇、河流和分散生物群系碎片。完整 SVG 已保留其成图
 * 细节，MapDocument 只保留适合继续创作的高层可编辑事实，避免命中检测、重绘
 * 和草稿序列化随 Azgaar 的内部网格规模线性膨胀。
 */
const DEFAULT_EDITABLE_LIMITS: Readonly<Record<AzgaarEditableLayer, number>> =
  Object.freeze({
    state: 48,
    province: 96,
    biome: 48,
    lake: 32,
    burg: 96,
    marker: 24,
    river: 72,
    route: 48,
    other: 24,
  });

function editableLayer(feature: AzgaarMapFeature): AzgaarEditableLayer {
  switch (feature.props.azgaarLayer) {
    case "state":
    case "province":
    case "biome":
    case "lake":
    case "burg":
    case "marker":
    case "river":
    case "route":
      return feature.props.azgaarLayer;
    default:
      return "other";
  }
}

function comparableName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function featureImportance(feature: AzgaarMapFeature): number {
  const explicit = Number(feature.props.azgaarImportance ?? "");
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (feature.kind === "marker" || feature.kind === "label") return 1;
  if (feature.kind === "route") {
    return feature.points.reduce((total, point, index) => {
      const previous = feature.points[index - 1];
      return previous
        ? total + Math.hypot(point.x - previous.x, point.y - previous.y)
        : total;
    }, 0);
  }
  if (feature.kind === "polygon") {
    return Math.abs(
      feature.points.reduce((area, point, index) => {
        const next = feature.points[(index + 1) % feature.points.length]!;
        return area + point.x * next.y - next.x * point.y;
      }, 0) / 2,
    );
  }
  return 0;
}

function countByLayer(
  features: readonly AzgaarMapFeature[],
): Record<string, number> {
  return features.reduce<Record<string, number>>((counts, feature) => {
    const layer = editableLayer(feature);
    counts[layer] = (counts[layer] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * 选择适合进入 MapDocument 的 Azgaar Full JSON 要素。
 *
 * 世界架构显式给出的名称没有限额，始终保留。其余对象按视觉影响力排序后再按
 * 类型限额采样；被省略的对象仍完整留在 Runtime 生成的 SVG 背景中。
 */
export function selectAzgaarMapDocumentFeatures(input: {
  readonly features: readonly AzgaarMapFeature[];
  readonly preserveNames?: readonly string[];
  readonly maximumPerLayer?: Partial<Record<AzgaarEditableLayer, number>>;
}): AzgaarMapFeatureSelection {
  const preservedNames = new Set(
    (input.preserveNames ?? []).map(comparableName).filter(Boolean),
  );
  const limits = { ...DEFAULT_EDITABLE_LIMITS, ...input.maximumPerLayer };
  const selected: AzgaarMapFeature[] = [];
  const grouped = new Map<AzgaarEditableLayer, AzgaarMapFeature[]>();
  input.features.forEach((feature) => {
    const layer = editableLayer(feature);
    const group = grouped.get(layer) ?? [];
    group.push(feature);
    grouped.set(layer, group);
  });
  for (const layer of Object.keys(
    DEFAULT_EDITABLE_LIMITS,
  ) as AzgaarEditableLayer[]) {
    const group = grouped.get(layer) ?? [];
    const ranked = group
      .map((feature, index) => ({
        feature,
        index,
        preserved: preservedNames.has(comparableName(feature.name)),
        importance: featureImportance(feature),
      }))
      .sort(
        (left, right) =>
          Number(right.preserved) - Number(left.preserved) ||
          right.importance - left.importance ||
          left.index - right.index,
      );
    const limit = Math.max(0, Math.floor(limits[layer] ?? 0));
    let ordinaryCount = 0;
    ranked.forEach(({ feature, preserved }) => {
      if (preserved || ordinaryCount < limit) {
        selected.push(feature);
        if (!preserved) ordinaryCount += 1;
      }
    });
  }
  return {
    features: selected,
    sourceCount: input.features.length,
    omittedCount: input.features.length - selected.length,
    retainedByLayer: countByLayer(selected),
    omittedByLayer: countByLayer(
      input.features.filter((feature) => !selected.includes(feature)),
    ),
  };
}

type ExportGeometry = {
  readonly type?: unknown;
  readonly coordinates?: unknown;
};
type ExportFeature = {
  readonly geometry?: ExportGeometry | null;
  readonly properties?: Record<string, unknown> | null;
};

function featurePairs(feature: ExportFeature): [number, number][] {
  if (feature.geometry?.type === "Point") {
    const pointValue = pair(feature.geometry.coordinates);
    return pointValue ? [pointValue] : [];
  }
  return pairs(feature.geometry?.coordinates);
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function pairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const direct = value
    .map(pair)
    .filter((item): item is [number, number] => item !== null);
  return direct.length > 0 ? direct : value.flatMap(pairs);
}

function id(prefix: string, value: unknown, index: number): string {
  const text = String(value ?? index)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `${prefix}-${text || index}`;
}

function name(
  properties: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  for (const key of ["name", "title", "type", "group", "id"]) {
    const value = properties?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

function transform(
  points: readonly [number, number][],
  width: number,
  height: number,
): AzgaarMapPoint[] {
  if (points.length === 0) return [];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sourceWidth = Math.max(0.000001, maxX - minX);
  const sourceHeight = Math.max(0.000001, maxY - minY);
  const padding = Math.min(width, height) * 0.05;
  const scale = Math.min(
    (width - padding * 2) / sourceWidth,
    (height - padding * 2) / sourceHeight,
  );
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;
  return points.map(([x, y]) => ({
    x: Math.max(0, Math.min(width, offsetX + (x - minX) * scale)),
    y: Math.max(0, Math.min(height, height - (offsetY + (y - minY) * scale))),
  }));
}

function mapCanvasPoints(
  points: readonly [number, number][],
  width: number,
  height: number,
  sourceWidth = width,
  sourceHeight = height,
): AzgaarMapPoint[] {
  return points.map(([x, y]) => ({
    x: Math.max(0, Math.min(width, (x / Math.max(1, sourceWidth)) * width)),
    y: Math.max(0, Math.min(height, (y / Math.max(1, sourceHeight)) * height)),
  }));
}

type PackCell = {
  readonly i: number;
  readonly vertices: readonly number[];
  readonly state: number;
  readonly province: number;
  readonly biome: number;
  readonly feature: number;
};

type PackVertex = {
  readonly i: number;
  readonly point: [number, number];
};

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => numberValue(item, -1)).filter((item) => item >= 0)
    : [];
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      )
    : [];
}

function normalizePackCells(value: unknown): PackCell[] {
  const records = recordList(value);
  if (records.length > 0) {
    return records.flatMap((record, index) => {
      const vertices = numberList(record.v ?? record.vertices);
      if (vertices.length < 3) return [];
      return [
        {
          i: numberValue(record.i, index),
          vertices,
          state: numberValue(record.state ?? record.s),
          province: numberValue(record.province),
          biome: numberValue(record.biome ?? record.b),
          feature: numberValue(record.f ?? record.feature),
        },
      ];
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const source = value as Record<string, unknown>;
  const vertices = Array.isArray(source.v) ? source.v : [];
  const states = Array.isArray(source.state)
    ? source.state
    : Array.isArray(source.s)
      ? source.s
      : [];
  const provinces = Array.isArray(source.province) ? source.province : [];
  const biomes = Array.isArray(source.biome) ? source.biome : [];
  const features = Array.isArray(source.f) ? source.f : [];
  const ids = Array.isArray(source.i)
    ? source.i
    : vertices.map((_, index) => index);
  return ids.flatMap((rawId, index) => {
    const cellVertices = numberList(vertices[index]);
    if (cellVertices.length < 3) return [];
    return [
      {
        i: numberValue(rawId, index),
        vertices: cellVertices,
        state: numberValue(states[index]),
        province: numberValue(provinces[index]),
        biome: numberValue(biomes[index]),
        feature: numberValue(features[index]),
      },
    ];
  });
}

function normalizePackVertices(value: unknown): PackVertex[] {
  const records = recordList(value);
  if (records.length > 0) {
    return records.flatMap((record, index) => {
      const point = pair(record.p ?? record.point);
      return point ? [{ i: numberValue(record.i, index), point }] : [];
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const points = (value as Record<string, unknown>).p;
  return Array.isArray(points)
    ? points.flatMap((rawPoint, index) => {
        const point = pair(rawPoint);
        return point ? [{ i: index, point }] : [];
      })
    : [];
}

function colorWithAlpha(value: unknown, alpha: string): string {
  if (typeof value !== "string") return `#8ba07a${alpha}`;
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/iu.test(color)) return `${color}${alpha}`;
  return color;
}

function boundaryRings(
  cells: readonly PackCell[],
  vertices: ReadonlyMap<number, PackVertex>,
): [number, number][][] {
  const edgeBuckets = new Map<string, [number, number][]>();
  for (const cell of cells) {
    for (let index = 0; index < cell.vertices.length; index += 1) {
      const from = cell.vertices[index]!;
      const to = cell.vertices[(index + 1) % cell.vertices.length]!;
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const bucket = edgeBuckets.get(key) ?? [];
      bucket.push([from, to]);
      edgeBuckets.set(key, bucket);
    }
  }
  const edges = [...edgeBuckets.values()]
    .filter((bucket) => bucket.length === 1)
    .map((bucket) => bucket[0]!);
  const outgoing = new Map<number, [number, number][]>();
  edges.forEach((edge) => {
    const list = outgoing.get(edge[0]) ?? [];
    list.push(edge);
    outgoing.set(edge[0], list);
  });
  const used = new Set<string>();
  const rings: [number, number][][] = [];
  const edgeKey = (edge: [number, number]) => `${edge[0]}:${edge[1]}`;
  for (const edge of edges) {
    if (used.has(edgeKey(edge))) continue;
    const ring: [number, number][] = [];
    let current = edge;
    const start = edge[0];
    for (let guard = 0; guard < edges.length + 2; guard += 1) {
      const key = edgeKey(current);
      if (used.has(key)) break;
      used.add(key);
      ring.push(current);
      if (current[1] === start) break;
      const next = (outgoing.get(current[1]) ?? []).find(
        (candidate) => !used.has(edgeKey(candidate)),
      );
      if (!next) break;
      current = next;
    }
    if (ring.length >= 3 && ring.at(-1)?.[1] === start) {
      const pointRing = ring
        .map(([from]) => vertices.get(from)?.point)
        .filter((point): point is [number, number] => Boolean(point));
      if (pointRing.length >= 3) rings.push(pointRing);
    }
  }
  return rings;
}

function sampleRing(
  points: readonly AzgaarMapPoint[],
  maximum = 512,
): AzgaarMapPoint[] {
  if (points.length <= maximum) return [...points];
  const stride = points.length / maximum;
  return Array.from(
    { length: maximum },
    (_, index) => points[Math.floor(index * stride)]!,
  );
}

function convertPackRegions(
  pack: Record<string, unknown>,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  layerId: string,
): AzgaarMapFeature[] {
  const cells = normalizePackCells(pack.cells);
  const vertices = new Map(
    normalizePackVertices(pack.vertices).map((vertex) => [vertex.i, vertex]),
  );
  if (cells.length === 0 || vertices.size === 0) return [];
  const regions: AzgaarMapFeature[] = [];
  const descriptors = [
    {
      field: "state" as const,
      entries: recordList(pack.states),
      prefix: "state",
      terrain: "state",
      alpha: "55",
      fallbackColor: "#a65a4a",
      label: "国家",
    },
    {
      field: "province" as const,
      entries: recordList(pack.provinces),
      prefix: "province",
      terrain: "province",
      alpha: "44",
      fallbackColor: "#6c7ea6",
      label: "省份",
    },
    {
      field: "biome" as const,
      entries: recordList(pack.biomes),
      prefix: "biome",
      terrain: "biome",
      alpha: "4d",
      fallbackColor: "#8e9b65",
      label: "生物群系",
    },
  ] as const;
  for (const descriptor of descriptors) {
    const grouped = new Map<number, PackCell[]>();
    cells.forEach((cell) => {
      const groupId = cell[descriptor.field];
      if (groupId <= 0) return;
      const group = grouped.get(groupId) ?? [];
      group.push(cell);
      grouped.set(groupId, group);
    });
    for (const [groupId, groupCells] of grouped) {
      const metadata = descriptor.entries[groupId] ?? {};
      const groupName = name(metadata, `${descriptor.label} ${groupId}`);
      const groupColor =
        typeof metadata.color === "string"
          ? metadata.color
          : descriptor.fallbackColor;
      boundaryRings(groupCells, vertices).forEach((ring, ringIndex) => {
        const points = sampleRing(
          mapCanvasPoints(ring, width, height, sourceWidth, sourceHeight),
        );
        if (points.length < 3) return;
        regions.push({
          id: id(descriptor.prefix, `${groupId}-${ringIndex}`, ringIndex),
          kind: "polygon",
          name: ringIndex === 0 ? groupName : `${groupName} ${ringIndex + 1}`,
          entityRef: null,
          layerId,
          points,
          timeFrom: null,
          timeTo: null,
          props: {
            color: groupColor,
            fill: colorWithAlpha(groupColor, descriptor.alpha),
            lineWidth: descriptor.field === "state" ? "1.5" : "1",
            showLabel: ringIndex === 0 ? "true" : "false",
            terrain: descriptor.terrain,
            azgaarLayer: descriptor.field,
            azgaarId: String(groupId),
            generator: "azgaar-runtime",
          },
          description: `Azgaar 导出的${descriptor.label}区域，可继续编辑边界。`,
        });
      });
    }
  }

  const featureEntries = recordList(pack.features);
  const groupedFeatures = new Map<number, PackCell[]>();
  cells.forEach((cell) => {
    if (cell.feature <= 0) return;
    const metadata = featureEntries[cell.feature];
    if (typeof metadata?.type !== "string") return;
    const group = groupedFeatures.get(cell.feature) ?? [];
    group.push(cell);
    groupedFeatures.set(cell.feature, group);
  });
  for (const [featureId, groupCells] of groupedFeatures) {
    const metadata = featureEntries[featureId] ?? {};
    const featureType = String(metadata.type).toLocaleLowerCase("en-US");
    if (!featureType.includes("lake") && !featureType.includes("water"))
      continue;
    const groupName = name(metadata, `湖泊 ${featureId}`);
    boundaryRings(groupCells, vertices).forEach((ring, ringIndex) => {
      const points = sampleRing(
        mapCanvasPoints(ring, width, height, sourceWidth, sourceHeight),
      );
      if (points.length < 3) return;
      regions.push({
        id: id("lake", `${featureId}-${ringIndex}`, ringIndex),
        kind: "polygon",
        name: ringIndex === 0 ? groupName : `${groupName} ${ringIndex + 1}`,
        entityRef: null,
        layerId,
        points,
        timeFrom: null,
        timeTo: null,
        props: {
          color: "#3e7895",
          fill: "#76b7d477",
          lineWidth: "1.5",
          terrain: "lake",
          azgaarLayer: "lake",
          azgaarId: String(featureId),
          generator: "azgaar-runtime",
        },
        description: "Azgaar 导出的湖泊区域，可继续编辑水岸边界。",
      });
    });
  }
  return regions;
}

export function convertAzgaarExportToFeatures(input: {
  readonly value: unknown;
  readonly width: number;
  readonly height: number;
  readonly layerId: string;
}): AzgaarMapFeature[] {
  if (
    !input.value ||
    typeof input.value !== "object" ||
    Array.isArray(input.value)
  )
    return [];
  const record = input.value as Record<string, unknown>;
  const result: AzgaarMapFeature[] = [];
  const info =
    record.info &&
    typeof record.info === "object" &&
    !Array.isArray(record.info)
      ? (record.info as Record<string, unknown>)
      : {};
  const sourceWidth = Math.max(1, numberValue(info.width, input.width));
  const sourceHeight = Math.max(1, numberValue(info.height, input.height));
  const addPoint = (entry: unknown, index: number, prefix: string) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const item = entry as Record<string, unknown>;
    const raw = pair([item.x, item.y]);
    if (!raw) return;
    result.push({
      id: id(prefix, item.i, index),
      kind: "marker",
      name:
        typeof item.name === "string" ? item.name : `${prefix} ${index + 1}`,
      entityRef: null,
      layerId: input.layerId,
      points: mapCanvasPoints(
        [raw],
        input.width,
        input.height,
        sourceWidth,
        sourceHeight,
      ),
      timeFrom: null,
      timeTo: null,
      props: {
        color: typeof item.fill === "string" ? item.fill : "#9a4e38",
        showLabel: "true",
        azgaarLayer: prefix === "burg" ? "burg" : "marker",
        azgaarImportance: String(
          Math.max(0, numberValue(item.population ?? item.pop, 0)),
        ),
        generator: "azgaar-runtime",
      },
      description: "Azgaar Fantasy Map Generator 导出的地点候选。",
    });
  };
  const pack = record.pack;
  if (pack && typeof pack === "object" && !Array.isArray(pack)) {
    const source = pack as Record<string, unknown>;
    (Array.isArray(source.burgs) ? source.burgs : []).forEach((entry, index) =>
      addPoint(entry, index, "burg"),
    );
    (Array.isArray(source.markers) ? source.markers : []).forEach(
      (entry, index) => addPoint(entry, index, "marker"),
    );
    for (const collection of ["routes", "rivers"] as const) {
      (Array.isArray(source[collection]) ? source[collection] : []).forEach(
        (entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return;
          const item = entry as Record<string, unknown>;
          const points = mapCanvasPoints(
            pairs(item.points),
            input.width,
            input.height,
            sourceWidth,
            sourceHeight,
          ).slice(0, 512);
          if (points.length < 2) return;
          result.push({
            id: id(collection.slice(0, -1), item.i, index),
            kind: "route",
            name:
              typeof item.name === "string"
                ? item.name
                : `${collection} ${index + 1}`,
            entityRef: null,
            layerId: input.layerId,
            points,
            timeFrom: null,
            timeTo: null,
            props: {
              color: collection === "rivers" ? "#4b87a0" : "#7c684f",
              lineWidth: "2",
              azgaarLayer: collection === "rivers" ? "river" : "route",
              generator: "azgaar-runtime",
            },
            description: "Azgaar Fantasy Map Generator 导出的路线候选。",
          });
        },
      );
    }
    result.push(
      ...convertPackRegions(
        source,
        input.width,
        input.height,
        sourceWidth,
        sourceHeight,
        input.layerId,
      ),
    );
  }
  if (record.type === "FeatureCollection" && Array.isArray(record.features)) {
    const all = (record.features as ExportFeature[]).flatMap(featurePairs);
    const transformedAll = transform(all, input.width, input.height);
    let coordinateCursor = 0;
    const transformCoordinates = (points: readonly [number, number][]) => {
      const transformed = transformedAll.slice(
        coordinateCursor,
        coordinateCursor + points.length,
      );
      coordinateCursor += points.length;
      return transformed;
    };
    (record.features as ExportFeature[]).forEach((feature, index) => {
      const properties = feature.properties;
      const geometryType = feature.geometry?.type;
      const color =
        typeof properties?.stroke === "string" ? properties.stroke : "#7c684f";
      const fill =
        typeof properties?.fill === "string" ? properties.fill : "#8ba07a55";
      const base = {
        entityRef: null,
        layerId: input.layerId,
        timeFrom: null,
        timeTo: null,
        description: "Azgaar Fantasy Map Generator 官方导出候选。",
      } as const;
      const itemName = name(properties, `生成要素 ${index + 1}`);
      const raw = featurePairs(feature);
      if (geometryType === "Point") {
        const pointValue = pair(feature.geometry?.coordinates);
        if (pointValue)
          result.push({
            ...base,
            id: id("generated", properties?.id, index),
            kind: "marker",
            name: itemName,
            points: transformCoordinates([pointValue]),
            props: { color, showLabel: "true", generator: "azgaar-runtime" },
          });
      } else if (
        geometryType === "LineString" ||
        geometryType === "MultiLineString"
      ) {
        const points = transformCoordinates(raw).slice(0, 512);
        if (points.length >= 2)
          result.push({
            ...base,
            id: id("route", properties?.id, index),
            kind: "route",
            name: itemName,
            points,
            props: { color, lineWidth: "2", generator: "azgaar-runtime" },
          });
      } else if (
        geometryType === "Polygon" ||
        geometryType === "MultiPolygon"
      ) {
        const points = transformCoordinates(raw).slice(0, 512);
        if (points.length >= 3)
          result.push({
            ...base,
            id: id("region", properties?.id, index),
            kind: "polygon",
            name: itemName,
            points,
            props: {
              color,
              fill,
              lineWidth: "1",
              showLabel: "true",
              generator: "azgaar-runtime",
            },
          });
      }
    });
  }
  return result;
}
