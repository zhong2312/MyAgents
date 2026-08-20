import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAP_FREEFORM_AREA_PROPS,
  getMapFeatureAreaStyle,
} from "./mapFeatureAreaStyle";

describe("普通画笔区域样式", () => {
  it("新建区域将颜色、边线与填充透明度作为明确事实保存", () => {
    expect(DEFAULT_MAP_FREEFORM_AREA_PROPS).toEqual({
      color: "#8b6b4a",
      lineWidth: "2",
      fill: "#b26d45",
      fillOpacity: "0.25",
    });
  });

  it("优先解析新格式的填充颜色与透明度", () => {
    expect(
      getMapFeatureAreaStyle({
        props: { fill: "#3c91b5", fillOpacity: "0.72" },
      }),
    ).toEqual({ fill: "#3c91b5", opacity: 0.72 });
  });

  it("兼容旧地图的八位十六进制填充透明度", () => {
    expect(getMapFeatureAreaStyle({ props: { fill: "#b26d4540" } })).toEqual({
      fill: "#b26d45",
      opacity: 64 / 255,
    });
  });

  it("显式透明度可以覆盖旧填充色自带的 alpha，并约束到有效范围", () => {
    expect(
      getMapFeatureAreaStyle({
        props: { fill: "#b26d4540", fillOpacity: "2" },
      }),
    ).toEqual({ fill: "#b26d45", opacity: 1 });
  });
});
