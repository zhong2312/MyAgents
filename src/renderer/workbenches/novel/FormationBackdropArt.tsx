import { memo, useMemo, type CSSProperties, type ReactNode } from "react";

import type { Formation } from "../../../shared/workbenches/novel/cultivationEcologySchema";
import {
  getFormationCanvasSize,
  type FormationBackdropLayer,
} from "./formationBackdropPresets";

const CANVAS_SIZE = 1000;
const CENTER = CANVAS_SIZE / 2;

type FormationPoint = { ringId: string | null; x: number; y: number };

type FormationBackdropArtProps = {
  formationId: string;
  design: Formation["design"];
  points: readonly FormationPoint[];
  motionEnabled: boolean;
};

function polarPoint(radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: CENTER + Math.cos(radians) * radius,
    y: CENTER + Math.sin(radians) * radius,
  };
}

function polygonPoints(radius: number, sides: number, rotation = 0) {
  return Array.from(
    { length: Math.max(3, Math.min(24, sides)) },
    (_, index) => {
      const point = polarPoint(radius, rotation + (index / sides) * 360);
      return `${point.x},${point.y}`;
    },
  ).join(" ");
}

function steppedPolygonPath(
  radius: number,
  sides: number,
  step: number,
  rotation = 0,
) {
  const boundedSides = Math.max(3, Math.min(24, sides));
  const boundedStep = Math.max(1, Math.min(boundedSides - 1, step));
  const visited = new Set<number>();
  const paths: string[] = [];
  for (let start = 0; start < boundedSides; start += 1) {
    if (visited.has(start)) continue;
    const segment: string[] = [];
    let index = start;
    do {
      visited.add(index);
      const point = polarPoint(radius, rotation + (index / boundedSides) * 360);
      segment.push(`${segment.length === 0 ? "M" : "L"} ${point.x} ${point.y}`);
      index = (index + boundedStep) % boundedSides;
    } while (index !== start && !visited.has(index));
    if (segment.length > 1) paths.push(`${segment.join(" ")} Z`);
  }
  return paths.join(" ");
}

function starPoints(
  radius: number,
  points: number,
  innerRatio: number,
  rotation = 0,
) {
  const boundedPoints = Math.max(3, Math.min(32, points));
  return Array.from({ length: boundedPoints * 2 }, (_, index) => {
    const point = polarPoint(
      index % 2 === 0 ? radius : radius * innerRatio,
      rotation + (index / (boundedPoints * 2)) * 360,
    );
    return `${point.x},${point.y}`;
  }).join(" ");
}

function runePath(radius: number) {
  return `M ${CENTER - radius},${CENTER} a ${radius},${radius} 0 1,1 ${radius * 2},0 a ${radius},${radius} 0 1,1 ${-radius * 2},0`;
}

function renderOrnament(
  symbol: FormationBackdropLayer["symbol"],
  secondaryColor: string,
) {
  const common = { vectorEffect: "non-scaling-stroke" as const };
  if (symbol === "circuit") {
    return (
      <path
        d="M -23 10 H -14 V -10 H -5 V -21 H 7 V -8 H 18 V 1 H 25 V 14 H 12 V 22 H -2 V 12 H -12 V 20 H -23 Z"
        {...common}
      />
    );
  }
  if (symbol === "crystal") {
    return (
      <>
        <polygon points="0,-34 22,-9 13,28 -13,28 -22,-9" {...common} />
        <path d="M 0 -34 L 0 28 M -22 -9 L 22 -9 L 0 28 Z" {...common} />
      </>
    );
  }
  if (symbol === "gate") {
    return (
      <>
        <polygon points="0,-42 28,-13 21,23 0,42 -21,23 -28,-13" {...common} />
        <polygon
          points="0,-27 14,-8 10,18 0,27 -10,18 -14,-8"
          fill="none"
          stroke={secondaryColor}
          {...common}
        />
      </>
    );
  }
  return <polygon points="0,-26 22,0 0,26 -22,0" {...common} />;
}

