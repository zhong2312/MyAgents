import type {
  Ability,
  CultivationEcology,
  CultivationLevel,
  CultivationMethod,
  CultivationSystem,
  WorldOrigin,
  Formation,
  OperationTopology,
  TheoryNode,
} from "../../../shared/novel-cultivation-ecology-schema";
import { createEmptyCultivationEcology } from "../../../shared/novel-cultivation-ecology-schema";
import { createFormationBackdropPreset } from "./formationBackdropPresets";

function named(
  itemId: string,
  name: string,
  summary?: string,
): { id: string; name: string; summary: string };
function named(
  itemId: string,
  name: string,
  summary: string,
  effect: string,
): { id: string; name: string; summary: string; effect: string };
function named(itemId: string, name: string, summary = "", effect?: string) {
  return effect === undefined
    ? { id: itemId, name, summary }
    : { id: itemId, name, summary, effect };
}

const origins: WorldOrigin[] = [
  {
    ...named("origin-aven", "太虚大道", "世界本源对秩序、变化与归一的总称。"),
    kind: "大道",
    ontologyStatement:
      "道生一，一生万象；世界不是由单一能量组成，而是由本源分化、法则成立、载体显化共同展开。",
    status: "stable",
    scopes: ["诸天世界", "可被认知与翻译的现实层", "灵气与星辉可达区域"],
    constraints: [
      "所有转化必须存在可追溯的代价",
      "跨层投影会产生衰减",
      "未完成本地化的外源规则会造成污染",
    ],
    manifestations: [
      {
        ...named("division-yin-yang", "阴阳分判", "一切变化的对待与消长结构。"),
        type: "division",
        definition: "将未分化的本源分为相反而互补的两种运动趋势。",
        sourceId: "origin-aven",
        scope: "诸天世界",
        access: "理论观测、内丹修炼、世界法则",
        generation: "由太虚大道直接分判",
        conversion: "阴阳相济后形成可循环的运行条件",
        risks: ["偏盛会破坏平衡"],
      },
      {
        ...named(
          "division-five-elements",
          "五行分化",
          "木火土金水的生成、制化与转运结构。",
        ),
        type: "division",
        definition: "将阴阳运动进一步翻译为可被世界承载的五类结构。",
        sourceId: "origin-aven",
        scope: "物质与生命世界",
        access: "灵根、血脉、环境共鸣",
        generation: "由阴阳分判继续展开",
        conversion: "生克制化与循环转运",
        risks: ["五行失衡会造成区域性灾变"],
      },
      {
        ...named(
          "law-yin-yang",
          "阴阳消长",
          "任何转化都必须存在可追溯的平衡。",
        ),
        type: "law",
        definition: "变化必须在对待、消长与复归之间保持可追溯的平衡。",
        sourceId: "division-yin-yang",
        scope: "所有能量与生命转化",
        access: "体系理论、法门拓扑、阵法规则",
        generation: "由阴阳分判显化",
        conversion: "规定转化方向与回收路径",
        risks: ["强行单向放大导致反噬"],
      },
      {
        ...named("law-cause", "因果承载", "力量越过边界必须支付代价。"),
        type: "law",
        definition: "任何跨越能力、地域或存在层级的行为都必须留下代价记录。",
        sourceId: "origin-aven",
        scope: "所有具备连续性的事件",
        access: "突破、转换、契约与神通",
        generation: "由本源的秩序面显化",
        conversion: "将损耗、代价和结果绑定",
        risks: ["因果断裂会产生异常回溯"],
      },
      {
        ...named("law-resonance", "共鸣法则", "同类结构可以共享或放大运行。"),
        type: "law",
        definition: "结构相似、频率相近的对象可以共享路径并放大输出。",
        sourceId: "division-five-elements",
        scope: "元素、精神、符文与经络结构",
        access: "法门、技能、阵法和设备",
        generation: "由五行分化显化",
        conversion: "将局部能量转为结构性放大",
        risks: ["频率错配会引发失控"],
      },
      {
        ...named("energy-spirit", "灵气", "可被经脉与丹田转化的环境能量。"),
        type: "energy",
        definition: "遍布世界环境、可被经脉与丹田吸收和转化的基础载体。",
        sourceId: "division-five-elements",
        scope: "灵脉、聚灵阵与自然环境",
        access: "吐纳、法门、阵法",
        generation: "五行分化在环境中的能量化显化",
        conversion: "按法门拓扑转为真元",
        risks: ["杂质过高会污染经脉"],
      },
      {
        ...named("energy-starlight", "星辉", "具有频率与属性的远距能量。"),
        type: "energy",
        definition: "由天体运行与空间规则产生、具有频率和属性的远距载体。",
        sourceId: "law-resonance",
        scope: "夜空、星门与高空仪式场",
        access: "元素魔法、观星仪式、设备接入",
        generation: "共鸣法则与天体结构共同生成",
        conversion: "经元素核心提纯后转为体系能量",
        risks: ["频率错位会形成元素残响"],
      },
      {
        ...named(
          "energy-emotion",
          "情绪场",
          "由群体心智与记忆产生的非物质载体。",
        ),
        type: "information",
        definition: "由群体心智、记忆和情绪共振形成的非物质信息载体。",
        sourceId: "law-resonance",
        scope: "群体聚集、梦境与记忆密集区域",
        access: "精神异能、神魂观想、共鸣仪式",
        generation: "意识结构对共鸣法则的反向显化",
        conversion: "转为精神负荷、记忆索引或意念脉冲",
        risks: ["群体噪声会造成认知污染"],
      },
    ],
    relations: [
      {
        ...named(
          "origin-rel-yin-yang",
          "大道分判阴阳",
          "本源向第一层结构分化。",
        ),
        sourceId: "origin-aven",
        targetId: "division-yin-yang",
        relation: "differentiate",
        conditions: [],
        cost: "无显性消耗",
        loss: "不可逆的结构展开",
      },
      {
        ...named(
          "origin-rel-five-elements",
          "阴阳展开五行",
          "分化结构继续落入可承载的世界语法。",
        ),
        sourceId: "division-yin-yang",
        targetId: "division-five-elements",
        relation: "differentiate",
        conditions: ["世界具备物质承载层"],
        cost: "局部秩序固定",
        loss: "抽象自由度下降",
      },
      {
        ...named(
          "origin-rel-yinyang-law",
          "阴阳显化消长法则",
          "分判结构成为可执行规则。",
        ),
        sourceId: "division-yin-yang",
        targetId: "law-yin-yang",
        relation: "manifest",
        conditions: [],
        cost: "遵守平衡",
        loss: "强制转化效率下降",
      },
      {
        ...named(
          "origin-rel-spirit",
          "五行显化灵气",
          "环境能量成为可修炼载体。",
        ),
        sourceId: "division-five-elements",
        targetId: "energy-spirit",
        relation: "manifest",
        conditions: ["存在灵脉或聚灵结构"],
        cost: "环境浓度消耗",
        loss: "杂质与地域衰减",
      },
      {
        ...named(
          "origin-rel-starlight",
          "共鸣生成星辉",
          "天体与规则结构产生远距载体。",
        ),
        sourceId: "law-resonance",
        targetId: "energy-starlight",
        relation: "generate",
        conditions: ["天体频率可观测"],
        cost: "仪式时间与定位精度",
        loss: "受天气与空间边界影响",
      },
    ],
  },
];

