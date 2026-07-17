const categories = [
  { id: "era", label: "时代背景", icon: "clock-3", nodes: ["历史分期", "架空起点", "历法与纪年"] },
  { id: "events", label: "重大事件", icon: "flag", nodes: ["事件年表", "历史分歧"] },
  { id: "geography", label: "地理疆域", icon: "map-pinned", nodes: ["世界总览", "大陆与海洋", "城市与辖区", "水系与交通"] },
  { id: "climate", label: "气候环境", icon: "cloud-sun", nodes: ["气候带", "自然灾害", "生态物种"] },
  { id: "politics", label: "政治制度", icon: "landmark", nodes: ["政体形态", "中央官制", "法令与外交"] },
  { id: "military", label: "军事制度", icon: "shield", nodes: ["军制编成", "征募与军籍", "武器装备", "防御工事"] },
  { id: "economy", label: "经济贸易", icon: "coins", nodes: ["货币金融", "跨界贸易", "资源物产"] },
  { id: "society", label: "社会结构", icon: "users", nodes: ["阶层等级", "宗族家族", "民间组织"] },
  { id: "technology", label: "科技生产力", icon: "cog", nodes: ["工程建筑", "交通通信", "生产工具"] },
  { id: "culture", label: "文化思想", icon: "palette", nodes: ["主流思想", "文学艺术", "教育传承"] },
  { id: "religion", label: "宗教信仰", icon: "church", nodes: ["官方宗教", "民间信仰", "禁忌礼制"] },
  { id: "ethnicity", label: "民族族群", icon: "contact-round", nodes: ["主体族群", "族群互动", "外来势力"] },
  { id: "language", label: "语言称谓", icon: "languages", nodes: ["口语风格", "称谓体系", "忌讳用语"] },
  { id: "daily", label: "日常生活", icon: "utensils", nodes: ["饮食服饰", "居住出行", "节庆礼仪"] },
  { id: "supernatural", label: "力量与超自然", icon: "sparkles", nodes: ["力量体系", "超自然存在", "灵材法器"] },
];

