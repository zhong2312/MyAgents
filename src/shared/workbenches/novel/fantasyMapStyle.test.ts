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