function node(
  itemId: string,
  name: string,
  kind: string,
  role: string,
  invariant: string,
): TheoryNode {
  return {
    ...named(itemId, name),
    kind,
    role,
    capacity: "按体系指标计算",
    accessCondition: "满足通达条件后开放",
    invariant,
    aliases: [],
  };
}

function defaultLevelSubStages(
  levelId: string,
): CultivationLevel["subStages"] {
  return ["前期", "中期", "后期"].map((name, order) => ({
    id: `${levelId}-stage-${["early", "middle", "late"][order]}`,
    name,
    summary: "",
    order,
    metricThresholds: [],
    entryConditions: [],
    completionConditions: [],
    resourceRequirements: [],
    naturalAbilityIds: [],
    methodIds: [],
  }));
}

function level(
  itemId: string,
  order: number,
  name: string,
  summary: string,
  naturalAbilityIds: string[] = [],
): CultivationLevel {
  return {
    ...named(itemId, name, summary),
    order,
    stageType: "境界",
    metricThresholds: [],
    quality: "中品",
    entryConditions: [],
    maintenanceConditions: [],
    breakthroughConditions: [],
    breakthroughResult: "",
    failureConsequences: [],
    degeneration: "",
    resourceRequirements: [],
    naturalAbilityIds,
    methodIds: [],
    subStages: defaultLevelSubStages(itemId),
  };
}

function topology(
  itemId: string,
  name: string,
  route: Array<[string, string]>,
): OperationTopology {
  const nodes = route.map(([theoryNodeId, operation], order) => ({
    id: `${itemId}-node-${order + 1}`,
    theoryNodeId,
    order,
    role: order === 0 ? "起点" : order === route.length - 1 ? "收束" : "运行",
    operation,
  }));
  const edges = nodes.slice(0, -1).map((item, order) => ({
    id: `${itemId}-edge-${order + 1}`,
    name: `${item.operation} → ${nodes[order + 1]?.operation ?? "下一节点"}`,
    fromNodeId: item.id,
    toNodeId: nodes[order + 1].id,
    order,
    routeRule: "顺行，保持节点稳定度",
    loss: "低",
  }));
  return {
    ...named(itemId, name, "法门独有的能量运行线路，引用体系共有理论节点。"),
    nodes,
    edges,
    cycleRule: "首尾相接形成闭环",
    closureRule: "收束后回到起点并记录损耗",
    costModel: "基础消耗 + 节点损耗 + 施术负荷",
  };
}

