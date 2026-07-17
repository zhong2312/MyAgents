const byId = (id) => document.getElementById(id);

const levelTypes = [
  { id: "world-root", name: "世界根", description: "项目中全部世界空间的总入口。", icon: "globe-2", mapKind: "不在地图显示", source: "内置初始模板", parents: [], children: ["multiverse"] },
  { id: "multiverse", name: "多元宇宙", description: "容纳多个宇宙或相互隔离世界体系的空间层级。", icon: "sparkles", mapKind: "宇宙区域", source: "内置初始模板", parents: ["world-root"], children: ["universe"] },
  { id: "universe", name: "宇宙", description: "拥有共同基础法则和时空结构的完整宇宙。", icon: "orbit", mapKind: "宇宙区域", source: "内置初始模板", parents: ["multiverse"], children: ["galaxy-group"] },
  { id: "galaxy-group", name: "星系群", description: "由多个星系构成的大尺度天体集合。", icon: "sparkles", mapKind: "星域轮廓", source: "内置初始模板", parents: ["universe"], children: ["star-system"] },
  { id: "star-system", name: "恒星系", description: "围绕一个或多个恒星组织的天体系统。", icon: "sun", mapKind: "星域轮廓", source: "内置初始模板", parents: ["galaxy-group"], children: ["planet"] },
  { id: "planet", name: "星球", description: "可承载大陆、文明与独立生态的行星空间。", icon: "circle-dot", mapKind: "行星点位", source: "内置初始模板", parents: ["star-system"], children: ["continent"] },
  { id: "continent", name: "大陆", description: "星球上的大型连续陆地区域。", icon: "land-plot", mapKind: "地理面", source: "内置初始模板", parents: ["planet"], children: ["country", "independent-city"] },
  { id: "country", name: "国家", description: "具有稳定疆域、组织体系和共同政治身份的国家。", icon: "flag", mapKind: "地理面", source: "内置初始模板", parents: ["continent"], children: ["province", "city"] },
  { id: "province", name: "行省", description: "国家下辖的区域性行政层级。", icon: "map", mapKind: "地理面", source: "内置初始模板", parents: ["country"], children: ["city"] },
  { id: "city", name: "城市", description: "依附于上级空间的城市或聚落。", icon: "building-2", mapKind: "聚落点位", source: "内置初始模板", parents: ["country", "province"], children: [] },
  { id: "independent-city", name: "独立城市", description: "在空间树中直接归属于大陆或自定义区域的城市。", icon: "landmark", mapKind: "聚落点位", source: "项目自定义", parents: ["continent"], children: [] },
  { id: "custom-region", name: "自定义地域", description: "用于作者自定义的非标准空间层级。", icon: "brackets", mapKind: "地理面", source: "项目自定义", parents: [], children: [] },
];

const settingTemplates = [
  { id: "universe-overview", name: "宇宙总览", group: "世界", description: "概括宇宙的叙事定位、边界与核心特征。", source: "内置初始模板", version: "v1.3", skeleton: "# 宇宙总览\n\n> 用一句话定义这个宇宙在故事中的独特位置。\n\n## 核心特征\n\n- \n\n## 空间边界\n\n## 叙事用途\n", agentGuide: "帮助作者区分设定事实与叙事功能；发现空泛描述时追问可被角色观察到的证据。" },
  { id: "universe-structure", name: "宇宙结构", group: "世界", description: "描述宇宙的主要区域、尺度和边界。", source: "内置初始模板", version: "v1.1", skeleton: "# 宇宙结构\n\n## 空间分区\n\n## 边界与通道\n\n## 观测限制\n", agentGuide: "优先梳理空间结构，不自动创建下级节点。" },
  { id: "spacetime-rules", name: "时空规则", group: "世界", description: "记录时间、距离与跨域移动的基本规则。", source: "内置初始模板", version: "v1.2", skeleton: "# 时空规则\n\n## 时间流速\n\n## 空间距离\n\n## 穿越条件\n\n## 已知例外\n", agentGuide: "检查规则是否可被剧情利用，并提醒作者记录例外的代价。" },
  { id: "basic-laws", name: "基础法则", group: "世界", description: "定义物理、魔法或超自然现象的底层约束。", source: "内置初始模板", version: "v1.4", skeleton: "# 基础法则\n\n## 可观测法则\n\n## 能量来源\n\n## 不可突破的边界\n", agentGuide: "避免替作者补全体系，只基于已给事实检查自洽性。" },
  { id: "civilization-distribution", name: "文明分布", group: "社会", description: "记录主要文明在宇宙尺度的分布。", source: "内置初始模板", version: "v1.0", skeleton: "# 文明分布\n\n## 已知文明\n\n## 未探索区域\n\n## 交流条件\n", agentGuide: "提示作者将文明实体建立为对应空间节点或人物组织。" },
  { id: "macro-factions", name: "宏观势力", group: "政治", description: "梳理能跨越多个天体活动的主要势力。", source: "内置初始模板", version: "v1.2", skeleton: "# 宏观势力\n\n## 势力概览\n\n## 活动区域\n\n## 彼此关系\n", agentGuide: "聚焦势力在当前节点中的事实，不扩展到关系图谱。" },
  { id: "cosmic-events", name: "宇宙级重大事件", group: "世界", description: "记录改变宇宙状态的关键历史事件。", source: "内置初始模板", version: "v1.1", skeleton: "# 宇宙级重大事件\n\n## 事件时间线\n\n## 直接影响\n\n## 长期余波\n", agentGuide: "帮助作者使用明确前因、转折与可见后果记录事件。" },
  { id: "country-overview", name: "国家总览", group: "政治", description: "概括国家定位、政体与叙事作用。", source: "内置初始模板", version: "v1.0", skeleton: "# 国家总览\n\n## 一句话定位\n\n## 政体概览\n\n## 核心矛盾\n", agentGuide: "优先确认国家在故事当下的状态。" },
  { id: "territory", name: "疆域", group: "地理", description: "记录疆界、地形和行政分区。", source: "内置初始模板", version: "v1.0", skeleton: "# 疆域\n\n## 边界\n\n## 主要区域\n\n## 交通节点\n", agentGuide: "提醒作者把可独立编辑的重要地点加入空间树。" },
  { id: "politics", name: "政治", group: "政治", description: "记录权力结构和决策机制。", source: "内置初始模板", version: "v1.0", skeleton: "# 政治\n\n## 权力结构\n\n## 决策机制\n\n## 当前矛盾\n", agentGuide: "区分正式制度与实际权力。" },
  { id: "military", name: "军事", group: "军事", description: "记录军制、兵力和战略能力。", source: "内置初始模板", version: "v1.0", skeleton: "# 军事\n\n## 军制\n\n## 主要力量\n\n## 战略限制\n", agentGuide: "避免虚构数字，未知规模使用待核定标记。" },
  { id: "economy", name: "经济", group: "经济", description: "记录资源、生产与交换网络。", source: "内置初始模板", version: "v1.0", skeleton: "# 经济\n\n## 核心资源\n\n## 生产体系\n\n## 贸易与货币\n", agentGuide: "追问资源如何影响普通人的选择。" },
  { id: "law", name: "法律", group: "政治", description: "记录法律来源、执行和重要禁令。", source: "内置初始模板", version: "v1.0", skeleton: "# 法律\n\n## 法律来源\n\n## 执行机构\n\n## 重要法律\n", agentGuide: "区分成文规则与实际执行。" },
  { id: "society", name: "社会", group: "社会", description: "记录阶层、组织与社会流动。", source: "内置初始模板", version: "v1.0", skeleton: "# 社会\n\n## 社会结构\n\n## 阶层流动\n\n## 公共议题\n", agentGuide: "从角色日常经验校验宏观描述。" },
  { id: "culture", name: "文化", group: "文化", description: "记录共同记忆、审美与习俗。", source: "内置初始模板", version: "v1.0", skeleton: "# 文化\n\n## 共同记忆\n\n## 节庆与习俗\n\n## 审美偏好\n", agentGuide: "鼓励具体器物、动作和场景，而不是抽象形容。" },
  { id: "religion", name: "宗教", group: "文化", description: "记录信仰体系与宗教实践。", source: "内置初始模板", version: "v1.0", skeleton: "# 宗教\n\n## 信仰对象\n\n## 组织与仪式\n\n## 世俗影响\n", agentGuide: "区分信仰事实、教义主张和角色认知。" },
  { id: "ethnicity", name: "民族", group: "社会", description: "记录群体身份、迁徙与共存关系。", source: "内置初始模板", version: "v1.0", skeleton: "# 民族\n\n## 群体构成\n\n## 历史迁徙\n\n## 当代关系\n", agentGuide: "避免把群体写成单一性格。" },
  { id: "language", name: "语言", group: "文化", description: "记录语言分布、文字和交流障碍。", source: "内置初始模板", version: "v1.0", skeleton: "# 语言\n\n## 语言分布\n\n## 文字系统\n\n## 交流场景\n", agentGuide: "提示作者记录称谓和翻译约定。" },
  { id: "daily-life", name: "日常生活", group: "社会", description: "记录衣食住行与普通人的生活节奏。", source: "内置初始模板", version: "v1.0", skeleton: "# 日常生活\n\n## 衣食住行\n\n## 工作与休息\n\n## 普通人的一天\n", agentGuide: "用角色可接触的细节检验世界设定。" },
];