function renderCore(layer: FormationBackdropLayer) {
  const common = { vectorEffect: "non-scaling-stroke" as const };
  if (layer.symbol === "eye") {
    const radius = layer.radius;
    const vertical = radius * 0.54;
    return (
      <>
        <path
          d={`M ${CENTER - radius} ${CENTER} Q ${CENTER} ${CENTER - vertical} ${CENTER + radius} ${CENTER} Q ${CENTER} ${CENTER + vertical} ${CENTER - radius} ${CENTER} Z`}
          {...common}
        />
        <circle cx={CENTER} cy={CENTER} r={radius * 0.36} {...common} />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={radius * 0.12}
          fill={layer.secondaryColor}
          fillOpacity={0.14}
          {...common}
        />
      </>
    );
  }
  if (layer.symbol === "star") {
    return (
      <polygon
        points={starPoints(layer.radius, Math.max(6, layer.count), 0.48)}
        {...common}
      />
    );
  }
  if (layer.symbol === "void") {
    return (
      <>
        <circle cx={CENTER} cy={CENTER} r={layer.radius} {...common} />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={layer.radius * 0.64}
          stroke={layer.secondaryColor}
          strokeDasharray="4 6"
          {...common}
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={layer.radius * 0.22}
          fill={layer.color}
          fillOpacity={0.12}
          {...common}
        />
      </>
    );
  }
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={layer.radius} {...common} />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={layer.radius * 0.72}
        stroke={layer.secondaryColor}
        {...common}
      />
      <polygon
        points={polygonPoints(layer.radius * 0.58, 8, 22.5)}
        stroke={layer.secondaryColor}
        {...common}
      />
    </>
  );
}

function renderLayer(layer: FormationBackdropLayer): ReactNode {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: layer.strokeWidth,
    vectorEffect: "non-scaling-stroke" as const,
  };
  if (layer.type === "ring") {
    const count = Math.max(1, Math.min(8, layer.count));
    return Array.from({ length: count }, (_, index) => {
      const offset = (index - (count - 1) / 2) * layer.spacing;
      return (
        <circle
          key={index}
          cx={CENTER}
          cy={CENTER}
          r={Math.max(20, Math.min(1000, layer.radius + offset))}
          {...common}
        />
      );
    });
  }
  if (layer.type === "rune-band") {
    return (
      <>
        <circle cx={CENTER} cy={CENTER} r={layer.radius} {...common} />
        <text className="ce-formation-backdrop-runes">
          <textPath
            href={`#formation-backdrop-rune-${layer.id}`}
            startOffset="1%"
          >
            {layer.text.repeat(Math.min(16, layer.repeat)).slice(0, 600)}
          </textPath>
        </text>
      </>
    );
  }
  if (layer.type === "polygon") {
    return (
      <path
        d={steppedPolygonPath(
          layer.radius,
          layer.sides,
          layer.step,
          layer.rotation,
        )}
        {...common}
      />
    );
  }
  if (layer.type === "star") {
    return (
      <polygon
        points={starPoints(
          layer.radius,
          Math.max(3, Math.min(32, layer.count)),
          layer.innerRatio,
        )}
        {...common}
      />
    );
  }
  if (layer.type === "radial-rays") {
    return Array.from(
      { length: Math.max(1, Math.min(96, layer.count)) },
      (_, index) => {
        const angle = (index / Math.max(1, layer.count)) * 360;
        const start = polarPoint(layer.innerRadius, angle);
        const end = polarPoint(layer.radius, angle);
        return (
          <line
            key={index}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            {...common}
          />
        );
      },
    );
  }
  if (layer.type === "arc-petals") {
    return Array.from(
      { length: Math.max(1, Math.min(12, layer.count)) },
      (_, index) => (
        <path
          key={index}
          d={`M ${CENTER - layer.radius} ${CENTER} Q ${CENTER} ${CENTER - layer.radius * layer.curvature} ${CENTER + layer.radius} ${CENTER} Q ${CENTER} ${CENTER + layer.radius * layer.curvature} ${CENTER - layer.radius} ${CENTER} Z`}
          transform={`rotate(${layer.rotation + (index / Math.max(1, layer.count)) * 180} ${CENTER} ${CENTER})`}
          {...common}
        />
      ),
    );
  }
  if (layer.type === "ornament-ring") {
    return Array.from(
      { length: Math.max(1, Math.min(32, layer.count)) },
      (_, index) => {
        const angle = layer.rotation + (index / Math.max(1, layer.count)) * 360;
        const point = polarPoint(layer.radius, angle);
        return (
          <g
            key={index}
            transform={`translate(${point.x} ${point.y}) rotate(${angle})`}
            {...common}
          >
            {renderOrnament(layer.symbol, layer.secondaryColor)}
          </g>
        );
      },
    );
  }
  return renderCore(layer);
}