function method(
  itemId: string,
  name: string,
  kind: string,
  theoryReference: string,
  topologies: OperationTopology[],
  script: string[],
  coverage: CultivationMethod["coverage"] = {
    startLevelId: null,
    stableLimitId: null,
    theoryLimitId: null,
    absoluteLimitId: null,
  },
): CultivationMethod {
  return {
    ...named(itemId, name, "通过法诀、呼吸、观想或仪式改变力量运行方式。"),
    kind,
    theoryReference,
    script,
    formula: "修炼收益 = 法门效率 × 根基适配 × 资源转化率 × 当前稳定度",
    coverage,
    effects: {
      speed: "提升修炼速度",
      conversion: "提高资源转化率",
      quality: "改善境界质量",
      breakthrough: "提高突破成功率",
      loss: "记录经脉损耗与反噬",
    },
    compatibility: [],
    risks: ["运行中断会造成力量回冲", "跨体系使用时需要显式转换"],
    itemIds: [],
    operationTopologies: topologies,
    courses: [],
  };
}

function ability(
  itemId: string,
  name: string,
  acquisitionType: Ability["acquisitionType"],
  functionType: Ability["functionType"],
  unlockLevelId: string | null,
  methodId: string | null,
  effect: string,
  amplificationModel: string,
): Ability {
  return {
    ...named(itemId, name, effect),
    acquisitionType,
    functionType,
    unlockLevelId,
    scriptureSource:
      acquisitionType === "scripture"
        ? {
            title: "对应秘籍",
            methodId,
            itemIds: [],
            summary: "通过秘籍逐步掌握，而非境界自动赠予。",
          }
        : null,
    trainingRequirements: {
      conditions: [],
      methodIds: methodId ? [methodId] : [],
      resourceRequirements: [],
      masteryFormula: "掌握度 = 课程完成度 × 运行稳定度",
    },
    cast: {
      energyLabel: "体系能量",
      amount: "按效果等级计算",
      model: "基础消耗 + 目标数量 + 距离",
      cooldown: "视能力而定",
    },
    effect,
    amplificationModel,
    range: "视能力而定",
    duration: "视能力而定",
    limitations: [],
    counters: [],
  };
}

function formation(
  itemId: string,
  name: string,
  purpose: string,
  theoryNodeId: string,
  requiredLevelIds: string[] = ["taixu-level-2"],
  methodIds: string[] = ["taixu-method-weekly"],
): Formation {
  const backdrop = createFormationBackdropPreset(
    "classic",
    (index) => `${itemId}-backdrop-${index + 1}`,
  );
  return {
    ...named(itemId, name, purpose),
    category: "法阵 / 仪式网络",
    structure: "network",
    scale: "小型",
    purpose,
    theoryNodeIds: [theoryNodeId],
    requiredLevelIds,
    methodIds,
    operationTopologyIds: [],
    abilityIds: [],
    itemIds: [],
    activationConditions: ["节点全部就位", "主阵眼保持稳定"],
    resourceRequirements: [],
    activation: "按阵图顺序注入能量",
    maintenance: "每六个时辰校准一次阵眼",
    output: purpose,
    boundary: "阵外能量无法被阵内规则强制改写",
    risks: ["阵眼过载", "回路反噬"],
    countermeasures: "保留备用收束节点",
    sixElements: {
      source: "阵旗与灵石持续供能",
      foundation: "主阵盘与三处方位锚点",
      pattern: "三角闭合回路引导能量循环",
      eye: "主阵眼聚能并控制全局",
      domain: "阵图边界以内形成局部规则场",
      law: purpose,
    },
    design: {
      layout: "concentric",
      canvasStyle: "mystic",
      ...backdrop,
      rings: [
        {
          id: `${itemId}-ring-1`,
          name: "纹环",
          radius: 210,
          style: "runic",
          color: "#74aab7",
          strokeWidth: 1.5,
          rotation: 0,
          rotating: false,
          runes: "道生纹 · 纹生阵 · 气循其理 · ",
          visible: true,
          order: 0,
        },
        {
          id: `${itemId}-ring-2`,
          name: "域环",
          radius: 360,
          style: "double",
          color: "#cdbb8c",
          strokeWidth: 2.5,
          rotation: 0,
          rotating: false,
          runes: "天地为盘 · 万物为子 · ",
          visible: true,
          order: 1,
        },
      ],
    },
    nodes: [
      {
        id: `${itemId}-node-1`,
        name: "主阵眼",
        kind: "eye",
        role: "聚能与控制",
        theoryNodeId,
        position: { x: 50, y: 50 },
        canvasPosition: { x: 454, y: 454 },
        ringId: null,
        angle: 0,
        size: 92,
        color: "#d9c98f",
        glyph: "眼",
        element: "eye",
        nodeStyle: "seal",
      },
      {
        id: `${itemId}-node-2`,
        name: "东辅位",
        kind: "support",
        role: "稳定回路",
        theoryNodeId: null,
        position: { x: 81.2, y: 68 },
        canvasPosition: { x: 776, y: 644 },
        ringId: `${itemId}-ring-2`,
        angle: 120,
        size: 72,
        color: "#a87858",
        glyph: "基",
        element: "foundation",
        nodeStyle: "sigil",
      },
      {
        id: `${itemId}-node-3`,
        name: "西辅位",
        kind: "support",
        role: "回收余能",
        theoryNodeId: null,
        position: { x: 18.8, y: 68 },
        canvasPosition: { x: 152, y: 644 },
        ringId: `${itemId}-ring-2`,
        angle: 240,
        size: 72,
        color: "#74aab7",
        glyph: "纹",
        element: "pattern",
        nodeStyle: "seal",
      },
    ],
    edges: [
      {
        id: `${itemId}-edge-1`,
        name: "主阵眼 · 东辅位",
        fromNodeId: `${itemId}-node-1`,
        toNodeId: `${itemId}-node-2`,
        order: 0,
        rule: "分流",
        flowType: "灵流",
        lineStyle: "bezier",
        color: "#d9c98f",
        animated: true,
      },
      {
        id: `${itemId}-edge-2`,
        name: "东辅位 · 西辅位",
        fromNodeId: `${itemId}-node-2`,
        toNodeId: `${itemId}-node-3`,
        order: 1,
        rule: "平衡",
        flowType: "灵流",
        lineStyle: "smoothstep",
        color: "#a87858",
        animated: true,
      },
      {
        id: `${itemId}-edge-3`,
        name: "西辅位 · 主阵眼",
        fromNodeId: `${itemId}-node-3`,
        toNodeId: `${itemId}-node-1`,
        order: 2,
        rule: "回收",
        flowType: "余能回流",
        lineStyle: "bezier",
        color: "#74aab7",
        animated: true,
      },
    ],
  };
}