const profiles = {
  "world-root": ["universe-overview"],
  multiverse: ["universe-overview", "universe-structure", "spacetime-rules"],
  universe: ["universe-overview", "universe-structure", "spacetime-rules", "basic-laws", "civilization-distribution", "macro-factions", "cosmic-events"],
  "galaxy-group": ["universe-overview", "universe-structure", "civilization-distribution"],
  "star-system": ["universe-overview", "universe-structure", "basic-laws"],
  planet: ["universe-overview", "territory", "civilization-distribution", "basic-laws"],
  continent: ["universe-overview", "territory", "civilization-distribution", "macro-factions"],
  country: ["country-overview", "territory", "politics", "military", "economy", "law", "society", "culture", "religion", "ethnicity", "language", "daily-life"],
  province: ["territory", "politics", "economy", "society", "culture", "daily-life"],
  city: ["territory", "politics", "economy", "society", "culture", "daily-life"],
  "independent-city": ["country-overview", "territory", "politics", "economy", "law", "society", "culture", "daily-life"],
  "custom-region": ["universe-overview"],
};

const disabledAssociations = new Map();

const worldTree = [
  { id: "world-root", name: "烬海世界根", typeId: "world-root", children: [
    { id: "multiverse-realms", name: "诸界域", typeId: "multiverse", children: [
      { id: "universe-main", name: "主宇宙", typeId: "universe", children: [
        { id: "galaxy-cangheng", name: "苍衡星系群", typeId: "galaxy-group", children: [
          { id: "system-qingyao", name: "青曜恒星系", typeId: "star-system", children: [
            { id: "planet-cangheng", name: "苍衡星", typeId: "planet", children: [
              { id: "continent-jiuzhou", name: "九州大陆", typeId: "continent", children: [
                { id: "country-dasheng", name: "大晟王朝", typeId: "country", children: [] },
                { id: "city-chengtian", name: "承天自由城", typeId: "independent-city", children: [] },
              ] },
            ] },
          ] },
        ] },
      ] },
    ] },
  ] },
];

const nodeInstances = {
  "universe-main": [
    {
      id: "instance-universe-overview",
      templateId: "universe-overview",
      name: "宇宙总览",
      group: "世界",
      status: "已完成",
      body: "# 宇宙总览\n\n主宇宙是烬海诸界中仍保持稳定星海航路的核心宇宙，也是大多数角色理解‘世界’一词时默认指向的现实层。\n\n## 核心特征\n\n- 星海之间存在可被观测的潮汐周期。\n- 文明以青曜恒星系为已知航路中心。\n- 宇宙边缘被称为烬海，尚无可靠返航记录。\n\n## 叙事用途\n\n这里承载主线文明与诸界旅人的第一次相遇。\n",
    },
    {
      id: "instance-celestial-river",
      templateId: null,
      name: "贯穿诸界的天河水系",
      group: "地理",
      status: "草稿",
      body: "# 贯穿诸界的天河水系\n\n> 这是一份直接归属于“主宇宙”的作者自定义设定；宇宙类型的默认模板中没有水系页面。\n\n## 概念\n\n天河不是悬浮在星空中的普通河流，而是沿星海潮汐显形的银色水路。它穿过航路失效的空域，在特定周期把互不相邻的世界短暂接到同一条水岸。\n\n## 可见规律\n\n- 河水只在青曜历每个朔望交替的第七夜显形。\n- 取出的水会在离开天河一刻钟后化为细盐。\n- 船只必须保留一盏来自出发地的灯，才能找到返程水道。\n\n## 叙事钩子\n\n大晟王朝失踪的册封船可能并未沉没，而是误入下一次尚未到来的潮汐。\n",
    },
  ],
};

