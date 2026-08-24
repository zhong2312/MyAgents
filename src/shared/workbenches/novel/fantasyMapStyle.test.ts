import { describe, expect, it } from "vitest";

import {
  applyFantasyMapSvgStyle,
  FANTASY_MAP_STYLE_ID,
  fantasyChineseName,
  localizeFantasyMapFeatures,
} from "./fantasyMapStyle";

function feature(input: {
  readonly kind: "area" | "route" | "marker";
  readonly name: string;
  readonly props?: Readonly<Record<string, string>>;
}) {
  return {
    id: `${input.kind}-1`,
    kind: input.kind,
    name: input.name,
    entityRef: null,
    layerId: "layer-main",
    points: [{ x: 10, y: 20 }],
    timeFrom: null,
    timeTo: null,
    props: input.props ?? {},
    description: "测试要素",
  } as const;
}

describe("fantasy map style adapter", () => {
  it("将英文 Azgaar 要素转换为稳定的中文玄幻名称并保留已有中文名", () => {
    const localized = localizeFantasyMapFeatures(
      [
        feature({
          kind: "area",
          name: "The Northern State",
          props: { azgaarLayer: "state" },
        }),
        feature({
          kind: "route",
          name: "River 12",
          props: { azgaarLayer: "river" },
        }),
        feature({
          kind: "marker",
          name: "云中城",
          props: { azgaarLayer: "burg" },
        }),
      ],
      "style-seed",
    );

    expect(localized[0]?.name).toMatch(/[\u3400-\u9fff]/u);
    expect(localized[1]?.name).toMatch(/[\u3400-\u9fff]/u);
    expect(localized[2]?.name).toBe("云中城");
    expect(
      localized.every(
        (item) => item.props.fantasyStyle === FANTASY_MAP_STYLE_ID,
      ),
    ).toBe(true);
    expect(localized[0]?.props.azgaarShowLabel).toBe("true");
  });

  it("优先使用地图规划中的 Agent 中文命名，而非兼容名称池", () => {
    const name = fantasyChineseName(
      feature({
        kind: "area",
        name: "Northern State",
        props: { azgaarLayer: "state" },
      }),
      "plan-name-seed",
      0,
      {
        entries: [
          {
            id: "north-state-name",
            role: "state",
            name: "北荒道",
            rationale: "世界架构中的北方州域。",
          },
        ],
      },
    );
    expect(name).toBe("北荒道");
  });

  it("将兼容生成器的中文通用占位名替换为正式命名目录", () => {
    const [localized] = localizeFantasyMapFeatures(
      [
        feature({
          kind: "route",
          name: "河流 1",
          props: { terrain: "river", generatedName: "true" },
        }),
      ],
      "semantic-name-seed",
      {
        entries: [
          {
            id: "canglan-river",
            role: "river",
            name: "沧澜河",
            rationale: "规划中的中州主河。",
          },
        ],
      },
    );
    expect(localized?.name).toBe("沧澜河");
    expect(localized?.props).not.toHaveProperty("generatedName");
  });

  it("按规划实体角色生成不同的中文标签层级", () => {
    const localized = localizeFantasyMapFeatures(
      [
        feature({
          kind: "marker",
          name: "玄冰宫",
          props: { entityRole: "sect", importance: "4" },
        }),
        feature({
          kind: "route",
          name: "天池河",
          props: { entityRole: "waterway", terrain: "river" },
        }),
        feature({
          kind: "route",
          name: "北境雪岭",
          props: { entityRole: "mountain", terrain: "mountain" },
        }),
      ],
      "label-hierarchy",
    );
    expect(localized[0]?.props).toMatchObject({
      labelFont: "cartographer",
      labelSize: "16",
      labelPriority: "4",
    });
    expect(localized[1]?.props).toMatchObject({
      labelFont: "cartographer",
      labelFollowPath: "true",
      labelItalic: "true",
      labelHaloColor: "#edf3ed",
    });
    expect(localized[2]?.props).toMatchObject({
      labelFont: "atlas-serif",
      labelFollowPath: "true",
    });
  });

  it("对中文名称保持幂等，并为缺少中文名的要素提供确定性名称", () => {
    const input = feature({
      kind: "area",
      name: "英文区域",
      props: { terrain: "biome" },
    });
    expect(fantasyChineseName(input, "seed", 0)).toBe(
      fantasyChineseName(input, "seed", 0),
    );
    expect(
      fantasyChineseName(feature({ kind: "area", name: "天玄州" }), "seed", 0),
    ).toBe("天玄州");
  });

  it("将 Azgaar SVG 适配为玄幻底图并隐藏原始英文文字", () => {
    const styled = applyFantasyMapSvgStyle(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Northland</text><path id="ocean" /></svg>',
    );
    expect(styled).toContain("myagents-fantasy-map-style");
    expect(styled).toContain("text { display: none");
    expect(styled).toContain("Noto Serif CJK SC");
    expect(styled).toContain("#356f83");
    expect(styled).toContain("#806348");
    expect(styled).toContain("<svg");
  });
});