function FormationBackdropArtComponent({
  formationId,
  design,
  points,
  motionEnabled,
}: FormationBackdropArtProps) {
  const visibleLayers = useMemo(
    () =>
      [...design.backdropLayers]
        .filter((layer) => layer.visible)
        .sort((left, right) => left.order - right.order),
    [design.backdropLayers],
  );
  const visibleRings = useMemo(
    () =>
      [...design.rings]
        .filter((ring) => ring.visible)
        .sort((left, right) => left.order - right.order),
    [design.rings],
  );
  const canvasSize = getFormationCanvasSize(design);
  const canvasOffset = (canvasSize - CANVAS_SIZE) / 2;
  const hasIndividualRotation =
    visibleLayers.some((layer) => layer.rotating) ||
    visibleRings.some((ring) => ring.rotating);
  const glowId = `formation-glow-${formationId}`;
  const motionClass =
    motionEnabled &&
    design.effects.motion !== "still" &&
    !(design.effects.motion === "rotate" && hasIndividualRotation)
      ? `is-${design.effects.motion}`
      : "is-still";
  const artStyle = {
    "--formation-backdrop-glow": design.palette.glow,
    "--formation-backdrop-color": design.backgroundColor,
  } as CSSProperties;
  return (
    <div
      className={`ce-formation-backdrop is-${design.canvasStyle}`}
      style={artStyle}
      aria-hidden="true"
    >
      <svg
        viewBox={`${-canvasOffset} ${-canvasOffset} ${canvasSize} ${canvasSize}`}
      >
        <defs>
          <filter id={glowId} x="-12%" y="-12%" width="124%" height="124%">
            <feGaussianBlur
              stdDeviation={0.5 + design.effects.glowStrength * 3}
              result="blur"
            />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {visibleLayers
            .filter((layer) => layer.type === "rune-band")
            .map((layer) => (
              <path
                key={layer.id}
                id={`formation-backdrop-rune-${layer.id}`}
                d={runePath(layer.radius)}
                fill="none"
              />
            ))}
          {visibleRings.map((ring) => (
            <path
              key={ring.id}
              id={`formation-rune-path-${ring.id}`}
              d={runePath(ring.radius)}
              fill="none"
            />
          ))}
        </defs>
        <g
          className={`ce-formation-procedural-art ${motionClass}`}
          filter={
            design.effects.glowStrength > 0.05 ? `url(#${glowId})` : undefined
          }
        >
          {visibleLayers.map((layer) => (
            <g
              key={layer.id}
              className={`ce-formation-backdrop-layer is-${layer.type}`}
              style={{
                color: layer.color,
                opacity: layer.opacity * design.effects.lineOpacity,
              }}
              transform={
                layer.type === "polygon" ||
                layer.type === "arc-petals" ||
                layer.type === "ornament-ring"
                  ? undefined
                  : `rotate(${layer.rotation} ${CENTER} ${CENTER})`
              }
            >
              <g
                className={`ce-formation-layer-rotator ${motionEnabled && layer.rotating ? "is-rotating" : ""}`}
              >
                {renderLayer(layer)}
              </g>
            </g>
          ))}
        </g>
        <g className="ce-formation-structural-rings">
          {visibleRings.map((ring) => {
            const ringPoints = points.filter(
              (point) => point.ringId === ring.id,
            );
            return (
              <g
                key={ring.id}
                className={`ce-formation-ring is-${ring.style}`}
                style={{
                  color: ring.color,
                  opacity: design.effects.lineOpacity * 0.8,
                }}
              >
                <g transform={`rotate(${ring.rotation} ${CENTER} ${CENTER})`}>
                  <g
                    className={`ce-formation-ring-rotator ${motionEnabled && ring.rotating ? "is-rotating" : ""}`}
                  >
                    {ring.style === "polygon" ? (
                      <polygon
                        points={polygonPoints(ring.radius, 12)}
                        strokeWidth={ring.strokeWidth}
                      />
                    ) : (
                      <circle
                        cx={CENTER}
                        cy={CENTER}
                        r={ring.radius}
                        strokeWidth={ring.strokeWidth}
                        strokeDasharray={
                          ring.style === "dashed" ? "16 12" : undefined
                        }
                      />
                    )}
                    {ring.style === "double" && (
                      <>
                        <circle
                          cx={CENTER}
                          cy={CENTER}
                          r={Math.max(36, ring.radius - 8)}
                          strokeWidth={Math.max(0.75, ring.strokeWidth * 0.45)}
                        />
                        <circle
                          cx={CENTER}
                          cy={CENTER}
                          r={Math.min(1008, ring.radius + 8)}
                          strokeWidth={Math.max(0.75, ring.strokeWidth * 0.45)}
                        />
                      </>
                    )}
                    {ring.runes.trim() && (
                      <text className="ce-formation-rune-text">
                        <textPath
                          href={`#formation-rune-path-${ring.id}`}
                          startOffset="1%"
                        >
                          {ring.runes.repeat(5).slice(0, 600)}
                        </textPath>
                      </text>
                    )}
                  </g>
                </g>
                {ringPoints.length >= 3 && (
                  <polygon
                    className="ce-formation-node-polygon"
                    points={ringPoints
                      .map((point) => `${point.x},${point.y}`)
                      .join(" ")}
                  />
                )}
                <text
                  className="ce-formation-ring-name"
                  x={CENTER}
                  y={CENTER - ring.radius + 16}
                  textAnchor="middle"
                >
                  {ring.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

const FormationBackdropArt = memo(FormationBackdropArtComponent);

export default FormationBackdropArt;
