import { createRoot } from "react-dom/client";
import { useState } from "react";

import CultivationProgressionPrototype from "../../src/renderer/workbenches/novel/CultivationProgressionPrototype";
import type {
  CultivationLevel,
  CultivationLevelSubStage,
  CultivationSystem,
  ProgressionTrack,
  TrackInteraction,
} from "../../src/shared/workbenches/novel/cultivationEcologySchema";

import "../../src/renderer/workbenches/novel/CultivationEcologyWorkbench.css";
import "./prototype.css";

function stage(
  id: string,
  name: string,
  order: number,
  summary: string,
): CultivationLevelSubStage {
  return {
    id,
    name,
    order,
    summary,
    metricThresholds: [
      {
        metricId:
          id.startsWith("sense") ||
          id.startsWith("sea") ||
          id.startsWith("wander")
            ? "metric-spirit"
            : "metric-force",
        threshold: `${(order + 1) * 20} 点`,
      },
    ],
    entryConditions: ["完成上一阶段积累"],
    completionConditions: ["阶段状态稳定并达到指标门槛"],
    resourceRequirements: [
      {
        resourceId: "resource-tempering-bath",
        purpose: "train",
        quantity: "一份",
        quality: "与当前境界匹配",
        consumed: true,
        substituteResourceIds: [],
        missingConsequence: "阶段完成时间翻倍",
      },
    ],
    naturalAbilityIds: ["ability-body-sense"],
    methodIds: ["method-foundation"],
  };
}

function level(
  id: string,
  name: string,
  order: number,
  summary: string,
  quality: string,
  subStages: CultivationLevelSubStage[],
): CultivationLevel {
  return {
    id,
    name,
    order,
    summary,
    quality,
    stageType: "境界",
    metricThresholds: [
      {
        metricId: id.startsWith("spirit") ? "metric-spirit" : "metric-force",
        threshold: `${(order + 1) * 100} 点`,
      },
    ],
    entryConditions: ["满足前置境界与身体承载条件"],
    maintenanceConditions: ["每月完成一次周天循环"],
    breakthroughConditions: ["完成当前境界积累", "满足下一境界承载条件"],
    breakthroughResult: "进入下一境界",
    failureConsequences: ["经脉受损，三个月内无法再次突破"],
    degeneration: "长期停修会退化至当前境界初始状态",
    resourceRequirements: [
      {
        resourceId: "resource-breakthrough-pill",
        purpose: "breakthrough",
        quantity: "一枚",
        quality: "上品",
        consumed: true,
        substituteResourceIds: ["resource-tempering-bath"],
        missingConsequence: "突破失败风险上升",
      },
    ],
    naturalAbilityIds: ["ability-body-sense"],
    methodIds: ["method-foundation"],
    subStages,
  };
}

function track(
  id: string,
  name: string,
  summary: string,
  levels: CultivationLevel[],
  structure: ProgressionTrack["structure"] = "ordered",
): ProgressionTrack {
  return {
    id,
    name,
    summary,
    mode: "独立成长",
    structure,
    metrics: [
      {
        id: id.includes("spirit") ? "metric-spirit" : "metric-force",
        name: id.includes("spirit") ? "神念强度" : "劲力承载",
        summary: "用于定义境界和境内阶段的进入门槛。",
        unit: "点",
        model: "number",
        direction: "higher-better",
        baseline: "10",
      },
    ],
    levels,
    transitions: levels.slice(0, -1).map((level, index) => ({
      id: `${id}-transition-${index + 1}`,
      name: `${level.name}入${levels[index + 1].name}`,
      summary: `完成${level.name}到${levels[index + 1].name}的境界跃迁。`,
      fromLevelId: level.id,
      toLevelId: levels[index + 1].id,
      transitionType: "breakthrough",
      methodIds: [],
      conditions: ["完成当前境界积累", "满足下一境界承载条件"],
      resourceRequirements: [],
      successRule: "所有条件满足后进行一次突破判定",
      successResult: `稳定进入${levels[index + 1].name}`,
      failureResult: "气血逆冲并进入恢复期",
      permanentConsequence: index > 2 ? "可能留下不可逆的经脉暗伤" : "",
      reversible: false,
      qualityInheritance: "继承当前境界质量，并由突破完成度修正",
      degenerationState: level.name,
    })),
  };
}

