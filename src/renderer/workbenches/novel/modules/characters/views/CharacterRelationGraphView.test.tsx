import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import CharacterRelationGraphView, {
  type CharacterRelationGraphCharacter,
} from "./CharacterRelationGraphView";

Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
  configurable: true,
  value: { baseVal: { x: 0, y: 0, width: 800, height: 500 } },
});

const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
  SVGSVGElement.prototype,
  "clientWidth",
);
const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
  SVGSVGElement.prototype,
  "clientHeight",
);

beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1600,
  });
  Object.defineProperty(SVGSVGElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 900,
  });
});

afterAll(() => {
  if (clientWidthDescriptor) {
    Object.defineProperty(
      SVGSVGElement.prototype,
      "clientWidth",
      clientWidthDescriptor,
    );
  } else {
    Reflect.deleteProperty(SVGSVGElement.prototype, "clientWidth");
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(
      SVGSVGElement.prototype,
      "clientHeight",
      clientHeightDescriptor,
    );
  } else {
    Reflect.deleteProperty(SVGSVGElement.prototype, "clientHeight");
  }
});

const characters: readonly CharacterRelationGraphCharacter[] = [
  {
    id: "character-a",
    name: "沈砚",
    roleWeight: "main",
    archetype: "调查者",
    storyRole: "主视角",
    summary: "追查旧案的核心人物。",
    relations: [
      {
        targetId: "character-b",
        type: "盟友",
        summary: "互相试探后建立信任。",
      },
    ],
  },
  {
    id: "character-b",
    name: "陆青禾",
    roleWeight: "secondary",
    archetype: "引路人",
    storyRole: "关键配角",
    summary: "掌握旧案线索。",
    relations: [],
  },
  {
    id: "character-c",
    name: "许伯",
    roleWeight: "npc",
    archetype: "见证者",
    storyRole: "线索人物",
    summary: "尚未与其他人物建立关系。",
    relations: [],
  },
];

describe("CharacterRelationGraphView", () => {
  it("复用知识库图谱交互，并展示完整人物网络与关系摘要", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <CharacterRelationGraphView
        characters={characters}
        selectedId="character-a"
        onSelect={onSelect}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll('svg[role="application"] circle'),
      ).toHaveLength(3);
    });

    expect(
      screen.getByRole("application", { name: /人物关系图谱/ }),
    ).toBeInTheDocument();
    const detailsPane = screen.getByText("人物详情与关系").closest("aside");
    expect(detailsPane).toHaveClass("border-r");
    expect(detailsPane?.parentElement).toHaveClass("flex-row-reverse");
    expect(screen.getByText("许伯")).toBeInTheDocument();
    expect(screen.getByText("互相试探后建立信任。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /陆青禾/ }));
    expect(onSelect).toHaveBeenCalledWith("character-b");
  });

  it("宽容器中仍按图谱逻辑坐标居中", async () => {
    render(
      <CharacterRelationGraphView
        characters={[{ ...characters[0], relations: [] }]}
        selectedId="character-a"
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() => {
      const graphLabel = screen
        .getAllByText("沈砚")
        .find((element) => element.tagName.toLowerCase() === "text");
      const transform = graphLabel?.closest("g")?.getAttribute("transform");
      const coordinates = transform?.match(/translate\(([-\d.]+),([-\d.]+)\)/u);
      expect(coordinates).toBeTruthy();
      expect(Number(coordinates?.[1])).toBeCloseTo(400, 0);
      expect(Number(coordinates?.[2])).toBeCloseTo(250, 0);
    });
  });
});