function createTaixu(): CultivationSystem {
  const nodes = [
    node(
      "taixu-node-dantian",
      "下丹田",
      "丹田节点",
      "聚气、容纳、起点",
      "所有主修法门可作为能量入口",
    ),
    node(
      "taixu-node-huiyin",
      "会阴关",
      "关窍节点",
      "阴阳换向、入脉",
      "必须满足经脉通达条件",
    ),
    node(
      "taixu-node-mingmen",
      "命门",
      "关窍节点",
      "真元增密、回流",
      "承载高负荷回流",
    ),
    node(
      "taixu-node-niwan",
      "泥丸宫",
      "丹田节点",
      "炼气化神、神识汇聚",
      "神魂法门必须声明稳定度",
    ),
    node(
      "taixu-node-zifu",
      "紫府",
      "观想节点",
      "观想对象与心神映照",
      "不可越过神魂承载上限",
    ),
    node(
      "taixu-node-xinhuo",
      "心火",
      "关窍节点",
      "校准心神偏差",
      "过盛触发神魂反噬",
    ),
    node(
      "taixu-node-guiyuan",
      "归元",
      "收束节点",
      "收功、封存、回归",
      "收束后才允许退出路线",
    ),
    node(
      "taixu-node-gushen",
      "骨门",
      "支脉节点",
      "炼体承压",
      "炼体法门必须声明身体承压",
    ),
  ];
  const levels = [
    level("taixu-level-1", 0, "感气", "感知灵气并建立第一处稳定入口", [
      "taixu-ability-sense",
    ]),
    level("taixu-level-2", 1, "筑基", "经脉可承载小周天，形成稳定根基", [
      "taixu-ability-flight",
    ]),
    level("taixu-level-3", 2, "金丹", "真元凝聚为核心，允许多法门并修", [
      "taixu-ability-spirit-sight",
    ]),
    level("taixu-level-4", 3, "元神", "神魂独立运行，能够影响外界规则", [
      "taixu-ability-soul-out",
    ]),
    level("taixu-level-5", 4, "化虚", "本体与本源投影建立高阶联系", []),
  ];
  levels.forEach((item, index) => {
    item.methodIds.push(
      index < 3 ? "taixu-method-weekly" : "taixu-method-sense",
    );
    item.breakthroughConditions.push(
      index === 0 ? "完成入静与感气" : "达到上一境界指标门槛并完成对应周天",
    );
    item.breakthroughResult =
      index === 0 ? "获得体系能量感知" : "容量、纯度、稳定度同步提升";
    item.failureConsequences.push("经脉负荷上升，进入恢复期");
  });
  const methods = [
    method(
      "taixu-method-weekly",
      "太虚周天功",
      "内丹主修法门",
      "精气神三元转化 / 任督循环 / 丹田归藏",
      [
        topology("taixu-weekly", "小周天路线", [
          ["taixu-node-dantian", "守一聚气"],
          ["taixu-node-huiyin", "引气入脉"],
          ["taixu-node-mingmen", "增密回流"],
          ["taixu-node-niwan", "炼气化神"],
          ["taixu-node-guiyuan", "收束归藏"],
        ]),
        topology("taixu-great", "大周天路线", [
          ["taixu-node-dantian", "真元起炉"],
          ["taixu-node-huiyin", "通任督"],
          ["taixu-node-gushen", "周身炼体"],
          ["taixu-node-zifu", "神魂观想"],
          ["taixu-node-guiyuan", "大循环收束"],
        ]),
      ],
      [
        "守一：意落下丹田，呼吸归于自然。",
        "引气：气自会阴起，沿任脉上行。",
        "转化：神光照识海，完成一次提纯。",
        "收功：沿督脉回流，归藏下丹田并封闭关窍。",
      ],
    ),
    method(
      "taixu-method-sense",
      "太上感应篇",
      "神魂观想法门",
      "紫府观想 / 心火校准 / 神魂回响",
      [
        topology("taixu-sense", "神魂回响路线", [
          ["taixu-node-zifu", "建立观想"],
          ["taixu-node-niwan", "识海承载"],
          ["taixu-node-xinhuo", "心火校准"],
          ["taixu-node-guiyuan", "封存回响"],
        ]),
      ],
      [
        "静坐：隔绝外部杂讯。",
        "观想：在紫府建立稳定对象。",
        "校准：以心火修正认知偏差。",
        "收束：解除观想并封存回响。",
      ],
    ),
    method(
      "taixu-method-body",
      "五行炼体诀",
      "炼体辅修法门",
      "骨门承压 / 血海供给 / 周身循环",
      [
        topology("taixu-body", "炼体周行路线", [
          ["taixu-node-gushen", "骨门起势"],
          ["taixu-node-mingmen", "命门增压"],
          ["taixu-node-dantian", "真元供给"],
          ["taixu-node-guiyuan", "周身收束"],
        ]),
      ],
      [
        "淬骨：逐段提高承压。",
        "换血：将资源转化为体魄质量。",
        "归元：停止增压并修复损耗。",
      ],
    ),
  ];
  methods[0].coverage = {
    startLevelId: "taixu-level-1",
    stableLimitId: "taixu-level-3",
    theoryLimitId: "taixu-level-4",
    absoluteLimitId: "taixu-level-4",
  };
  methods[1].coverage = {
    startLevelId: "taixu-level-2",
    stableLimitId: "taixu-level-4",
    theoryLimitId: "taixu-level-5",
    absoluteLimitId: "taixu-level-5",
  };
  methods[2].coverage = {
    startLevelId: "taixu-level-1",
    stableLimitId: "taixu-level-3",
    theoryLimitId: "taixu-level-4",
    absoluteLimitId: "taixu-level-4",
  };
  const abilities = [
    ability(
      "taixu-ability-sense",
      "灵气感知",
      "natural",
      "mental",
      "taixu-level-1",
      null,
      "感知灵气浓度、方向与异常扰动。",
      "不放大能量，降低感知噪声。",
    ),
    ability(
      "taixu-ability-flight",
      "御气飞行",
      "natural",
      "support",
      "taixu-level-2",
      null,
      "以真元抵消自身重力并进行空中移动。",
      "将真元转化为持续升力，速度受稳定度限制。",
    ),
    ability(
      "taixu-ability-spirit-sight",
      "神识外放",
      "natural",
      "mental",
      "taixu-level-3",
      null,
      "以神魂覆盖周围区域并建立目标索引。",
      "将精神强度放大为可观测范围。",
    ),
    ability(
      "taixu-ability-sword",
      "太虚剑气",
      "scripture",
      "offensive",
      "taixu-level-2",
      "taixu-method-weekly",
      "将真元压缩成定向剑气。",
      "进攻能力的本质是能量放大器：以线路稳定度放大单位真元的穿透力。",
    ),
    ability(
      "taixu-ability-dream",
      "入梦观想",
      "scripture",
      "mental",
      "taixu-level-3",
      "taixu-method-sense",
      "以观想回响干扰目标梦境与记忆入口。",
      "将神魂回响放大为短时精神投影。",
    ),
    ability(
      "taixu-ability-ward",
      "归元护身阵",
      "scripture",
      "support",
      "taixu-level-2",
      "taixu-method-body",
      "将阵法节点与周天收束连接，降低外部冲击。",
      "把多节点承压转化为单点可控损耗。",
    ),
  ];
  const system: CultivationSystem = {
    ...named(
      "taixu",
      "太虚内丹体系",
      "以精气神转化与经脉周天为核心的东方内丹修行体系。",
    ),
    kind: "内丹修行",
    terminology: {
      energy: "真元",
      stage: "境界",
      method: "法门",
      ability: "神通 / 法术",
    },
    projection: {
      originIds: ["origin-aven"],
      manifestationIds: ["law-yin-yang", "law-cause", "energy-spirit"],
      originBindings: [],
      access: "先天灵根、后天吐纳、师承法诀、仪式接引",
      translation: "将大道翻译为精气神三元与经脉节点模型",
      medium: "经脉、丹田、关窍、神魂",
      attenuation: "地域灵气、心神稳定度、法门兼容性会造成衰减",
    },
    theoryModel: {
      statement: "精气神三元转化 / 经脉节点通达 / 丹田与关窍不变量",
      summary:
        "理论模型定义体系共有的人体结构；所有法门共享节点，但各自决定能量运行线路。",
      nodeTypes: ["主脉", "支脉", "丹田", "关窍", "观想", "收束"],
      invariants: [
        "节点必须先满足通达条件才能接入",
        "高负荷回流必须有收束节点",
        "神魂法门不可越过识海承载上限",
      ],
      validationRules: [
        "法门拓扑引用的节点必须存在",
        "每条拓扑必须有起点与收束点",
        "技能释放消耗必须引用体系能量指标",
      ],
      nodeCatalog: nodes,
    },
    progressionTracks: [
      {
        ...named(
          "taixu-track-cultivation",
          "修为轨道",
          "真元容量、纯度与稳定度共同决定境界",
        ),
        mode: "修炼 / 突破",
        structure: "ordered",
        metrics: [
          {
            ...named("taixu-metric-capacity", "真元容量"),
            unit: "点",
            model: "number",
            direction: "higher-better",
            baseline: "100",
          },
          {
            ...named("taixu-metric-stability", "神魂稳定度"),
            unit: "%",
            model: "range",
            direction: "higher-better",
            baseline: "60%",
          },
          {
            ...named("taixu-metric-load", "经脉负荷"),
            unit: "%",
            model: "range",
            direction: "lower-better",
            baseline: "20%",
          },
        ],
        levels,
        transitions: [
          {
            ...named(
              "taixu-transition-foundation",
              "筑基突破",
              "小周天闭环后凝聚根基",
            ),
            fromLevelId: "taixu-level-1",
            toLevelId: "taixu-level-2",
            transitionType: "breakthrough",
            methodIds: ["taixu-method-weekly"],
            conditions: ["小周天连续运行七日", "神魂稳定度不低于 70%"],
            resourceRequirements: [],
            successRule: "节点无断路且真元回流完成",
            successResult: "形成稳定根基",
            failureResult: "经脉灼伤并进入恢复期",
            permanentConsequence: "严重失败可能留下经脉裂隙",
            reversible: false,
          },
        ],
      },
    ],
    trackInteractions: [],
    resources: [
      {
        ...named(
          "taixu-resource-spirit-stone",
          "上品灵石",
          "稳定、可计量的主修资源。",
        ),
        category: "能量",
        grades: [
          named("taixu-grade-high", "上品", "适合筑基以上", "真元转化率 +18%"),
        ],
        bestLevelId: "taixu-level-3",
        usableLevelIds: levels.map((item) => item.id),
        supply: "矿脉、宗门配给、交易",
        environment: "灵脉或聚灵阵",
        conversion: "按法门转化率进入真元",
        shortageConsequence: "修炼速度下降，突破风险上升",
      },
      {
        ...named("taixu-resource-elixir", "凝神丹", "用于稳定神魂与观想回响。"),
        category: "辅助",
        grades: [
          named("taixu-grade-elixir", "三转", "神魂稳定剂", "降低观想噪声"),
        ],
        bestLevelId: "taixu-level-3",
        usableLevelIds: ["taixu-level-2", "taixu-level-3", "taixu-level-4"],
        supply: "炼丹、遗迹",
        environment: "静室",
        conversion: "直接作用于神魂稳定度",
        shortageConsequence: "精神类技能掌握速度下降",
      },
    ],
    methods,
    abilities,
    formations: [
      formation(
        "taixu-formation-ward",
        "太虚镇界阵",
        "稳定区域灵气并放大护身与收束效果",
        "taixu-node-dantian",
      ),
    ],
    foundations: [
      {
        ...named(
          "taixu-foundation-root",
          "灵根",
          "决定与灵气和法门的初始适配。",
        ),
        factor: "五行灵根",
        value: "上品",
        impact: "资源转化率 +12%",
        affectedTracks: ["taixu-track-cultivation"],
        adjustment: "洗髓、血脉改造、师承",
        permanence: "可部分改变",
      },
    ],
    transitions: [
      {
        ...named(
          "taixu-transition-conversion",
          "内丹与炼体转换",
          "允许炼体资源转为短时真元上限。",
        ),
        fromLevelId: "taixu-level-2",
        toLevelId: "taixu-level-2",
        transitionType: "conversion",
        methodIds: ["taixu-method-body"],
        conditions: ["身体承压达标"],
        resourceRequirements: [],
        successRule: "负荷低于阈值",
        successResult: "短时容量提升",
        failureResult: "身体损伤",
        permanentConsequence: "可能降低寿元",
        reversible: false,
      },
    ],
    constraints: [
      {
        ...named(
          "taixu-constraint-load",
          "经脉反噬",
          "经脉负荷过高会中断周天。",
        ),
        category: "backlash",
        trigger: "负荷超过 90%",
        consequence: "周天中断、真元回冲",
        mitigation: "停功、封脉、使用稳定资源",
        reversible: true,
      },
      {
        ...named(
          "taixu-constraint-pollution",
          "神魂污染",
          "外源道韵未完成本地化会污染观想。",
        ),
        category: "pollution",
        trigger: "跨体系直接调用法则",
        consequence: "认知偏差与能力变异",
        mitigation: "先完成法则翻译",
        reversible: false,
      },
    ],
    audit: [
      {
        id: "taixu-audit-1",
        severity: "warning",
        title: "阵法备用资源未标注替代项",
        targetType: "formation",
        targetId: "taixu-formation-ward",
        message: "主阵眼失效时没有备用资源路径。",
        suggestion: "为阵法资源需求增加可替代资源。",
        resolved: false,
      },
      {
        id: "taixu-audit-2",
        severity: "suggestion",
        title: "元神境界质量区间可细化",
        targetType: "level",
        targetId: "taixu-level-4",
        message: "当前只写了统一质量。",
        suggestion: "增加下品、上品、完美的判定公式。",
        resolved: false,
      },
    ],
  };
  return system;
}

