import { describe, expect, it } from "vitest";

import { parseStableEntityLinks } from "./WikiView";

describe("parseStableEntityLinks（T15 稳定实体链接）", () => {
  it("解析 [[kind:id|名称]] 与 [[kind:id]] 两种语法", () => {
    const links = parseStableEntityLinks(
      "洛言[[character:char-luoyan|洛言]]与青云宗[[faction:faction-1]]相关",
    );
    expect(links).toEqual([
      { kind: "character", id: "char-luoyan", label: "洛言" },
      { kind: "faction", id: "faction-1", label: "faction-1" },
    ]);
  });

  it("忽略非实体链接与非法 id", () => {
    const links = parseStableEntityLinks("普通文本 [[中文:name]] [[item:bad id]]");
    expect(links).toEqual([]);
  });
});