const expandedNodeIds = new Set(["world-root", "multiverse-realms", "universe-main", "galaxy-cangheng", "system-qingyao", "planet-cangheng", "continent-jiuzhou"]);
let selectedNodeId = "universe-main";
let selectedSettingRef = "instance-celestial-river";
let selectedTypeId = "universe";
let selectedTemplateId = "universe-overview";
let selectedProfileTypeId = "universe";
let settingsSortAlpha = false;
let editorMode = "visual";
let editorLoading = false;
let saveTimer = null;
let nodeDialogParentId = "universe-main";
let draggedTemplateId = null;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function slugify(value) {
  return value.trim().replace(/\s+/g, "-").replace(/[\\/:*?"<>|]/g, "-");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
}

function showToast(message, icon = "check") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<i data-lucide="${escapeHtml(icon)}"></i><span>${escapeHtml(message)}</span>`;
  byId("toast-region").appendChild(toast);
  refreshIcons();
  window.setTimeout(() => toast.remove(), 3400);
}

function markDirty() {
  byId("save-state").classList.add("dirty");
  byId("editor-save-state").classList.add("dirty");
  byId("save-state").innerHTML = '<i data-lucide="loader-circle"></i>正在保存';
  byId("editor-save-state").textContent = "正在保存";
  refreshIcons();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    byId("save-state").classList.remove("dirty");
    byId("editor-save-state").classList.remove("dirty");
    byId("save-state").innerHTML = '<i data-lucide="circle-check"></i>全部更改已保存';
    byId("editor-save-state").textContent = "已保存";
    refreshIcons();
  }, 650);
}

function getType(typeId) {
  return levelTypes.find((type) => type.id === typeId);
}

function getTemplate(templateId) {
  return settingTemplates.find((template) => template.id === templateId);
}

function findNode(nodeId, nodes = worldTree, path = []) {
  for (const node of nodes) {
    const nextPath = [...path, node];
    if (node.id === nodeId) return { node, path: nextPath };
    const nested = findNode(nodeId, node.children || [], nextPath);
    if (nested) return nested;
  }
  return null;
}

function flattenNodes(nodes = worldTree, result = []) {
  nodes.forEach((node) => {
    result.push(node);
    flattenNodes(node.children || [], result);
  });
  return result;
}

function typeUsage(typeId) {
  return flattenNodes().filter((node) => node.typeId === typeId).length;
}

function activeTemplateIds(typeId) {
  const disabled = disabledAssociations.get(typeId) || new Set();
  return (profiles[typeId] || []).filter((templateId) => !disabled.has(templateId));
}

function allInstancesForNode(nodeId) {
  nodeInstances[nodeId] ||= [];
  return nodeInstances[nodeId];
}

function currentNode() {
  return findNode(selectedNodeId)?.node || worldTree[0];
}

function currentType() {
  return getType(currentNode().typeId);
}

function currentInstance() {
  return allInstancesForNode(selectedNodeId).find((item) => item.id === selectedSettingRef) || null;
}

function currentVirtualTemplate() {
  return selectedSettingRef.startsWith("virtual:") ? getTemplate(selectedSettingRef.slice(8)) : null;
}

function fallbackMarkdown(source) {
  const escaped = escapeHtml(source);
  const lines = escaped.split("\n");
  const output = [];
  let listOpen = false;
  lines.forEach((line) => {
    if (line.startsWith("- ")) {
      if (!listOpen) output.push("<ul>");
      listOpen = true;
      output.push(`<li>${line.slice(2)}</li>`);
      return;
    }
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
    if (line.startsWith("### ")) output.push(`<h3>${line.slice(4)}</h3>`);
    else if (line.startsWith("## ")) output.push(`<h2>${line.slice(3)}</h2>`);
    else if (line.startsWith("# ")) output.push(`<h1>${line.slice(2)}</h1>`);
    else if (line.startsWith("&gt; ")) output.push(`<blockquote>${line.slice(5)}</blockquote>`);
    else if (line.trim()) output.push(`<p>${line}</p>`);
  });
  if (listOpen) output.push("</ul>");
  return output.join("");
}

function markdownToHtml(source) {
  if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(source));
  return fallbackMarkdown(source);
}

function visualToMarkdown() {
  if (window.TurndownService) {
    const converter = new window.TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
    return converter.turndown(byId("visual-editor").innerHTML);
  }
  return byId("visual-editor").innerText;
}

function renderTree() {
  const query = byId("tree-search")?.value.trim().toLowerCase() || "";
  const rows = [];
  const renderNodes = (nodes, depth) => {
    nodes.forEach((node) => {
      const type = getType(node.typeId);
      const hasChildren = Boolean(node.children?.length);
      const expanded = expandedNodeIds.has(node.id);
      const match = !query || `${node.name}${type?.name || ""}`.toLowerCase().includes(query);
      if (match || !query) {
        rows.push(`<div class="tree-item" role="none"><div class="tree-row ${node.id === selectedNodeId ? "selected" : ""}" role="treeitem" aria-selected="${node.id === selectedNodeId}" aria-expanded="${hasChildren ? expanded : "false"}" data-node-id="${escapeHtml(node.id)}" style="--tree-depth:${depth}"><button class="tree-toggle ${expanded ? "expanded" : ""} ${hasChildren ? "" : "placeholder"}" type="button" data-tree-toggle aria-label="${expanded ? "折叠" : "展开"}${escapeHtml(node.name)}"><i data-lucide="chevron-right"></i></button><span class="tree-icon"><i data-lucide="${escapeHtml(type?.icon || "brackets")}"></i></span><span class="tree-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span><span class="tree-type" title="层级类型：${escapeHtml(type?.name || "未配置")}">${escapeHtml(type?.name || "未配置")}</span></div></div>`);
      }
      if ((expanded || query) && hasChildren) renderNodes(node.children, depth + 1);
    });
  };
  renderNodes(worldTree, 0);
  byId("spatial-tree").innerHTML = rows.join("") || '<div class="settings-empty">没有匹配的空间节点</div>';
  byId("node-count").textContent = `${flattenNodes().length} 个节点`;
  refreshIcons();
}

function renderContext() {
  const found = findNode(selectedNodeId);
  if (!found) return;
  const type = getType(found.node.typeId);
  byId("current-node-title").textContent = found.node.name;
  byId("current-node-type").textContent = type?.name || "未配置";
  byId("settings-node-name").textContent = found.node.name;
  byId("breadcrumbs").innerHTML = found.path.map((node, index) => `${index ? '<i data-lucide="chevron-right"></i>' : ""}<span>${escapeHtml(node.name)}</span>`).join("");
  refreshIcons();
}

function settingsForNode(node) {
  const activeIds = activeTemplateIds(node.typeId);
  const instances = allInstancesForNode(node.id);
  const defaults = activeIds.map((templateId) => {
    const template = getTemplate(templateId);
    const instance = instances.find((item) => item.templateId === templateId);
    return { kind: instance ? "instance" : "virtual", ref: instance?.id || `virtual:${templateId}`, name: instance?.name || template?.name, group: instance?.group || template?.group, status: instance?.status || "未填写", templateId };
  }).filter((item) => item.name);
  const custom = instances.filter((item) => !item.templateId || !activeIds.includes(item.templateId)).map((item) => ({ kind: "instance", ref: item.id, name: item.name, group: item.group, status: item.status, templateId: item.templateId }));
  return { defaults, custom };
}