const spatialTree = [
  {
    id: "world.root", name: "烬海世界根", kind: "根", icon: "orbit", children: [
      {
        id: "multiverse.all", name: "诸界域", kind: "多元宇宙", icon: "network", children: [
          {
            id: "universe.primary", name: "主宇宙", kind: "宇宙", icon: "circle-dot", children: [
              {
                id: "supercluster.kunpeng", name: "鲲鹏超星系团", kind: "超星系团", icon: "component", children: [
                  {
                    id: "group.cangheng", name: "苍衡星系群", kind: "星系群", icon: "grip", children: [
                      {
                        id: "galaxy.tianshu", name: "天枢星系", kind: "星系", icon: "sparkle", children: [
                          {
                            id: "system.qingyao", name: "青曜恒星系", kind: "恒星系", icon: "sun", children: [
                              {
                                id: "planet.cangheng", name: "苍衡星", kind: "星球", icon: "globe-2", children: [
                                  {
                                    id: "continent.jiuzhou", name: "九州大陆", kind: "大陆", icon: "map", children: [
                                      {
                                        id: "polity.dasheng", name: "大晟王朝", kind: "国家", icon: "crown", children: [
                                          {
                                            id: "custom.north-garrison", name: "北境军镇辖区", kind: "自定义层级", icon: "brackets", custom: true, children: [
                                              { id: "custom.snow-gate", name: "雪门营", kind: "边防聚落", icon: "tent-tree", custom: true },
                                              { id: "custom.canal-office", name: "漕渠署直辖水网", kind: "自定义辖区", icon: "waves", custom: true },
                                            ],
                                          },
                                          { id: "domain.luoyang", name: "雒阳京畿", kind: "直属领", icon: "castle" },
                                        ],
                                      },
                                      { id: "city.chengtian", name: "承天自由城", kind: "独立城市", icon: "building-2", independent: true },
                                      { id: "polity.tide", name: "潮生自治领", kind: "自治领", icon: "flag-triangle-right" },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { id: "universe.mirror", name: "镜海界", kind: "平行宇宙", icon: "git-branch", children: [{ id: "mirror.coast", name: "浮镜海岸邦", kind: "跨岛联盟", icon: "waves" }] },
          { id: "universe.noon", name: "无昼界", kind: "宇宙", icon: "moon", children: [{ id: "noon.ring7", name: "第七环带", kind: "人造环带", icon: "circle-dashed" }] },
        ],
      },
    ],
  },
];

const institutionGroups = [
  {
    label: "诸界远征军 · 跨宇宙制度",
    items: [
      { id: "scope.primary", name: "主宇宙全域", detail: "整宇宙 · 联席议会授权", type: "整宇宙" },
      { id: "scope.mirror", name: "镜海界海岸邦", detail: "非连续节点 · 外域征募站", type: "多节点" },
      { id: "scope.noon", name: "无昼界第七环带", detail: "环带驻军区 · 跨宇宙补给", type: "单节点" },
    ],
  },
  {
    label: "九州大陆制度",
    items: [
      { id: "scope.dasheng", name: "大晟军籍法", detail: "大晟王朝及其自定义辖区", type: "国家" },
      { id: "scope.chengtian", name: "承天自由城卫队章程", detail: "独立城市 · 不继承王朝军制", type: "独立城" },
    ],
  },
];

const entries = [
  { name: "界团", type: "编制单位", scope: "诸界远征军", status: "已完善" },
  { name: "跨界军籍", type: "身份规则", scope: "3 个宇宙范围", status: "已完善" },
  { name: "雪门营", type: "驻扎节点", scope: "北境军镇辖区", status: "草稿" },
  { name: "驻地协定", type: "制度文书", scope: "不连续节点", status: "待审查" },
];

const fields = [
  { name: "指挥体系", type: "reference[]", value: "诸界联席议会 / 中央枢密院" },
  { name: "活动范围", type: "scope[]", value: "主宇宙 / 镜海界 / 无昼界" },
  { name: "常设界团数", type: "number", value: "12" },
  { name: "军籍状态", type: "enum", value: "跨界契约制" },
];

const relations = [
  { source: "北境军镇辖区", kind: "contained_by", target: "大晟王朝", axis: "空间包含", className: "contains" },
  { source: "承天自由城", kind: "located_on", target: "九州大陆", axis: "空间包含", className: "contains" },
  { source: "承天自由城", kind: "political_role", target: "主权城邦", axis: "政治身份", className: "identity" },
  { source: "诸界远征军", kind: "operates_in", target: "主宇宙 + 镜海界 + 无昼界", axis: "制度作用", className: "scope" },
  { source: "诸界远征军征募制", kind: "extends", target: "大晟军制总则", axis: "制度继承", className: "scope" },
];

const inheritanceLabels = { inherit: "继承自", extend: "扩展自", override: "覆盖", replace: "替换" };
const selectedInstitutionIds = new Set(["scope.primary", "scope.mirror", "scope.noon"]);
const expandedTreeIds = new Set([
  "world.root", "multiverse.all", "universe.primary", "supercluster.kunpeng", "group.cangheng", "galaxy.tianshu", "system.qingyao", "planet.cangheng", "continent.jiuzhou", "polity.dasheng", "custom.north-garrison",
]);

let selectedCategoryId = "military";
let selectedNodeName = "军制编成";
let selectedSpatialId = "custom.north-garrison";
let catalogFilter = "";
let globalFilter = "";
let saveTimer = null;

const byId = (id) => document.getElementById(id);
const refreshIcons = () => window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function showToast(message, icon = "circle-check") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<i data-lucide="${icon}"></i><span>${escapeHtml(message)}</span>`;
  byId("toast-region").appendChild(toast);
  refreshIcons();
  requestAnimationFrame(() => toast.classList.add("visible"));
  window.setTimeout(() => {
    toast.classList.remove("visible");
    window.setTimeout(() => toast.remove(), 180);
  }, 2800);
}

function markDirty() {
  const save = byId("save-state");
  if (!save) return;
  save.classList.add("dirty");
  save.innerHTML = '<i data-lucide="cloud-upload"></i>正在保存草案…';
  refreshIcons();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    save.classList.remove("dirty");
    save.innerHTML = '<i data-lucide="circle-check"></i>全部更改已保存';
    refreshIcons();
  }, 900);
}

function renderCategories() {
  const list = byId("category-list");
  const query = `${catalogFilter} ${globalFilter}`.trim().toLowerCase();
  const filtered = categories
    .map((category) => ({ ...category, nodes: category.nodes.filter((node) => !query || `${category.label} ${node}`.toLowerCase().includes(query)) }))
    .filter((category) => category.nodes.length || (!query && category.id));

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div><i data-lucide="search-x"></i><strong>没有匹配的设定</strong><span>换一个词，或清除搜索条件。</span></div></div>';
    refreshIcons();
    return;
  }

  list.innerHTML = filtered.map((category) => {
    const active = category.id === selectedCategoryId;
    const nodes = active || query ? `<div class="category-nodes">${category.nodes.map((node) => `<button class="category-node ${active && node === selectedNodeName ? "active" : ""}" type="button" data-category="${category.id}" data-node="${escapeHtml(node)}">${escapeHtml(node)}</button>`).join("")}</div>` : "";
    return `<div class="category-group"><button class="category-button ${active ? "active" : ""}" type="button" data-category-toggle="${category.id}" aria-expanded="${active || Boolean(query)}"><span class="category-icon"><i data-lucide="${category.icon}"></i></span><span>${category.label}</span><small>${category.nodes.length}</small></button>${nodes}</div>`;
  }).join("");
  refreshIcons();
}

function findSpatialNode(nodes, id, path = []) {
  for (const node of nodes) {
    const nextPath = [...path, node];
    if (node.id === id) return { node, path: nextPath };
    const found = node.children ? findSpatialNode(node.children, id, nextPath) : null;
    if (found) return found;
  }
  return null;
}

function filterTree(nodes, query) {
  if (!query) return nodes;
  return nodes.reduce((result, node) => {
    const children = node.children ? filterTree(node.children, query) : [];
    if (`${node.name} ${node.kind}`.toLowerCase().includes(query) || children.length) result.push({ ...node, children });
    return result;
  }, []);
}

function treeRows(nodes, depth = 0, forceExpand = false) {
  return nodes.map((node) => {
    const hasChildren = Boolean(node.children?.length);
    const expanded = forceExpand || expandedTreeIds.has(node.id);
    const row = `<button class="tree-row ${selectedSpatialId === node.id ? "active" : ""}" type="button" role="treeitem" aria-selected="${selectedSpatialId === node.id}" aria-expanded="${hasChildren ? expanded : "false"}" data-tree-id="${node.id}" style="--depth:${depth}"><span class="${hasChildren ? "tree-toggle" : "tree-spacer"}" data-tree-toggle="${node.id}">${hasChildren ? `<i data-lucide="${expanded ? "chevron-down" : "chevron-right"}"></i>` : ""}</span><span class="tree-node-icon"><i data-lucide="${node.icon}"></i></span><span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-kind ${node.custom ? "custom" : ""}">${escapeHtml(node.kind)}</span></button>`;
    const children = hasChildren && expanded ? treeRows(node.children, depth + 1, forceExpand) : "";
    return row + children;
  }).join("");
}

function renderSpatialTree() {
  const query = globalFilter.trim().toLowerCase();
  const visibleTree = filterTree(spatialTree, query);
  byId("spatial-tree").innerHTML = visibleTree.length ? treeRows(visibleTree, 0, Boolean(query)) : '<div class="empty-state"><div><i data-lucide="search-x"></i><strong>没有匹配的空间节点</strong><span>空间轴与制度轴会分别搜索。</span></div></div>';
  refreshIcons();
}

function renderInstitutions() {
  const query = globalFilter.trim().toLowerCase();
  const groups = institutionGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => !query || `${group.label} ${item.name} ${item.detail}`.toLowerCase().includes(query)),
  })).filter((group) => group.items.length);

  byId("institution-groups").innerHTML = groups.length ? groups.map((group) => `<section class="institution-group"><div class="institution-group-title"><span>${escapeHtml(group.label)}</span><span>${group.items.length} 项</span></div>${group.items.map((item) => `<label class="institution-option"><input type="checkbox" value="${item.id}" ${selectedInstitutionIds.has(item.id) ? "checked" : ""}/><span class="institution-option-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail)}</span></span><span class="scope-type">${escapeHtml(item.type)}</span></label>`).join("")}</section>`).join("") : '<div class="empty-state"><div><i data-lucide="search-x"></i><strong>没有匹配的制度范围</strong><span>试试宇宙、组织或辖区名称。</span></div></div>';
  refreshIcons();
}

function updateScopeSummary() {
  const found = findSpatialNode(spatialTree, selectedSpatialId);
  if (found) {
    byId("selected-spatial").textContent = found.node.name;
    const parent = found.path.at(-2);
    byId("selected-spatial-path").textContent = found.node.custom ? `${parent?.name || "世界根"}下的自定义层级` : `${found.node.kind} · ${parent?.name || "世界根"}`;
    byId("spatial-count").textContent = "1";
  }
  const selected = institutionGroups.flatMap((group) => group.items).filter((item) => selectedInstitutionIds.has(item.id));
  byId("institution-count").textContent = String(selected.length);
  byId("selected-institution-count").textContent = String(selected.length);
  byId("selected-institution-summary").textContent = selected.length ? selected.map((item) => item.name.replace("全域", "").replace("海岸邦", "").replace("第七环带", "")).join("、") : "尚未选择制度范围";
  renderStrategyProperties();
}

function selectAxis(axis) {
  document.querySelectorAll(".axis-tab").forEach((button) => {
    const active = button.dataset.axis === axis;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  byId("spatial-axis").classList.toggle("hidden", axis !== "spatial");
  byId("institution-axis").classList.toggle("hidden", axis !== "institution");
  byId("axis-context-label").textContent = axis === "spatial" ? "定位世界中的物理或自定义层级" : "选择制度实际覆盖的一个或多个范围";
  byId("add-custom-node").classList.toggle("hidden", axis !== "spatial");
}

function renderEntries() {
  const table = byId("entry-table");
  table.innerHTML = `<div class="table-header" role="row"><span>名称</span><span>类型</span><span>作用域</span><span>状态</span><span></span></div>${entries.map((entry, index) => `<div class="entry-row" role="row"><div class="entry-name"><span class="entry-icon"><i data-lucide="braces"></i></span><span>${escapeHtml(entry.name)}</span></div><span class="cell-muted">${escapeHtml(entry.type)}</span><span class="cell-muted">${escapeHtml(entry.scope)}</span><span class="row-state ${entry.status === "草稿" ? "draft" : ""}">${escapeHtml(entry.status)}</span><button class="icon-button" type="button" data-entry-index="${index}" aria-label="打开${escapeHtml(entry.name)}" title="打开词条"><i data-lucide="chevron-right"></i></button></div>`).join("")}`;
  byId("entry-count").textContent = String(entries.length);
  refreshIcons();
}

function renderStrategyProperties() {
  const mode = byId("inheritance-mode")?.value || "extend";
  const priority = byId("priority-mode")?.value || "high";
  const scopeNames = institutionGroups.flatMap((group) => group.items).filter((item) => selectedInstitutionIds.has(item.id)).map((item) => item.name).join(" / ") || "未选择";
  const found = findSpatialNode(spatialTree, selectedSpatialId);
  const rows = [
    ["spatial_anchor", found?.node.name || "未选择", "独立空间轴"],
    ["authority_scope", scopeNames, "允许多个范围"],
    ["merge_strategy", inheritanceLabels[mode], "继承策略"],
    ["conflict_priority", priority, "冲突排序"],
    ["valid_time", "景曜 300 年 — 至今", "时间切片"],
  ];
  const target = byId("strategy-properties");
  if (target) target.innerHTML = rows.map(([key, value, hint]) => `<div class="property-row"><dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd><dd>${escapeHtml(hint)}</dd></div>`).join("");
}

function renderFields() {
  byId("field-table").innerHTML = fields.map((field, index) => `<div class="field-row"><strong>${escapeHtml(field.name)}</strong><span class="field-type">${escapeHtml(field.type)}</span><input class="field-value" value="${escapeHtml(field.value)}" data-field-index="${index}" aria-label="${escapeHtml(field.name)}字段值"/><button class="icon-button" type="button" data-remove-field="${index}" aria-label="移除${escapeHtml(field.name)}" title="移除字段"><i data-lucide="trash-2"></i></button></div>`).join("");
  refreshIcons();
}

function renderRelations() {
  byId("relation-table").innerHTML = `<div class="table-header"><span>来源</span><span>关系</span><span>目标</span><span>关系轴</span><span></span></div>${relations.map((relation, index) => `<div class="relation-row"><strong>${escapeHtml(relation.source)}</strong><span class="relation-kind ${relation.className}">${escapeHtml(relation.kind)}</span><span class="cell-muted" title="${escapeHtml(relation.target)}">${escapeHtml(relation.target)}</span><span class="cell-muted">${escapeHtml(relation.axis)}</span><button class="icon-button" type="button" data-relation-index="${index}" aria-label="查看关系" title="查看关系"><i data-lucide="chevron-right"></i></button></div>`).join("")}`;
  refreshIcons();
}

function setActiveView(view) {
  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  if (view === "structure") renderStrategyProperties();
}

function closeDrawers() {
  document.querySelectorAll(".drawer.open").forEach((drawer) => drawer.classList.remove("open"));
  byId("drawer-scrim").classList.remove("open");
}

function openDrawer(id, axis) {
  closeDrawers();
  if (axis) selectAxis(axis);
  byId(id).classList.add("open");
  byId("drawer-scrim").classList.add("open");
}

function htmlToMarkdown() {
  if (window.TurndownService) {
    const turndown = new window.TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
    byId("source-editor").value = turndown.turndown(byId("visual-editor").innerHTML);
  } else {
    byId("source-editor").value = byId("visual-editor").innerText;
  }
}

function markdownToHtml() {
  const source = byId("source-editor").value;
  if (window.marked && window.DOMPurify) {
    byId("visual-editor").innerHTML = window.DOMPurify.sanitize(window.marked.parse(source));
  } else {
    byId("visual-editor").textContent = source;
  }
}

function setEditorMode(mode) {
  document.querySelectorAll("[data-editor-mode]").forEach((button) => button.classList.toggle("active", button.dataset.editorMode === mode));
  if (mode === "source") {
    htmlToMarkdown();
    byId("visual-editor").classList.add("hidden");
    byId("source-editor").classList.remove("hidden");
    byId("source-editor").focus();
  } else {
    if (!byId("source-editor").classList.contains("hidden")) markdownToHtml();
    byId("source-editor").classList.add("hidden");
    byId("visual-editor").classList.remove("hidden");
    byId("visual-editor").focus();
  }
}

function updateDocumentHeading(category, node) {
  document.querySelector(".library-title-wrap h1").innerHTML = `${escapeHtml(category.label)} <span class="title-slash">/</span> ${escapeHtml(node)}`;
  const kicker = document.querySelector(".document-kicker");
  kicker.innerHTML = `<span>${escapeHtml(category.label)}</span><i data-lucide="chevron-right"></i><span>${escapeHtml(node)}</span>`;
  if (category.id !== "military" || node !== "军制编成") {
    byId("visual-editor").innerHTML = `<h1>${escapeHtml(node)}</h1><p class="lead">正在为“${escapeHtml(byId("selected-spatial").textContent)}”整理${escapeHtml(category.label)}。本页面同时绑定独立的空间锚点与制度作用域。</p><aside class="document-note"><strong>当前实例</strong><span>制度范围保持为已选择的跨宇宙范围，切换设定类目不会改变两条作用域轴。</span></aside><h2>核心规则</h2><p>在这里编辑规则、例外、历史沿革与叙事影响。结构化事实请在“词条”“结构”和“关系”视图中维护。</p><h2>待补充</h2><ul><li>规则的适用边界</li><li>与上层设定的继承关系</li><li>冲突时的优先级说明</li></ul>`;
  }
  refreshIcons();
  markDirty();
}

document.addEventListener("DOMContentLoaded", () => {
  renderCategories();
  renderSpatialTree();
  renderInstitutions();
  renderEntries();
  renderFields();
  renderRelations();
  updateScopeSummary();
  refreshIcons();

  byId("category-list").addEventListener("click", (event) => {
    const nodeButton = event.target.closest("[data-node]");
    const categoryButton = event.target.closest("[data-category-toggle]");
    if (nodeButton) {
      selectedCategoryId = nodeButton.dataset.category;
      selectedNodeName = nodeButton.dataset.node;
      const category = categories.find((item) => item.id === selectedCategoryId);
      renderCategories();
      updateDocumentHeading(category, selectedNodeName);
      closeDrawers();
      return;
    }
    if (categoryButton) {
      selectedCategoryId = categoryButton.dataset.categoryToggle;
      selectedNodeName = categories.find((item) => item.id === selectedCategoryId).nodes[0];
      renderCategories();
    }
  });

  byId("catalog-query").addEventListener("input", (event) => {
    catalogFilter = event.target.value;
    renderCategories();
  });

  byId("global-query").addEventListener("input", (event) => {
    globalFilter = event.target.value;
    renderCategories();
    renderSpatialTree();
    renderInstitutions();
  });

  byId("spatial-tree").addEventListener("click", (event) => {
    const row = event.target.closest("[data-tree-id]");
    if (!row) return;
    const id = row.dataset.treeId;
    if (event.target.closest("[data-tree-toggle]")) {
      expandedTreeIds.has(id) ? expandedTreeIds.delete(id) : expandedTreeIds.add(id);
    } else {
      selectedSpatialId = id;
      updateScopeSummary();
      markDirty();
    }
    renderSpatialTree();
  });

  byId("institution-groups").addEventListener("change", (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    event.target.checked ? selectedInstitutionIds.add(event.target.value) : selectedInstitutionIds.delete(event.target.value);
    updateScopeSummary();
    markDirty();
  });

  document.querySelectorAll(".axis-tab").forEach((tab) => tab.addEventListener("click", () => selectAxis(tab.dataset.axis)));
  document.querySelectorAll("[data-open-axis]").forEach((button) => button.addEventListener("click", () => openDrawer("scope-panel", button.dataset.openAxis)));

  byId("collapse-tree").addEventListener("click", () => {
    expandedTreeIds.clear();
    expandedTreeIds.add("world.root");
    renderSpatialTree();
    showToast("已折叠到世界根层级", "fold-vertical");
  });

  byId("add-custom-node").addEventListener("click", () => {
    const found = findSpatialNode(spatialTree, selectedSpatialId);
    if (!found) return;
    const next = window.prompt(`在“${found.node.name}”下新建自定义层级`, "未命名自定义辖区");
    if (!next?.trim()) return;
    found.node.children = found.node.children || [];
    const id = `custom.${Date.now()}`;
    found.node.children.push({ id, name: next.trim(), kind: "自定义层级", icon: "brackets", custom: true });
    expandedTreeIds.add(found.node.id);
    selectedSpatialId = id;
    renderSpatialTree();
    updateScopeSummary();
    showToast(`已在“${found.node.name}”下新增自定义层级`, "brackets");
    markDirty();
  });

  document.querySelectorAll(".view-tab").forEach((tab) => tab.addEventListener("click", () => setActiveView(tab.dataset.view)));

  document.querySelectorAll("[data-command]").forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    byId("visual-editor").focus();
    document.execCommand(button.dataset.command, false, button.dataset.value || null);
    markDirty();
  }));

  document.querySelectorAll("[data-editor-mode]").forEach((button) => button.addEventListener("click", () => setEditorMode(button.dataset.editorMode)));
  byId("visual-editor").addEventListener("input", markDirty);
  byId("source-editor").addEventListener("input", markDirty);

  byId("inheritance-mode").addEventListener("change", (event) => {
    const label = inheritanceLabels[event.target.value];
    byId("inheritance-status").textContent = `${label}：大晟军制总则`;
    renderStrategyProperties();
    markDirty();
    showToast(`合并方式已切换为“${label}”`, "git-merge");
  });

  byId("priority-mode").addEventListener("change", (event) => {
    const labels = { locked: "锁定", high: "高", normal: "普通", low: "低" };
    byId("conflict-message").textContent = event.target.value === "low" ? "当前草案优先级低于镜海界上位法，发布时将遵循上位规则。" : "“诸界远征军征募制”与镜海界《禁止外域征召令》在同一时间切片重叠。";
    renderStrategyProperties();
    markDirty();
    showToast(`冲突优先级已设为“${labels[event.target.value]}”`, "list-ordered");
  });

  byId("add-entry").addEventListener("click", () => {
    entries.push({ name: `未命名词条 ${entries.length + 1}`, type: "自定义词条", scope: byId("selected-spatial").textContent, status: "草稿" });
    renderEntries();
    showToast("已新建词条草稿", "braces");
    markDirty();
  });

  byId("entry-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry-index]");
    if (button) showToast(`已打开词条“${entries[Number(button.dataset.entryIndex)].name}”`, "braces");
  });

  byId("add-field").addEventListener("click", () => {
    fields.push({ name: `自定义字段 ${fields.length + 1}`, type: "text", value: "待填写" });
    renderFields();
    markDirty();
  });

  byId("field-table").addEventListener("input", (event) => {
    if (!event.target.matches("[data-field-index]")) return;
    fields[Number(event.target.dataset.fieldIndex)].value = event.target.value;
    markDirty();
  });

  byId("field-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-field]");
    if (!button) return;
    fields.splice(Number(button.dataset.removeField), 1);
    renderFields();
    markDirty();
  });

  byId("add-relation").addEventListener("click", () => {
    relations.push({ source: byId("selected-spatial").textContent, kind: "operates_in", target: "诸界远征军", axis: "制度作用", className: "scope" });
    renderRelations();
    showToast("已新建跨轴关系草稿", "git-branch");
    markDirty();
  });

  byId("relation-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-relation-index]");
    if (button) showToast(`关系：${relations[Number(button.dataset.relationIndex)].kind}`, "git-branch");
  });

  const conflictDialog = byId("conflict-dialog");
  byId("review-conflicts").addEventListener("click", () => conflictDialog.showModal());
  byId("conflict-banner").addEventListener("click", (event) => {
    if (window.innerWidth <= 720 && !event.target.closest("#dismiss-conflict")) conflictDialog.showModal();
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => conflictDialog.close()));
  byId("resolve-conflict").addEventListener("click", () => {
    const choice = byId("resolution-choice");
    byId("conflict-banner").classList.add("hidden");
    conflictDialog.close();
    showToast(`冲突处理已应用：${choice.options[choice.selectedIndex].text}`, "badge-check");
    markDirty();
  });
  byId("dismiss-conflict").addEventListener("click", () => byId("conflict-banner").classList.add("hidden"));

  byId("open-catalog").addEventListener("click", () => openDrawer("catalog-panel"));
  byId("open-scope").addEventListener("click", () => openDrawer("scope-panel", "spatial"));
  document.querySelectorAll(".close-drawer").forEach((button) => button.addEventListener("click", closeDrawers));
  byId("drawer-scrim").addEventListener("click", closeDrawers);

  byId("map-destination").addEventListener("click", () => showToast("世界地图是独立模块，本设定库仅保留导航引用。", "map"));
  byId("rail-toggle").addEventListener("click", () => showToast("小说工作台菜单保持默认收起", "panel-left"));
  byId("project-switcher").addEventListener("click", () => showToast("当前项目：烬海编年史", "book-open"));
  byId("new-setting").addEventListener("click", () => showToast("已创建空白设定页面，可从任意类目开始", "file-plus-2"));
  byId("mobile-search").addEventListener("click", () => {
    openDrawer("catalog-panel");
    byId("catalog-query").focus();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (window.innerWidth <= 720) {
        openDrawer("catalog-panel");
        byId("catalog-query").focus();
      } else byId("global-query").focus();
    }
    if (event.key === "Escape") closeDrawers();
  });
});