const mainTrack = track(
  "track-martial",
  "武道正途",
  "由肉身、气血和内外罡劲逐层推进，是武道体系的主成长路径。",
  [
    level(
      "martial-body",
      "锻体",
      0,
      "打磨皮肉筋骨，建立承载气血与劲力的肉身根基。",
      "凡躯精炼",
      [
        stage("body-skin", "淬皮", 0, "强化皮膜与抗击能力。"),
        stage("body-bone", "锻骨", 1, "重塑骨骼的承载强度。"),
        stage("body-blood", "换血", 2, "提炼气血并完成肉身蜕变。"),
      ],
    ),
    level(
      "martial-meridian",
      "通脉",
      1,
      "贯通周身经脉，使气血和内劲形成稳定循环。",
      "周天初成",
      [
        stage("meridian-open", "开脉", 0, "逐条打开主干经脉。"),
        stage("meridian-point", "贯窍", 1, "以窍穴连接内外气机。"),
      ],
    ),
    level(
      "martial-gang",
      "真罡",
      2,
      "内劲凝为真罡，力量由体内循环转为可控外放。",
      "罡劲成形",
      [
        stage("gang-form", "凝罡", 0, "压缩内劲形成真罡。"),
        stage("gang-release", "外放", 1, "真罡离体仍能保持结构。"),
      ],
    ),
    level(
      "martial-one",
      "守一",
      3,
      "心、意、气、力收束为一，消除力量传递中的割裂。",
      "身意合一",
      [
        stage("one-mind", "定神", 0, "稳定心神与力量反馈。"),
        stage("one-heart", "守心", 1, "在外力扰动下保持自身一贯。"),
      ],
    ),
    level(
      "martial-inner",
      "内照",
      4,
      "感知深入体内细微变化，主动校准自身状态。",
      "照见自身",
      [stage("inner-observe", "观身", 0, "觉察气血、经脉与神意的细微偏差。")],
    ),
    level(
      "martial-force",
      "乘势",
      5,
      "借天地、地势与众生之势放大自身武道意志。",
      "借势成域",
      [
        stage("force-borrow", "借势", 0, "读取并引导周围大势。"),
        stage("force-domain", "成域", 1, "将大势纳入自身武域。"),
      ],
    ),
  ],
);

const spiritTrack = track(
  "track-spirit",
  "炼神支线",
  "专注感知、识海与神念的并行路径，可以落后于主修，也可以提前突破。",
  [
    level(
      "spirit-sense",
      "灵觉",
      0,
      "将直觉训练为稳定、可重复的超常感知。",
      "感知初启",
      [
        stage("sense-in", "内感", 0, "感知自身精神与情绪波动。"),
        stage("sense-out", "外感", 1, "捕捉环境中的气机变化。"),
      ],
    ),
    level(
      "spirit-sea",
      "识海",
      1,
      "建立稳定的精神容器，承载记忆、神念与术式。",
      "念海初成",
      [
        stage("sea-open", "开识", 0, "建立识海边界。"),
        stage("sea-stable", "定念", 1, "让神念长期保持结构。"),
      ],
    ),
    level(
      "spirit-wander",
      "神游",
      2,
      "神念短暂离体，在肉身之外完成观察与干涉。",
      "神念离形",
      [stage("wander-night", "夜游", 0, "在近距离维持离体神念。")],
    ),
  ],
  "branching",
);
spiritTrack.transitions.push({
  id: "spirit-awakening-branch",
  name: "灵觉直入神游",
  summary: "以特殊觉醒绕过识海常规积累，是高风险分支。",
  fromLevelId: "spirit-sense",
  toLevelId: "spirit-wander",
  transitionType: "awakening",
  methodIds: ["method-foundation"],
  conditions: ["遭遇强烈神魂刺激", "灵觉质量达到完美"],
  resourceRequirements: [],
  successRule: "满足觉醒事件并通过神魂稳定判定",
  successResult: "直接获得短距离神游能力",
  failureResult: "识海失序并暂时丧失灵觉",
  permanentConsequence: "可能形成不可逆的感知缺口",
  reversible: false,
  qualityInheritance: "灵觉质量折损一级后继承",
  degenerationState: "灵觉",
});

const bodyTrack = track(
  "track-body",
  "横练外功",
  "以防御、恢复和爆发为核心的并行肉身路线，不替代武道主境界。",
  [
    level(
      "body-bronze",
      "铜皮",
      0,
      "皮膜如铜，能够直接承受常规兵刃与气劲冲击。",
      "外炼小成",
      [stage("bronze-grain", "炼纹", 0, "让外力在皮膜表面分散。")],
    ),
    level(
      "body-jade",
      "玉骨",
      1,
      "骨骼致密且韧性均衡，为高强度爆发提供支点。",
      "骨相重塑",
      [stage("jade-marrow", "洗髓", 0, "由骨入髓改善恢复能力。")],
    ),
    level(
      "body-gold",
      "金身",
      2,
      "全身组织形成统一防御与恢复机制。",
      "肉身圆满",
      [],
    ),
  ],
);