function settingStateMarkup(status) {
  if (status === "已完成") return '<span class="setting-state complete"><i data-lucide="circle-check"></i>已完成</span>';
  if (status === "草稿") return '<span class="setting-state draft"><i data-lucide="circle-dot-dashed"></i>草稿</span>';
  return '<span class="setting-state"><i data-lucide="file-clock"></i>未填写</span>';
}

function renderSettings() {
  const node = currentNode();
  const type = getType(node.typeId);
  const query = byId("settings-search")?.value.trim().toLowerCase() || "";
  const groups = settingsForNode(node);
  const filterSort = (items) => {
    const filtered = items.filter((item) => `${item.name}${item.group}`.toLowerCase().includes(query));
    return settingsSortAlpha ? filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) : filtered;
  };
  const defaults = filterSort(groups.defaults);
  const custom = filterSort(groups.custom);
  const renderRows = (items) => items.map((item) => `<button class="setting-row ${item.ref === selectedSettingRef ? "selected" : ""}" type="button" data-setting-ref="${escapeHtml(item.ref)}"><span class="setting-icon"><i data-lucide="${item.kind === "virtual" ? "file-clock" : item.group === "地理" ? "waves" : "file-text"}"></i></span><span class="setting-row-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small>${escapeHtml(item.group)} · ${item.kind === "virtual" ? "虚拟页面" : "Markdown"}</small></span>${settingStateMarkup(item.status)}</button>`).join("");
  byId("settings-node-meta").textContent = `${type?.name || "未配置"} · ${groups.defaults.length} 个默认模板`;
  byId("setting-list").innerHTML = `<div class="setting-group-header"><span>默认设定</span><span>${defaults.length}</span></div>${renderRows(defaults) || '<div class="settings-empty">该类型暂未启用默认模板</div>'}<div class="setting-group-header"><span>自定义设定</span><span>${custom.length}</span></div>${renderRows(custom) || '<div class="settings-empty">尚未添加当前节点自定义设定</div>'}`;
  refreshIcons();
}

function ensureSelectedSetting() {
  const groups = settingsForNode(currentNode());
  const allRefs = [...groups.defaults, ...groups.custom].map((item) => item.ref);
  if (!allRefs.includes(selectedSettingRef)) selectedSettingRef = allRefs[0] || "";
}

function renderEditor() {
  editorLoading = true;
  const node = currentNode();
  const type = getType(node.typeId);
  const instance = currentInstance();
  const virtual = currentVirtualTemplate();
  const item = instance || virtual;
  if (!item) {
    byId("document-title").textContent = "选择一份设定";
    byId("document-path").textContent = `${node.name} / 当前节点设定`;
    byId("visual-editor").innerHTML = '<p>当前节点还没有可编辑的设定页面。</p>';
    byId("source-editor").value = "";
    byId("promote-setting").classList.add("hidden");
    editorLoading = false;
    return;
  }
  const name = item.name;
  const group = item.group;
  const body = instance?.body || virtual?.skeleton || `# ${name}\n`;
  byId("document-title").textContent = name;
  byId("document-path").textContent = `${node.name} / ${instance && (!instance.templateId || !activeTemplateIds(node.typeId).includes(instance.templateId)) ? "自定义设定" : "默认设定"}`;
  byId("document-status").textContent = instance?.status || "未填写";
  byId("document-status").className = `status-pill ${instance?.status === "已完成" ? "complete" : instance?.status === "草稿" ? "draft" : ""}`;
  byId("visual-editor").innerHTML = markdownToHtml(body);
  byId("source-editor").value = body;
  byId("lazy-notice").classList.toggle("hidden", Boolean(instance));
  const canPromote = Boolean(instance && !instance.templateId);
  byId("promote-setting").classList.toggle("hidden", !canPromote);
  byId("promote-setting").innerHTML = `<i data-lucide="arrow-up-to-line"></i><span>提升为“${escapeHtml(type?.name || "当前类型")}”默认</span>`;
  byId("file-path").textContent = `settings/${node.name}/${name}.md${instance ? "" : "（未创建）"}`;
  updateDocumentCount();
  refreshIcons();
  editorLoading = false;
}

function updateDocumentCount() {
  const text = editorMode === "source" ? byId("source-editor").value : byId("visual-editor").innerText;
  const normalized = text.replace(/\s/g, "");
  const lines = text ? text.split("\n").length : 0;
  byId("document-count").textContent = `${normalized.length} 字 · ${lines} 行`;
}

function ensureInstanceFromVirtual() {
  const template = currentVirtualTemplate();
  if (!template) return currentInstance();
  const instance = { id: `instance-${Date.now()}`, templateId: template.id, name: template.name, group: template.group, status: "草稿", body: template.skeleton };
  allInstancesForNode(selectedNodeId).push(instance);
  selectedSettingRef = instance.id;
  byId("lazy-notice").classList.add("hidden");
  byId("document-status").textContent = "草稿";
  byId("document-status").className = "status-pill draft";
  byId("file-path").textContent = `settings/${currentNode().name}/${instance.name}.md`;
  renderSettings();
  showToast(`已创建 ${instance.name}.md`, "file-check-2");
  return instance;
}

function persistEditorContent() {
  if (editorLoading) return;
  const instance = ensureInstanceFromVirtual();
  if (!instance) return;
  instance.body = editorMode === "source" ? byId("source-editor").value : visualToMarkdown();
  if (instance.status === "未填写") instance.status = "草稿";
  updateDocumentCount();
  markDirty();
}

function setEditorMode(mode) {
  if (mode === editorMode) return;
  if (mode === "source") byId("source-editor").value = visualToMarkdown();
  else byId("visual-editor").innerHTML = markdownToHtml(byId("source-editor").value);
  editorMode = mode;
  document.querySelectorAll("[data-editor-mode]").forEach((button) => button.classList.toggle("active", button.dataset.editorMode === mode));
  byId("visual-editor").classList.toggle("hidden", mode !== "visual");
  byId("source-editor").classList.toggle("hidden", mode !== "source");
  updateDocumentCount();
  (mode === "source" ? byId("source-editor") : byId("visual-editor")).focus();
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  const groups = settingsForNode(currentNode());
  const river = groups.custom.find((item) => item.name.includes("天河"));
  selectedSettingRef = river?.ref || groups.defaults[0]?.ref || groups.custom[0]?.ref || "";
  renderTree();
  renderContext();
  renderSettings();
  renderEditor();
  closeDrawers();
}

function closeDrawers() {
  document.querySelectorAll(".drawer-panel.open").forEach((panel) => panel.classList.remove("open"));
  byId("drawer-scrim").hidden = true;
}

function openDrawer(id) {
  closeDrawers();
  byId(id).classList.add("open");
  byId("drawer-scrim").hidden = false;
}