function createGenericSystem(
  systemId: string,
  name: string,
  kind: string,
  energy: string,
  stages: string[],
  nodeData: Array<[string, string, string, string, string]>,
  methodData: Array<[string, string, string]>,
  abilityData: Array<[string, string, Ability["functionType"]]>,
): CultivationSystem {
  const nodes = nodeData.map((item) => node(...item));
  const levels = stages.map((stage, index) =>
    level(
      `${systemId}-level-${index + 1}`,
      index,
      stage,
      `${name}的第 ${index + 1} 个境界。`,
      index === 0 ? [`${systemId}-ability-natural`] : [],
    ),
  );
  const methods = methodData.map(([methodId, methodName, theoryReference]) =>
    method(
      `${systemId}-${methodId}`,
      methodName,
      `${kind}法门`,
      theoryReference,
      [
        topology(
          `${systemId}-${methodId}-topology`,
          `${methodName}运行拓扑`,
          nodes
            .slice(0, Math.min(nodes.length, 5))
            .map((item, index) => [
              item.id,
              index === 0
                ? "接入"
                : index === nodes.length - 1
                  ? "收束"
                  : "转换",
            ]),
        ),
      ],
      ["建立接入条件", "按法诀或协议运行节点", "完成收束并记录损耗"],
    ),
  );
  methods.forEach((item) => {
    item.coverage = {
      startLevelId: levels[0]?.id ?? null,
      stableLimitId: levels[Math.max(0, levels.length - 2)]?.id ?? null,
      theoryLimitId: levels.at(-1)?.id ?? null,
      absoluteLimitId: levels.at(-1)?.id ?? null,
    };
  });
  const abilities = [
    ability(
      `${systemId}-ability-natural`,
      "基础感知",
      "natural",
      "mental",
      levels[0].id,
      null,
      `自动获得对${energy}与体系节点的基础感知。`,
      "降低感知噪声。",
    ),
    ...abilityData.map(([abilityId, abilityName, functionType], index) =>
      ability(
        `${systemId}-${abilityId}`,
        abilityName,
        "scripture",
        functionType,
        levels[Math.min(index + 1, levels.length - 1)].id,
        methods[0].id,
        `${abilityName}的具体效果。`,
        functionType === "offensive"
          ? "将能量放大为定向输出。"
          : "将能量转化为控制、辅助或精神效果。",
      ),
    ),
  ];
  return {
    ...named(systemId, name, `${kind}的可编辑示例体系。`),
    kind,
    terminology: {
      energy,
      stage: "境界",
      method: "法门",
      ability: "技能 / 法术",
    },
    projection: {
      originIds: ["origin-aven"],
      manifestationIds: ["law-resonance", "energy-starlight"],
      originBindings: [],
      access: "天赋、训练、设备或契约接入",
      translation: "将本源翻译为可计算的${energy}与节点规则",
      medium: "媒介、节点、回路与控制协议",
      attenuation: "接入权限、环境频率和载体稳定度造成衰减",
    },
    theoryModel: {
      statement: `${energy}共鸣 / 节点语法 / 反馈闭环`,
      summary:
        "理论模型定义所有法门共用的结构；法门只负责自己的运行顺序与拓扑。",
      nodeTypes: ["媒介", "节点", "核心", "回收", "边界"],
      invariants: ["节点必须按协议接入", "输出必须存在回收或释放边界"],
      validationRules: ["拓扑节点必须来自共有节点库", "能力必须声明释放消耗"],
      nodeCatalog: nodes,
    },
    progressionTracks: [
      {
        ...named(
          `${systemId}-track-main`,
          `${name}成长轨道`,
          "境界由容量、控制与稳定度共同决定。",
        ),
        mode: "训练 / 觉醒 / 施法",
        structure: "ordered",
        metrics: [
          {
            ...named(`${systemId}-metric-capacity`, `${energy}容量`),
            unit: "点",
            model: "number",
            direction: "higher-better",
            baseline: "100",
          },
          {
            ...named(`${systemId}-metric-control`, "控制精度"),
            unit: "%",
            model: "range",
            direction: "higher-better",
            baseline: "50%",
          },
        ],
        levels,
        transitions: [],
      },
    ],
    trackInteractions: [],
    resources: [
      {
        ...named(
          `${systemId}-resource-core`,
          `${energy}核心`,
          "体系的主要能量资源。",
        ),
        category: "能量 / 载体",
        grades: [
          named(`${systemId}-grade-core`, "标准", "常规品质", "转化效率 +10%"),
        ],
        bestLevelId: levels[1]?.id ?? levels[0].id,
        usableLevelIds: levels.map((item) => item.id),
        supply: "环境、设备或组织配给",
        environment: "稳定媒介环境",
        conversion: "按法门效率转化",
        shortageConsequence: "技能释放受限",
      },
    ],
    methods,
    abilities,
    formations: [],
    foundations: [
      {
        ...named(
          `${systemId}-foundation-aptitude`,
          "初始适配",
          "决定接入与学习速度。",
        ),
        factor: "适配度",
        value: "中",
        impact: "训练效率 +8%",
        affectedTracks: [`${systemId}-track-main`],
        adjustment: "训练、改造或授权",
        permanence: "可成长",
      },
    ],
    transitions: [],
    constraints: [
      {
        ...named(
          `${systemId}-constraint-overload`,
          "过载",
          "输出超过载体承受范围。",
        ),
        category: "cost",
        trigger: "释放负荷超过阈值",
        consequence: "回路损伤或失控",
        mitigation: "降低功率并先完成回收",
        reversible: true,
      },
    ],
    audit: [],
  };
}