const trackInteractions: TrackInteraction[] = [
  {
    id: "interaction-martial-body",
    name: "根基协同",
    summary: "横练外功提高武道正途的承载上限。",
    sourceTrackId: bodyTrack.id,
    targetTrackId: mainTrack.id,
    kind: "synergy",
    rule: "横练每完成一个境界，主修突破失败造成的肉身损伤降低。",
    conditions: [],
    consequence: "主修突破更加稳定",
    resourcePolicy: "部分药浴资源会发生竞争",
    reversible: true,
  },
  {
    id: "interaction-martial-spirit",
    name: "身神平衡",
    summary: "主修与炼神差距过大时会出现控制问题。",
    sourceTrackId: mainTrack.id,
    targetTrackId: spiritTrack.id,
    kind: "imbalance",
    rule: "两条轨道相差超过两个境界时，战斗中更容易出现感知或控制失配。",
    conditions: [],
    consequence: "力量利用率下降",
    resourcePolicy: "不共享资源",
    reversible: true,
  },
];

const system: CultivationSystem = {
  id: "system-wudao",
  name: "武道体系",
  summary: "以肉身为舟、意志为舵的多轨道修行体系。",
  kind: "武道",
  terminology: {
    energy: "劲力",
    stage: "境界",
    method: "武学",
    ability: "武技",
  },
  projection: {
    originIds: [],
    manifestationIds: [],
    originBindings: [],
    access: "",
    translation: "",
    medium: "",
    attenuation: "",
  },
  theoryModel: {
    statement: "",
    summary: "",
    nodeTypes: [],
    invariants: [],
    validationRules: [],
    nodeCatalog: [],
  },
  progressionTracks: [mainTrack, spiritTrack, bodyTrack],
  trackInteractions,
  resources: [
    {
      id: "resource-tempering-bath",
      name: "淬体药浴",
      summary: "辅助肉身阶段积累。",
      category: "药材",
      grades: [],
      bestLevelId: null,
      usableLevelIds: [],
      supply: "城镇武馆",
      environment: "温热药池",
      conversion: "药力转化为气血",
      shortageConsequence: "修炼速度下降",
    },
    {
      id: "resource-breakthrough-pill",
      name: "破境丹",
      summary: "降低突破时的气血逆冲。",
      category: "丹药",
      grades: [],
      bestLevelId: null,
      usableLevelIds: [],
      supply: "稀缺",
      environment: "",
      conversion: "稳定经脉",
      shortageConsequence: "突破风险提高",
    },
  ],
  methods: [
    {
      id: "method-foundation",
      name: "周天筑基法",
      summary: "贯穿各成长轨道的基础修炼法。",
      kind: "基础法门",
      theoryReference: "气血周天",
      script: [],
      formula: "",
      coverage: {
        startLevelId: null,
        stableLimitId: null,
        theoryLimitId: null,
        absoluteLimitId: null,
      },
      effects: {
        speed: "稳定",
        conversion: "中等",
        quality: "稳固",
        breakthrough: "降低逆冲",
        loss: "低",
      },
      compatibility: [],
      risks: [],
      itemIds: [],
      operationTopologies: [],
      courses: [],
    },
  ],
  abilities: [
    {
      id: "ability-body-sense",
      name: "内视",
      summary: "感知自身气血与经脉状态。",
      acquisitionType: "natural",
      functionType: "support",
      unlockLevelId: null,
      scriptureSource: null,
      trainingRequirements: {
        conditions: [],
        methodIds: [],
        resourceRequirements: [],
      },
      releaseCost: {
        resourceId: null,
        baseCost: "少量精神负担",
        model: "持续时间",
        recovery: "静息恢复",
      },
      effects: [],
      constraints: [],
    },
  ],
  formations: [],
  foundations: [],
  transitions: [],
  constraints: [],
  audit: [],
};

function PrototypeDemo() {
  const [open, setOpen] = useState(true);
  return open ? (
    <CultivationProgressionPrototype
      system={system}
      onClose={() => setOpen(false)}
    />
  ) : (
    <main className="prototype-closed-state">
      <span>只读原型已关闭</span>
      <button type="button" onClick={() => setOpen(true)}>
        重新打开成长地图
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<PrototypeDemo />);