function populateTypeSelect(select, value) {
  select.innerHTML = levelTypes.filter((type) => !type.archived).map((type) => `<option value="${escapeHtml(type.id)}" ${type.id === value ? "selected" : ""}>${escapeHtml(type.name)} · ${escapeHtml(type.source)}</option>`).join("");
}

function openNodeDialog(parentId = selectedNodeId) {
  nodeDialogParentId = parentId;
  const parent = parentId ? findNode(parentId)?.node : null;
  byId("node-parent-name").textContent = parent?.name || "新的空间树根";
  byId("new-node-name").value = parentId === "universe-main" ? "天河源界" : "未命名空间";
  populateTypeSelect(byId("new-node-type"), parent ? getType(parent.typeId)?.children?.[0] : "world-root");
  byId("quick-type-fields").classList.add("hidden");
  byId("quick-type-name").value = "";
  byId("node-dialog").showModal();
}

function openChangeTypeDialog() {
  const node = currentNode();
  byId("change-type-node-name").textContent = node.name;
  populateTypeSelect(byId("change-type-select"), node.typeId);
  renderChangeTypeSummary();
  byId("change-type-dialog").showModal();
}

function renderChangeTypeSummary() {
  const node = currentNode();
  const nextTypeId = byId("change-type-select").value;
  const currentIds = new Set(activeTemplateIds(node.typeId));
  const nextIds = new Set(activeTemplateIds(nextTypeId));
  const added = [...nextIds].filter((id) => !currentIds.has(id)).map((id) => getTemplate(id)?.name).filter(Boolean);
  const removed = [...currentIds].filter((id) => !nextIds.has(id)).map((id) => getTemplate(id)?.name).filter(Boolean);
  byId("change-type-summary").innerHTML = `<div class="change-summary-row"><i data-lucide="file-plus-2"></i><div><strong>新增 ${added.length} 个默认虚拟页面</strong><span>${escapeHtml(added.slice(0, 4).join("、") || "没有新增页面")}${added.length > 4 ? "等" : ""}</span></div></div><div class="change-summary-row"><i data-lucide="folder-heart"></i><div><strong>${removed.length} 个已有默认页面转为自定义</strong><span>${escapeHtml(removed.slice(0, 4).join("、") || "没有页面需要转换")}；已填写正文继续保留。</span></div></div><div class="change-summary-row"><i data-lucide="shield-check"></i><div><strong>不会删除文件或覆盖正文</strong><span>仅改变今后在设定列表中的默认分组与虚拟页面。</span></div></div>`;
  refreshIcons();
}

function promoteCurrentSetting() {
  const instance = currentInstance();
  const node = currentNode();
  const type = getType(node.typeId);
  if (!instance || instance.templateId) return;
  let templateId = `project-${slugify(instance.name)}-${Date.now()}`;
  const existing = settingTemplates.find((template) => template.name === instance.name);
  if (existing) templateId = existing.id;
  else settingTemplates.push({ id: templateId, name: instance.name, group: instance.group, description: `由“${node.name}”的自定义设定提升为项目模板。`, source: "项目自定义", version: "v1.0", skeleton: instance.body, agentGuide: "基于当前项目事实协助作者继续完善，不覆盖节点已有正文。" });
  profiles[node.typeId] ||= [];
  if (!profiles[node.typeId].includes(templateId)) profiles[node.typeId].push(templateId);
  disabledAssociations.get(node.typeId)?.delete(templateId);
  instance.templateId = templateId;
  selectedTemplateId = templateId;
  renderSettings();
  renderEditor();
  syncMetaCounts();
  showToast(`已加入“${type.name}”默认模板；当前正文保持不变`, "badge-check");
  markDirty();
}

function openMeta(tab = "types") {
  byId("library-view").classList.remove("active");
  byId("meta-view").classList.add("active");
  selectMetaTab(tab);
  renderAllMeta();
}

function closeMeta() {
  byId("meta-view").classList.remove("active");
  byId("library-view").classList.add("active");
  ensureSelectedSetting();
  renderContext();
  renderTree();
  renderSettings();
  renderEditor();
}