export function createDefaultCultivationEcology(): CultivationEcology {
  const taixu = createTaixu();
  const magic = createGenericSystem(
    "red-sun",
    "赤曜元素学派",
    "元素魔法",
    "魔力",
    ["感知", "塑形", "共鸣", "领域", "星冠"],
    [
      [
        "red-sun-node-ember",
        "火种",
        "媒介节点",
        "锁定施法媒介",
        "需要匹配元素纯度",
      ],
      [
        "red-sun-node-rune",
        "一式符文",
        "符文节点",
        "展开基础语法",
        "必须遵循元素语法",
      ],
      [
        "red-sun-node-core",
        "元素核心",
        "能量节点",
        "元素换能与放大",
        "受媒介承载上限约束",
      ],
      [
        "red-sun-node-return",
        "回收环",
        "回收节点",
        "回收残余魔力",
        "未闭合会产生回路灼蚀",
      ],
    ],
    [
      ["seven-forms", "赤曜七式", "符文语法 / 元素共鸣"],
      ["ash-circle", "灰烬圆环", "防护回路 / 等价交换"],
    ],
    [
      ["fire-lance", "火焰长枪", "offensive"],
      ["thermal-ward", "热域护盾", "support"],
    ],
  );
  magic.formations.push(
    formation(
      "red-sun-formation",
      "星冠仪式阵",
      "将多段符文回路部署为领域输出",
      "red-sun-node-core",
      ["red-sun-level-2"],
      ["red-sun-seven-forms"],
    ),
  );
  const resonance = createGenericSystem(
    "resonance",
    "神经共鸣计划",
    "精神异能",
    "精神负荷",
    ["感知", "聚焦", "投射", "共振", "超载"],
    [
      [
        "resonance-node-memory",
        "记忆锚",
        "认知节点",
        "建立稳定焦点",
        "必须绑定可验证记忆",
      ],
      [
        "resonance-node-cortex",
        "前额叶",
        "神经节点",
        "压缩意向与控制注意力",
        "受精神强度上限约束",
      ],
      [
        "resonance-node-feedback",
        "回声室",
        "反馈节点",
        "检测认知反器",
        "必须配置噪声回收",
      ],
      [
        "resonance-node-reset",
        "现实锚",
        "复位节点",
        "恢复现实认知",
        "退出路线前必须复位",
      ],
    ],
    [
      ["silent-resonance", "静默共鸣协议", "情绪阈值 / 记忆锚定"],
      ["memory-palace", "记忆宫殿训练", "认知索引 / 回声回收"],
    ],
    [
      ["mind-pulse", "意念脉冲", "offensive"],
      ["empathy-link", "共感链接", "mental"],
    ],
  );
  return {
    ...createEmptyCultivationEcology(),
    worldOrigins: origins,
    systems: [taixu, magic, resonance],
    crossSystemRelations: [
      {
        ...named(
          "relation-magic-taixu",
          "元素魔法转换为真元",
          "通过媒介与法则翻译建立受限转换。",
        ),
        sourceSystemId: "red-sun",
        targetSystemId: "taixu",
        relation: "转换",
        conversionRule: "星辉经元素核心提纯后转为低纯度真元",
        conditions: ["完成元素法则翻译", "存在兼容媒介"],
        risk: "元素残响造成经脉污染",
      },
      {
        ...named(
          "relation-resonance-taixu",
          "精神异能辅助神魂",
          "精神节点可作为观想法门的外部接口。",
        ),
        sourceSystemId: "resonance",
        targetSystemId: "taixu",
        relation: "依赖",
        conversionRule: "精神负荷替代部分神魂观想成本",
        conditions: ["神魂稳定度达标"],
        risk: "认知偏差被带入神魂",
      },
    ],
  };
}

export const DEFAULT_CULTIVATION_ECOLOGY = createDefaultCultivationEcology();

export function cloneDefaultCultivationEcology(): CultivationEcology {
  return JSON.parse(
    JSON.stringify(DEFAULT_CULTIVATION_ECOLOGY),
  ) as CultivationEcology;
}

export function newEcologyId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