function selectMetaTab(tab) {
  document.querySelectorAll("[data-meta-tab]").forEach((button) => {
    const active = button.dataset.metaTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-meta-page]").forEach((page) => page.classList.toggle("active", page.dataset.metaPage === tab));
}

function syncMetaCounts() {
  byId("type-tab-count").textContent = String(levelTypes.filter((type) => !type.archived).length);
  byId("template-tab-count").textContent = String(settingTemplates.length);
}

function renderLevelTypeList() {
  const query = byId("type-search")?.value.trim().toLowerCase() || "";
  const items = levelTypes.filter((type) => !type.archived && `${type.name}${type.description}`.toLowerCase().includes(query));
  byId("level-type-list").innerHTML = items.map((type) => `<button class="meta-list-item ${type.id === selectedTypeId ? "selected" : ""}" type="button" data-type-id="${escapeHtml(type.id)}"><span class="meta-item-icon"><i data-lucide="${escapeHtml(type.icon)}"></i></span><span class="meta-item-copy"><strong>${escapeHtml(type.name)}</strong><small>${escapeHtml(type.source)}</small></span><span class="meta-item-count">${typeUsage(type.id)} 节点</span></button>`).join("");
  refreshIcons();
}

function renderTypeDetail() {
  const type = getType(selectedTypeId) || levelTypes[0];
  selectedTypeId = type.id;
  byId("type-source").textContent = `${type.source} · 项目副本`;
  byId("type-detail-title").textContent = type.name;
  byId("type-name").value = type.name;
  byId("type-description").value = type.description;
  byId("type-icon").value = type.icon;
  byId("type-map-kind").value = type.mapKind;
  byId("type-usage").value = `${typeUsage(type.id)} 个空间节点`;
  const chips = (selectedIds, relation) => levelTypes.filter((item) => item.id !== type.id && !item.archived).map((item) => `<label class="check-chip"><input type="checkbox" data-type-relation="${relation}" value="${escapeHtml(item.id)}" ${selectedIds.includes(item.id) ? "checked" : ""}/><span>${escapeHtml(item.name)}</span></label>`).join("");
  byId("parent-type-options").innerHTML = chips(type.parents || [], "parents");
  byId("child-type-options").innerHTML = chips(type.children || [], "children");
  refreshIcons();
}

function uniqueGroups() {
  return [...new Set(settingTemplates.map((template) => template.group))];
}

function syncGroupOptions() {
  const groups = uniqueGroups();
  const fill = (select, allLabel) => {
    const previous = select.value;
    select.innerHTML = `<option value="all">${allLabel}</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("")}`;
    if (["all", ...groups].includes(previous)) select.value = previous;
  };
  fill(byId("template-group-filter"), "全部分组");
  fill(byId("profile-group-filter"), "全部");
}

function renderTemplateList() {
  const filter = byId("template-group-filter").value || "all";
  const items = settingTemplates.filter((template) => filter === "all" || template.group === filter);
  byId("template-list").innerHTML = items.map((template) => `<button class="meta-list-item ${template.id === selectedTemplateId ? "selected" : ""}" type="button" data-template-id="${escapeHtml(template.id)}"><span class="meta-item-icon"><i data-lucide="file-code-2"></i></span><span class="meta-item-copy"><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.group)} · ${escapeHtml(template.source)}</small></span><span class="meta-item-count">${escapeHtml(template.version)}</span></button>`).join("");
  refreshIcons();
}

function renderTemplateDetail() {
  const template = getTemplate(selectedTemplateId) || settingTemplates[0];
  selectedTemplateId = template.id;
  byId("template-source").textContent = `${template.source} · ${template.version}`;
  byId("template-detail-title").textContent = template.name;
  byId("template-name").value = template.name;
  byId("template-group").value = template.group;
  byId("template-description").value = template.description;
  byId("template-skeleton").value = template.skeleton;
  byId("template-agent-guide").value = template.agentGuide;
  byId("template-version-note").textContent = "最近修改：项目初始化";
}

function renderProfileTypes() {
  byId("profile-type-list").innerHTML = levelTypes.filter((type) => !type.archived).map((type) => `<button class="meta-list-item ${type.id === selectedProfileTypeId ? "selected" : ""}" type="button" data-profile-type-id="${escapeHtml(type.id)}"><span class="meta-item-icon"><i data-lucide="${escapeHtml(type.icon)}"></i></span><span class="meta-item-copy"><strong>${escapeHtml(type.name)}</strong><small>${activeTemplateIds(type.id).length} 个已启用默认模板</small></span><span class="meta-item-count">${typeUsage(type.id)} 节点</span></button>`).join("");
  refreshIcons();
}

function orderedTemplatesForProfile(typeId) {
  const order = profiles[typeId] || [];
  return [...settingTemplates].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name, "zh-CN");
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function renderAssociations() {
  const type = getType(selectedProfileTypeId) || levelTypes[0];
  selectedProfileTypeId = type.id;
  const filter = byId("profile-group-filter").value || "all";
  const order = profiles[type.id] || [];
  const disabled = disabledAssociations.get(type.id) || new Set();
  const templates = orderedTemplatesForProfile(type.id).filter((template) => filter === "all" || template.group === filter);
  byId("profile-type-name").textContent = type.name;
  byId("association-list").innerHTML = templates.map((template) => {
    const associated = order.includes(template.id);
    const enabled = associated && !disabled.has(template.id);
    return `<div class="association-row" draggable="${associated}" data-association-id="${escapeHtml(template.id)}"><label class="switch" title="${enabled ? "停用默认模板" : "启用为默认模板"}"><input type="checkbox" data-association-toggle value="${escapeHtml(template.id)}" ${enabled ? "checked" : ""}/><span></span></label><span class="association-copy"><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.group)} · ${associated ? enabled ? "默认启用" : "关联已停用" : "未关联"}</small></span><span class="association-order"><i class="drag-handle" data-lucide="grip-vertical"></i><button class="icon-button" type="button" data-association-up="${escapeHtml(template.id)}" aria-label="上移${escapeHtml(template.name)}" title="上移" ${associated ? "" : "disabled"}><i data-lucide="arrow-up"></i></button><button class="icon-button" type="button" data-association-down="${escapeHtml(template.id)}" aria-label="下移${escapeHtml(template.name)}" title="下移" ${associated ? "" : "disabled"}><i data-lucide="arrow-down"></i></button></span></div>`;
  }).join("");
  renderProfilePreview();
  refreshIcons();
}

function renderProfilePreview() {
  const type = getType(selectedProfileTypeId);
  const ids = activeTemplateIds(selectedProfileTypeId);
  byId("preview-node-name").textContent = `未命名${type?.name || "节点"}`;
  byId("profile-preview-count").textContent = `${ids.length} 页`;
  byId("profile-preview-list").innerHTML = ids.map((id) => {
    const template = getTemplate(id);
    return `<li><span class="preview-item-copy"><strong>${escapeHtml(template?.name || "未知模板")}</strong><small>${escapeHtml(template?.group || "未分组")} · 未填写</small></span></li>`;
  }).join("") || '<li><span class="preview-item-copy"><strong>没有默认页面</strong><small>节点仍可新增自定义设定</small></span></li>';
}

function renderAllMeta() {
  syncMetaCounts();
  syncGroupOptions();
  renderLevelTypeList();
  renderTypeDetail();
  renderTemplateList();
  renderTemplateDetail();
  renderProfileTypes();
  renderAssociations();
}

function moveItem(list, id, delta) {
  const index = list.indexOf(id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= list.length) return false;
  [list[index], list[next]] = [list[next], list[index]];
  return true;
}

function updateTypeField(field, value) {
  const type = getType(selectedTypeId);
  if (!type) return;
  type[field] = value;
  byId("type-detail-title").textContent = type.name;
  renderLevelTypeList();
  renderProfileTypes();
  markDirty();
}

function updateTemplateField(field, value) {
  const template = getTemplate(selectedTemplateId);
  if (!template) return;
  template[field] = value;
  byId("template-detail-title").textContent = template.name;
  byId("template-version-note").textContent = "未发布更改 · 不影响已填写节点正文";
  renderTemplateList();
  if (field === "group") syncGroupOptions();
  renderAssociations();
  markDirty();
}

function bindEvents() {
  byId("spatial-tree").addEventListener("click", (event) => {
    const row = event.target.closest("[data-node-id]");
    if (!row) return;
    const nodeId = row.dataset.nodeId;
    if (event.target.closest("[data-tree-toggle]")) {
      expandedNodeIds.has(nodeId) ? expandedNodeIds.delete(nodeId) : expandedNodeIds.add(nodeId);
      renderTree();
    } else selectNode(nodeId);
  });
  byId("tree-search").addEventListener("input", renderTree);
  byId("settings-search").addEventListener("input", renderSettings);
  byId("setting-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-setting-ref]");
    if (!row) return;
    selectedSettingRef = row.dataset.settingRef;
    renderSettings();
    renderEditor();
    closeDrawers();
  });
  byId("collapse-tree").addEventListener("click", () => {
    expandedNodeIds.clear();
    expandedNodeIds.add("world-root");
    renderTree();
    showToast("空间树已折叠到世界根", "fold-vertical");
  });
  byId("sort-settings").addEventListener("click", () => {
    settingsSortAlpha = !settingsSortAlpha;
    renderSettings();
    showToast(settingsSortAlpha ? "当前节点设定按名称排序" : "当前节点设定按模板顺序排序", "arrow-down-a-z");
  });
  byId("add-node").addEventListener("click", () => openNodeDialog(selectedNodeId));
  byId("add-root-node").addEventListener("click", () => openNodeDialog(null));
  byId("change-node-type").addEventListener("click", openChangeTypeDialog);
  byId("add-setting").addEventListener("click", () => {
    byId("new-setting-name").value = selectedNodeId === "universe-main" ? "贯穿诸界的天河水系" : "未命名自定义设定";
    document.querySelector('input[name="promotion"][value="node"]').checked = true;
    byId("setting-dialog").showModal();
  });
  byId("promote-setting").addEventListener("click", promoteCurrentSetting);
  byId("open-tree").addEventListener("click", () => openDrawer("tree-panel"));
  byId("open-settings").addEventListener("click", () => openDrawer("settings-panel"));
  byId("drawer-scrim").addEventListener("click", closeDrawers);
  document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closeDrawers));
  byId("open-meta").addEventListener("click", () => openMeta("types"));
  byId("close-meta").addEventListener("click", closeMeta);
  document.querySelectorAll("[data-meta-tab]").forEach((button) => button.addEventListener("click", () => selectMetaTab(button.dataset.metaTab)));
  byId("map-destination").addEventListener("click", () => showToast("世界地图是独立导航目的地，设定库不会在此嵌入地图编辑。", "map"));
  byId("rail-toggle").addEventListener("click", () => showToast("小说工作台导航保持默认收起", "panel-left"));
  byId("project-switcher").addEventListener("click", () => showToast("当前项目：烬海编年史", "book-open"));

  document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    setEditorMode("visual");
    byId("visual-editor").focus();
    document.execCommand(button.dataset.command, false, button.dataset.value || null);
    persistEditorContent();
  }));
  document.querySelectorAll("[data-block]").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    setEditorMode("visual");
    byId("visual-editor").focus();
    document.execCommand("formatBlock", false, button.dataset.block);
    persistEditorContent();
  }));
  byId("insert-link").addEventListener("mousedown", (event) => {
    event.preventDefault();
    setEditorMode("visual");
    byId("visual-editor").focus();
    document.execCommand("createLink", false, "https://");
    persistEditorContent();
  });
  document.querySelectorAll("[data-editor-mode]").forEach((button) => button.addEventListener("click", () => setEditorMode(button.dataset.editorMode)));
  byId("visual-editor").addEventListener("input", persistEditorContent);
  byId("source-editor").addEventListener("input", persistEditorContent);

  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => byId(button.dataset.closeDialog).close()));
  byId("quick-type-toggle").addEventListener("click", () => {
    byId("quick-type-fields").classList.toggle("hidden");
    if (!byId("quick-type-fields").classList.contains("hidden")) byId("quick-type-name").focus();
  });
  byId("node-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let typeId = byId("new-node-type").value;
    const quickName = byId("quick-type-name").value.trim();
    if (!byId("quick-type-fields").classList.contains("hidden") && quickName) {
      typeId = `project-type-${Date.now()}`;
      levelTypes.push({ id: typeId, name: quickName, description: "通过新增空间节点快速创建的项目层级类型。", icon: "brackets", mapKind: "不在地图显示", source: "项目自定义", parents: [], children: [] });
      profiles[typeId] = [];
    }
    const name = byId("new-node-name").value.trim();
    if (!name || !typeId) return;
    const node = { id: `node-${Date.now()}`, name, typeId, children: [] };
    if (nodeDialogParentId) {
      const parent = findNode(nodeDialogParentId)?.node;
      if (!parent) return;
      parent.children.push(node);
      expandedNodeIds.add(parent.id);
    } else worldTree.push(node);
    byId("node-dialog").close();
    syncMetaCounts();
    selectNode(node.id);
    showToast(`已创建“${name}”并关联层级类型“${getType(typeId).name}”`, "git-branch-plus");
    markDirty();
  });
  byId("change-type-select").addEventListener("change", renderChangeTypeSummary);
  byId("change-type-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const node = currentNode();
    const oldType = getType(node.typeId);
    node.typeId = byId("change-type-select").value;
    const nextType = getType(node.typeId);
    byId("change-type-dialog").close();
    ensureSelectedSetting();
    renderContext();
    renderTree();
    renderSettings();
    renderEditor();
    renderAllMeta();
    showToast(`已从“${oldType.name}”改为“${nextType.name}”；所有正文均已保留`, "replace");
    markDirty();
  });
  byId("setting-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId("new-setting-name").value.trim();
    const group = byId("new-setting-group").value;
    if (!name) return;
    const promote = document.querySelector('input[name="promotion"]:checked').value === "profile";
    const instance = { id: `instance-${Date.now()}`, templateId: null, name, group, status: "草稿", body: `# ${name}\n\n> 这是一份直接归属于“${currentNode().name}”的自定义设定。\n\n## 核心概念\n\n\n## 可见规律\n\n- \n\n## 叙事用途\n\n` };
    allInstancesForNode(selectedNodeId).push(instance);
    selectedSettingRef = instance.id;
    byId("setting-dialog").close();
    if (promote) promoteCurrentSetting();
    else {
      renderSettings();
      renderEditor();
      showToast(`已为“${currentNode().name}”创建自定义设定`, "file-plus-2");
      markDirty();
    }
  });

  byId("type-search").addEventListener("input", renderLevelTypeList);
  byId("level-type-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-type-id]");
    if (!item) return;
    selectedTypeId = item.dataset.typeId;
    renderLevelTypeList();
    renderTypeDetail();
  });
  byId("type-name").addEventListener("input", (event) => updateTypeField("name", event.target.value));
  byId("type-description").addEventListener("input", (event) => updateTypeField("description", event.target.value));
  byId("type-icon").addEventListener("change", (event) => updateTypeField("icon", event.target.value));
  byId("type-map-kind").addEventListener("change", (event) => updateTypeField("mapKind", event.target.value));
  [byId("parent-type-options"), byId("child-type-options")].forEach((container) => container.addEventListener("change", (event) => {
    const input = event.target.closest("[data-type-relation]");
    if (!input) return;
    const type = getType(selectedTypeId);
    const key = input.dataset.typeRelation;
    const values = new Set(type[key] || []);
    input.checked ? values.add(input.value) : values.delete(input.value);
    type[key] = [...values];
    markDirty();
  }));
  byId("new-level-type").addEventListener("click", () => {
    const id = `project-type-${Date.now()}`;
    levelTypes.push({ id, name: "未命名层级类型", description: "项目自定义层级类型。", icon: "brackets", mapKind: "不在地图显示", source: "项目自定义", parents: [], children: [] });
    profiles[id] = [];
    selectedTypeId = id;
    renderAllMeta();
    byId("type-name").select();
    showToast("已创建项目自定义层级类型", "tag");
    markDirty();
  });
  byId("copy-level-type").addEventListener("click", () => {
    const source = getType(selectedTypeId);
    const copy = { ...source, id: `project-type-${Date.now()}`, name: `${source.name}副本`, source: "项目自定义", parents: [...source.parents], children: [...source.children] };
    levelTypes.push(copy);
    profiles[copy.id] = [...(profiles[source.id] || [])];
    selectedTypeId = copy.id;
    renderAllMeta();
    showToast(`已复制“${source.name}”及其默认模板关联`, "copy");
    markDirty();
  });
  byId("archive-level-type").addEventListener("click", () => {
    const type = getType(selectedTypeId);
    if (typeUsage(type.id)) {
      showToast(`“${type.name}”仍被 ${typeUsage(type.id)} 个节点使用，不能归档`, "shield-alert");
      return;
    }
    type.archived = true;
    selectedTypeId = levelTypes.find((item) => !item.archived)?.id;
    renderAllMeta();
    showToast(`已归档“${type.name}”`, "archive");
    markDirty();
  });
  byId("type-move-up").addEventListener("click", () => {
    const index = levelTypes.findIndex((type) => type.id === selectedTypeId);
    if (index > 0) [levelTypes[index - 1], levelTypes[index]] = [levelTypes[index], levelTypes[index - 1]];
    renderLevelTypeList();
    markDirty();
  });
  byId("type-move-down").addEventListener("click", () => {
    const index = levelTypes.findIndex((type) => type.id === selectedTypeId);
    if (index >= 0 && index < levelTypes.length - 1) [levelTypes[index + 1], levelTypes[index]] = [levelTypes[index], levelTypes[index + 1]];
    renderLevelTypeList();
    markDirty();
  });

  byId("template-group-filter").addEventListener("change", renderTemplateList);
  byId("template-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-template-id]");
    if (!item) return;
    selectedTemplateId = item.dataset.templateId;
    renderTemplateList();
    renderTemplateDetail();
  });
  byId("template-name").addEventListener("input", (event) => updateTemplateField("name", event.target.value));
  byId("template-group").addEventListener("change", (event) => updateTemplateField("group", event.target.value));
  byId("template-description").addEventListener("input", (event) => updateTemplateField("description", event.target.value));
  byId("template-skeleton").addEventListener("input", (event) => updateTemplateField("skeleton", event.target.value));
  byId("template-agent-guide").addEventListener("input", (event) => updateTemplateField("agentGuide", event.target.value));
  byId("new-template").addEventListener("click", () => {
    const id = `project-template-${Date.now()}`;
    settingTemplates.push({ id, name: "未命名设定模板", group: "世界", description: "项目自定义 Markdown 页面模板。", source: "项目自定义", version: "v1.0", skeleton: "# 未命名设定模板\n\n## 核心概念\n\n", agentGuide: "基于作者已提供的事实协助完善。" });
    selectedTemplateId = id;
    renderAllMeta();
    byId("template-name").select();
    showToast("已创建项目自定义设定模板", "file-plus-2");
    markDirty();
  });
  byId("copy-template").addEventListener("click", () => {
    const source = getTemplate(selectedTemplateId);
    const copy = { ...source, id: `project-template-${Date.now()}`, name: `${source.name}副本`, source: "项目自定义", version: "v1.0" };
    settingTemplates.push(copy);
    selectedTemplateId = copy.id;
    renderAllMeta();
    showToast(`已复制模板“${source.name}”`, "copy");
    markDirty();
  });
  byId("preview-template").addEventListener("click", () => {
    const template = getTemplate(selectedTemplateId);
    byId("preview-dialog-title").textContent = template.name;
    byId("template-preview-body").innerHTML = markdownToHtml(template.skeleton);
    byId("template-preview-dialog").showModal();
  });

  byId("profile-type-list").addEventListener("click", (event) => {
    const item = event.target.closest("[data-profile-type-id]");
    if (!item) return;
    selectedProfileTypeId = item.dataset.profileTypeId;
    renderProfileTypes();
    renderAssociations();
  });
  byId("profile-group-filter").addEventListener("change", renderAssociations);
  byId("association-list").addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-association-toggle]");
    if (!toggle) return;
    const typeId = selectedProfileTypeId;
    profiles[typeId] ||= [];
    disabledAssociations.set(typeId, disabledAssociations.get(typeId) || new Set());
    if (toggle.checked) {
      if (!profiles[typeId].includes(toggle.value)) profiles[typeId].push(toggle.value);
      disabledAssociations.get(typeId).delete(toggle.value);
      showToast(`已启用“${getTemplate(toggle.value).name}”`, "list-plus");
    } else {
      disabledAssociations.get(typeId).add(toggle.value);
      const affected = flattenNodes().filter((node) => node.typeId === typeId).flatMap((node) => allInstancesForNode(node.id)).filter((instance) => instance.templateId === toggle.value).length;
      showToast(`关联已停用；${affected} 份已填写正文保留为自定义设定`, "folder-heart");
    }
    renderAssociations();
    renderProfileTypes();
    markDirty();
  });
  byId("association-list").addEventListener("click", (event) => {
    const up = event.target.closest("[data-association-up]");
    const down = event.target.closest("[data-association-down]");
    if (up && moveItem(profiles[selectedProfileTypeId], up.dataset.associationUp, -1)) renderAssociations();
    if (down && moveItem(profiles[selectedProfileTypeId], down.dataset.associationDown, 1)) renderAssociations();
    if (up || down) markDirty();
  });
  byId("association-list").addEventListener("dragstart", (event) => {
    const row = event.target.closest("[data-association-id]");
    if (!row || row.getAttribute("draggable") !== "true") return;
    draggedTemplateId = row.dataset.associationId;
    row.classList.add("dragging");
  });
  byId("association-list").addEventListener("dragend", (event) => {
    event.target.closest("[data-association-id]")?.classList.remove("dragging");
    draggedTemplateId = null;
  });
  byId("association-list").addEventListener("dragover", (event) => event.preventDefault());
  byId("association-list").addEventListener("drop", (event) => {
    event.preventDefault();
    const target = event.target.closest("[data-association-id]");
    const order = profiles[selectedProfileTypeId] || [];
    if (!target || !draggedTemplateId || !order.includes(target.dataset.associationId)) return;
    const from = order.indexOf(draggedTemplateId);
    const to = order.indexOf(target.dataset.associationId);
    order.splice(to, 0, order.splice(from, 1)[0]);
    renderAssociations();
    markDirty();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawers();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      persistEditorContent();
      showToast("当前 Markdown 正文已保存", "save");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  renderTree();
  renderContext();
  renderSettings();
  renderEditor();
  renderAllMeta();
  bindEvents();
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "meta") openMeta(params.get("tab") || "types");
  refreshIcons();
});
