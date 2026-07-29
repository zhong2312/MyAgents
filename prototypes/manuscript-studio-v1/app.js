const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const body = document.body;
const toast = $("#toast");
let toastTimer = null;

function showToast(message, tone = "success") {
  const iconUse = $("use", toast);
  iconUse.setAttribute("href", tone === "error" ? "#i-alert" : "#i-check");
  $("span", toast).textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function openOverlay(id) {
  const overlay = $(id);
  if (!overlay) return;
  overlay.hidden = false;
  const focusTarget = $("button, input, select", overlay);
  setTimeout(() => focusTarget?.focus(), 30);
}

function closeOverlay(overlay) {
  if (
    overlay.id === "typographyOverlay" &&
    overlay.dataset.confirmed !== "true"
  )
    restoreAppliedTypography();
  overlay.hidden = true;
}

$$(".overlay").forEach((overlay) => {
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay && overlay.id !== "deleteOverlay")
      closeOverlay(overlay);
  });
  $$(".overlay-close", overlay).forEach((button) =>
    button.addEventListener("click", () => closeOverlay(overlay)),
  );
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = $$(".overlay")
    .reverse()
    .find((overlay) => !overlay.hidden);
  if (open && open.id !== "deleteOverlay") closeOverlay(open);
});

const modeCopy = {
  free: ["#i-link", "正文目录自由维护；目录和章节可以按需关联剧情工程。"],
  merged: ["#i-link", "剧情结构与正文合并显示，计划仍由剧情工程拥有。"],
  locked: [
    "#i-lock",
    "严格锁定：目录由剧情工程自动同步，请前往剧情工程修改结构。",
  ],
};

$$(".structure-mode button").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".structure-mode button").forEach((candidate) =>
      candidate.classList.toggle("is-active", candidate === button),
    );
    const mode = button.dataset.mode;
    body.dataset.structureMode = mode;
    const [icon, copy] = modeCopy[mode];
    $("use", $("#modeNotice")).setAttribute("href", icon);
    $("span", $("#modeNotice")).textContent = copy;
    showToast(
      mode === "locked"
        ? "已进入严格锁定模式，正文仍可编辑"
        : `已切换到${button.textContent.trim()}模式`,
    );
  });
});

$("#addFolder").addEventListener("click", () =>
  showToast("原型：将打开“新建多级目录”表单"),
);
$("#addChapter").addEventListener("click", () =>
  showToast("原型：将创建稳定 ID 的新章节"),
);
$("#trashOpen").addEventListener("click", () =>
  showToast("回收站中有 1 章，可恢复正文与历史修订"),
);

$("#treeSearch").addEventListener("input", (event) => {
  const query = event.target.value.trim().toLocaleLowerCase("zh-CN");
  $$(".tree-row[data-search]").forEach((row) =>
    row.classList.toggle(
      "is-search-hidden",
      Boolean(query) &&
        !row.dataset.search.toLocaleLowerCase("zh-CN").includes(query),
    ),
  );
});

let selectedChapterRow = $(".chapter-row.is-selected");
const chapterNumberInput = $("#chapterNumberInput");

function chapterScopeLabel(row) {
  return row.dataset.sequence === "free" ? "自由正文" : "剧情工程";
}

function formatChapterNumber(row, number) {
  return row.dataset.sequence === "free"
    ? `自由正文第 ${number} 篇`
    : `第 ${number} 章`;
}

function renderSelectedChapter(row) {
  const number = Number(row.dataset.displayNumber);
  const title =
    row.dataset.title ??
    $(".row-main strong", row)?.textContent ??
    "未命名章节";
  const prefix = formatChapterNumber(row, number);
  $("#chapterCrumb").textContent = `${prefix} · ${title}`;
  $("#chapterScopeBadge").textContent = chapterScopeLabel(row);
  chapterNumberInput.value = String(number);
  $(".chapter-title-block h1").textContent = title;
  $(".chapter-kicker span:last-child").textContent =
    row.dataset.sequence === "free"
      ? `FREE ${String(number).padStart(2, "0")}`
      : `CHAPTER ${number}`;
}

function applyDisplayNumber() {
  if (!selectedChapterRow) return;
  const number = Number(chapterNumberInput.value);
  if (!Number.isInteger(number) || number < 1) {
    chapterNumberInput.value = selectedChapterRow.dataset.displayNumber;
    showToast("章节编号必须是正整数", "error");
    return;
  }
  const duplicate = $$(".chapter-row").find(
    (row) =>
      row !== selectedChapterRow &&
      row.dataset.sequence === selectedChapterRow.dataset.sequence &&
      Number(row.dataset.displayNumber) === number,
  );
  if (duplicate) {
    chapterNumberInput.value = selectedChapterRow.dataset.displayNumber;
    showToast(
      `该${chapterScopeLabel(selectedChapterRow)}序列已使用编号 ${number}`,
      "error",
    );
    return;
  }
  selectedChapterRow.dataset.displayNumber = String(number);
  $(".chapter-no", selectedChapterRow).textContent = String(number).padStart(
    2,
    "0",
  );
  renderSelectedChapter(selectedChapterRow);
  showToast(
    `${chapterScopeLabel(selectedChapterRow)}显示编号已改为 ${formatChapterNumber(selectedChapterRow, number)}；内部文件 ID 不变`,
  );
}

$$(".chapter-row").forEach((row) => {
  row.addEventListener("click", () => {
    if (
      body.dataset.structureMode === "locked" &&
      row.dataset.chapter === "43"
    ) {
      showToast("第 43 章来自剧情计划，正文尚未创建");
      return;
    }
    $$(".chapter-row").forEach((candidate) =>
      candidate.classList.remove("is-selected"),
    );
    row.classList.add("is-selected");
    selectedChapterRow = row;
    renderSelectedChapter(row);
    if (row.dataset.chapter !== "42")
      showToast(
        `原型：已选择“${$(".row-main strong", row)?.textContent ?? "章节"}”`,
      );
  });
});

chapterNumberInput.addEventListener("blur", applyDisplayNumber);
chapterNumberInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.currentTarget.blur();
  if (event.key === "Escape" && selectedChapterRow) {
    event.currentTarget.value = selectedChapterRow.dataset.displayNumber;
    event.currentTarget.blur();
  }
});

$$(".tree-caret").forEach((caret) =>
  caret.addEventListener("click", (event) => {
    event.stopPropagation();
    caret.classList.toggle("is-open");
  }),
);

$$(".mobile-pane-switch button").forEach((button) =>
  button.addEventListener("click", () => {
    $$(".mobile-pane-switch button").forEach((candidate) =>
      candidate.classList.toggle("is-active", candidate === button),
    );
    body.dataset.mobilePane = button.dataset.pane;
  }),
);

$$(".context-tabs button").forEach((button) =>
  button.addEventListener("click", () => {
    $$(".context-tabs button").forEach((candidate) =>
      candidate.classList.toggle("is-active", candidate === button),
    );
    $$(".context-panel").forEach((panel) =>
      panel.classList.toggle(
        "is-active",
        panel.dataset.panel === button.dataset.contextTab,
      ),
    );
  }),
);

$("#collapseContext").addEventListener("click", () => {
  body.classList.toggle("context-collapsed");
  showToast(
    body.classList.contains("context-collapsed")
      ? "上下文栏已收起"
      : "上下文栏已展开",
  );
});

$("#continuousToggle").addEventListener("click", () => {
  const continuous = $("#continuousManuscript");
  const single = $("#singleManuscript");
  const next = continuous.hidden;
  continuous.hidden = !next;
  single.hidden = next;
  $("#continuousToggle").classList.toggle("is-active", next);
  $("#continuousToggle span").textContent = next ? "返回编辑" : "连续稿";
});

$("#chapterEditor").addEventListener("input", () => {
  $("#saveState").innerHTML = "有未保存修改";
  clearTimeout(window.__saveTimer);
  window.__saveTimer = setTimeout(() => {
    $("#saveState").innerHTML = '<svg><use href="#i-check"></use></svg>已保存';
  }, 900);
});

const selectionToolbar = $("#selectionToolbar");
function updateSelectionToolbar() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    selectionToolbar.hidden = true;
    return;
  }
  const anchor = selection.anchorNode?.parentElement;
  if (!anchor?.closest(".prose")) {
    selectionToolbar.hidden = true;
    return;
  }
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  selectionToolbar.hidden = false;
  selectionToolbar.style.left = `${Math.min(window.innerWidth - 170, Math.max(170, rect.left + rect.width / 2))}px`;
  selectionToolbar.style.top = `${Math.max(58, rect.top)}px`;
}
$$(".prose").forEach((editor) =>
  editor.addEventListener("mouseup", () =>
    setTimeout(updateSelectionToolbar, 0),
  ),
);
document.addEventListener("mousedown", (event) => {
  if (
    !event.target.closest(".selection-toolbar") &&
    !event.target.closest(".prose")
  )
    selectionToolbar.hidden = true;
});

const candidateCopy = {
  polish: {
    label: "选区润色 · 文气收束",
    reason:
      "压缩说明句，增强动作与异象之间的因果感；不改变人物、物品和规则事实。",
    before:
      "林砚五指一松，青木真炁落入炉心。刹那间，赤焰没有暴涨，反而齐齐伏低，像万千枝草向同一个方向俯首。丹胚表面的裂纹开始倒着愈合，一道、两道、三道——直到最深处浮出第二道银白剑痕。",
    after:
      "林砚松开五指。\n\n青木真炁坠入炉心，赤焰没有暴涨，反而齐齐伏低。万火俯首处，丹胚上的裂纹开始逆着火光愈合：一道，两道，三道。\n\n最后一道裂纹合拢时，最深处亮起了第二道银白剑痕。",
  },
  continue: {
    label: "续写候选 · 巡火司破门",
    reason: "完成计划中的第三节拍，并把章尾停在第二道剑痕主动回应的位置。",
    before: "门外传来铁靴踏过积水的声音。巡火司到了。",
    after:
      "门外传来铁靴踏过积水的声音。\n\n第一声撞门落下时，丹炉里的第二道剑痕忽然转了半寸。它没有指向巡火司，也没有指向林砚。\n\n它指向了城北——那座已经封闭三百年的问剑台。",
  },
  expand: {
    label: "场景扩写 · 规则反噬",
    reason: "增加听觉、热感和动作反馈，使奇则碰撞从解释变为可感知事件。",
    before: "火越收，丹胚吞得越凶；灵气越静，炉中回响越像活物的心跳。",
    after:
      "林砚收去一成离火，炉腹便猛地向内一瘪，仿佛有人在里面吞咽。再收一成，四壁铜纹同时黯下，屋中静得只剩一声沉重回响。\n\n咚。\n\n不是炉响。像是一颗心，隔着赤铜炉壁醒了过来。",
  },
  rewrite: {
    label: "选区重写 · 动作优先",
    reason: "以人物行动代替解释，保留第二道剑痕出现这一事实。",
    before: "它在等一个能够同时容下两条相反规则的人。",
    after:
      "两道剑痕同时亮起。林砚胸口一闷，竟听见自己的心跳与炉中回响落在了同一拍上。",
  },
  repair: {
    label: "质量修复候选 · 前态与声线",
    reason: "补足离火规则失败的正文证据，并把陆青禾对白收束为人物惯用短句。",
    before:
      "按照《离火丹经》，此刻应当收火、封窍、静候九息。\n\n“再等下去，巡火司就到了。”",
    after:
      "林砚先收了一线火。丹胚没有安静，反倒吞掉了炉壁上的第一枚锁火纹。\n\n陆青禾贴着门缝看了一眼：“巡火司到了。最多九息。”",
  },
  brainstorm: {
    label: "脑暴正文稿 · 反向成丹",
    reason:
      "来自“规则破壁者”的完整场景方案；剧情偏离为中等，接受前建议同步剧情工程。",
    before: "它在等一个能够同时容下两条相反规则的人。",
    after:
      "丹胚裂开了。\n\n没有药香，也没有霞光。只有两道剑痕一前一后穿过炉火，最后停在林砚胸前。\n\n枯灯老人沉默了很久。\n\n“小子，”他说，“炉里炼的不是丹。”",
  },
};

function openCandidate(kind = "polish") {
  const copy = candidateCopy[kind] ?? candidateCopy.polish;
  $("#reviewLabel").textContent = copy.label;
  $("#reviewReason").textContent = copy.reason;
  $("#beforeText").innerHTML =
    `<mark>${copy.before.replaceAll("\n", "<br>")}</mark>`;
  $("#afterText").innerHTML =
    `<mark>${copy.after.replaceAll("\n", "<br>")}</mark>`;
  selectionToolbar.hidden = true;
  openOverlay("#candidateOverlay");
}

$$("[data-selection-action]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.selectionAction === "foreshadow") {
      showToast("已创建“伏笔证据”候选，等待同步确认");
      selectionToolbar.hidden = true;
      return;
    }
    openCandidate(button.dataset.selectionAction);
  }),
);
$$("[data-ai-action]").forEach((button) =>
  button.addEventListener("click", () =>
    openCandidate(button.dataset.aiAction),
  ),
);
$("#generateChapter").addEventListener("click", () =>
  openCandidate("continue"),
);

$("#acceptCandidate").addEventListener("click", () => {
  closeOverlay($("#candidateOverlay"));
  $(".chapter-crumb .status-chip.is-warning").textContent = "同步已过期";
  showToast("候选已接受并创建修订 r13");
});
$("#acceptPartial").addEventListener("click", () =>
  showToast("原型：已进入逐段选择模式"),
);

$$("[data-highlight]").forEach((button) =>
  button.addEventListener("click", () => {
    const target = $(`[data-quality="${button.dataset.highlight}"]`);
    target?.classList.remove("is-highlighted");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => target?.classList.add("is-highlighted"), 180);
    if (window.innerWidth <= 860) {
      body.dataset.mobilePane = "editor";
      $$(".mobile-pane-switch button").forEach((item) =>
        item.classList.toggle("is-active", item.dataset.pane === "editor"),
      );
    }
  }),
);

$("#brainstormOpen").addEventListener("click", () =>
  openOverlay("#brainstormOverlay"),
);
function readBrainstormConfig() {
  const enabledRows = $$(".agent-row").filter(
    (row) => $(".agent-enabled", row)?.checked,
  );
  const totalCandidates = enabledRows.reduce(
    (total, row) => total + Number($(".agent-count", row)?.value || 0),
    0,
  );
  const models = new Set(
    enabledRows.map((row) => $(".agent-model", row)?.value).filter(Boolean),
  );
  return { enabledRows, totalCandidates, modelCount: models.size };
}

function updateBrainstormConfigSummary() {
  const { enabledRows, totalCandidates, modelCount } = readBrainstormConfig();
  $("#agentSummary").textContent =
    `启用 ${enabledRows.length} / 6 · ${modelCount} 个模型`;
  $("#brainstormStart").disabled = enabledRows.length === 0;
  $("#brainstormStart").innerHTML =
    `<svg><use href="#i-spark"></use></svg>开始脑暴 · 预计 ${totalCandidates} 个方案`;
}

$$(".agent-enabled, .agent-count").forEach((control) =>
  control.addEventListener("change", updateBrainstormConfigSummary),
);
$$(".agent-model").forEach((select) =>
  select.addEventListener("change", () => {
    const row = select.closest(".agent-row");
    const model =
      select.options[select.selectedIndex]?.textContent ?? select.value;
    showToast(`${row?.dataset.agentName ?? "Agent"} 已切换为 ${model}`);
    updateBrainstormConfigSummary();
  }),
);

$("#brainstormStart").addEventListener("click", () => {
  const { enabledRows, totalCandidates, modelCount } = readBrainstormConfig();
  const grid = $("#candidateGrid");
  grid.classList.add("is-running");
  $("#brainstormStart").disabled = true;
  $("#brainstormStart").textContent =
    `${enabledRows.length} 个 Agent 正在并行构思…`;
  $("#resultCount").textContent =
    `运行中 · ${modelCount} 个模型 · 已冻结正文修订 r12`;
  setTimeout(() => {
    grid.classList.remove("is-running");
    $("#brainstormStart").disabled = false;
    $("#brainstormStart").innerHTML =
      `<svg><use href="#i-check"></use></svg>脑暴完成 · 共 ${totalCandidates} 个方案`;
    $("#resultCount").textContent =
      `${totalCandidates} 个方案 · ${modelCount} 个模型 · 0 个失败`;
    showToast("多 Agent 脑暴完成，已按差异聚类");
  }, 1100);
});
updateBrainstormConfigSummary();

$("#simulationOpen").addEventListener("click", () =>
  openOverlay("#simulationOverlay"),
);
function readSimulationConfig() {
  const enabledRows = $$(".simulation-agent-row").filter(
    (row) => $(".simulation-agent-enabled", row)?.checked,
  );
  const totalPaths = enabledRows.reduce(
    (total, row) =>
      total + Number($(".simulation-agent-count", row)?.value || 0),
    0,
  );
  const models = new Set(
    enabledRows
      .map((row) => $(".simulation-agent-model", row)?.value)
      .filter(Boolean),
  );
  return { enabledRows, totalPaths, modelCount: models.size };
}

function updateSimulationSummary() {
  const { enabledRows, totalPaths, modelCount } = readSimulationConfig();
  $("#simulationAgentSummary").textContent =
    `启用 ${enabledRows.length} / 6 · ${modelCount} 个模型`;
  $("#simulationStart").disabled = enabledRows.length === 0;
  $("#simulationStart").innerHTML =
    `<svg><use href="#i-route"></use></svg>开始推演 · 预计 ${totalPaths} 条路径`;
}

$$(".simulation-agent-enabled, .simulation-agent-count").forEach((control) =>
  control.addEventListener("change", updateSimulationSummary),
);
$$(".simulation-agent-model").forEach((select) =>
  select.addEventListener("change", () => {
    const row = select.closest(".simulation-agent-row");
    const model =
      select.options[select.selectedIndex]?.textContent ?? select.value;
    showToast(`${row?.dataset.agentName ?? "Agent"} 已切换为 ${model}`);
    updateSimulationSummary();
  }),
);

function updateSimulationBoundary() {
  const starts = {
    "42-end": { chapter: 42, label: "第 42 章 · 丹成大道" },
    "43-plan": { chapter: 43, label: "第 43 章 · 灰烬（计划）" },
    "unit-end": { chapter: 47, label: "丹炉城单元末 · 第 47 章" },
  };
  const start = starts[$("#simulationStartPoint").value];
  const horizon = Number($("#simulationHorizon").value);
  $("#simulationOriginLabel").textContent = start.label;
  $("#simulationEndLabel").textContent = `第 ${start.chapter + horizon} 章`;
  $("#simulationResultCount").textContent =
    `示例 4 条 · 覆盖未来 ${horizon} 章`;
}
$("#simulationStartPoint").addEventListener("change", updateSimulationBoundary);
$("#simulationHorizon").addEventListener("change", updateSimulationBoundary);

$$("[data-simulation-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    const filter = button.dataset.simulationFilter;
    $$("[data-simulation-filter]").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
    $$(".simulation-path").forEach((path) => {
      path.hidden = filter !== "all" && path.dataset.kind !== filter;
    });
  }),
);

$$("[data-simulation-expand]").forEach((button) =>
  button.addEventListener("click", () => {
    const detail = $(
      ".simulation-path-detail",
      button.closest(".simulation-path"),
    );
    detail.hidden = !detail.hidden;
    button.textContent = detail.hidden ? "展开节点" : "收起节点";
  }),
);

$$("[data-simulation-adopt]").forEach((button) =>
  button.addEventListener("click", () => {
    const title = $(
      ".path-identity strong",
      button.closest(".simulation-path"),
    )?.textContent;
    showToast(`“${title}”已创建为剧情工程候选分支`);
  }),
);

$("#simulationStart").addEventListener("click", () => {
  const { enabledRows, totalPaths, modelCount } = readSimulationConfig();
  const horizon = Number($("#simulationHorizon").value);
  const list = $("#simulationPathList");
  list.classList.add("is-running");
  $("#simulationStart").disabled = true;
  $("#simulationStart").textContent =
    `${enabledRows.length} 个 Agent 正在独立推演…`;
  $("#simulationResultCount").textContent =
    `运行中 · ${modelCount} 个模型 · 未来 ${horizon} 章`;
  $$(".path-run-state").forEach((state) => {
    state.textContent = "演算中";
  });
  setTimeout(() => {
    list.classList.remove("is-running");
    $("#simulationStart").disabled = false;
    $("#simulationStart").innerHTML =
      `<svg><use href="#i-check"></use></svg>推演完成 · 共 ${totalPaths} 条路径`;
    $("#simulationResultCount").textContent =
      `${totalPaths} 条路径 · ${modelCount} 个模型 · 0 个冲突中止`;
    $$(".path-run-state").forEach((state) => {
      state.textContent = "已完成";
    });
    showToast("剧情推演完成，候选路径已按风险与差异归组");
  }, 1200);
});
updateSimulationSummary();

$("#deleteChapter").addEventListener("click", () => {
  if (body.dataset.structureMode === "locked") {
    showToast("严格锁定下请从剧情工程处理章节结构", "error");
    return;
  }
  openOverlay("#deleteOverlay");
});
$("#deleteConfirmCheck").addEventListener("change", (event) => {
  $("#confirmDelete").disabled = !event.target.checked;
});
$("#confirmDelete").addEventListener("click", () => {
  closeOverlay($("#deleteOverlay"));
  showToast("第 42 章已移入回收站，8 项状态已回退");
});

$("#contextManifestOpen").addEventListener("click", () =>
  openOverlay("#manifestOverlay"),
);
$("#applySync").addEventListener("click", () => {
  $("#applySync").innerHTML =
    '<svg><use href="#i-check"></use></svg>已同步 4 项';
  $("#applySync").disabled = true;
  $(".chapter-crumb .status-chip.is-warning").className =
    "status-chip is-success";
  $(".chapter-crumb .status-chip.is-success").textContent = "连续性已同步";
  showToast("同步批次 sync-042-r12 已提交");
});

$("#openNarrative").addEventListener("click", () =>
  showToast("原型：将跳转剧情工程并定位第 42 章计划"),
);
$("#openContinuity").addEventListener("click", () =>
  showToast("原型：将打开连续性中心的事件账本"),
);

$$(".filter-pill").forEach((button) =>
  button.addEventListener("click", () => {
    $$(".filter-pill").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
  }),
);

const typographyDefaults = {
  font: "source-serif",
  fontSize: 16,
  titleSize: 29,
  lineHeight: 2,
  paragraphGap: 1,
  width: 760,
  indent: true,
  align: "left",
  paper: "warm",
};
const typographyPresets = {
  writing: { ...typographyDefaults },
  proof: {
    font: "source-sans",
    fontSize: 15,
    titleSize: 26,
    lineHeight: 1.7,
    paragraphGap: 0.5,
    width: 840,
    indent: false,
    align: "left",
    paper: "white",
  },
  book: {
    font: "lxgw",
    fontSize: 17,
    titleSize: 31,
    lineHeight: 1.85,
    paragraphGap: 0.7,
    width: 680,
    indent: true,
    align: "justify",
    paper: "warm",
  },
};
const typographyFontStacks = {
  "source-serif":
    '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  lxgw: '"LXGW WenKai", KaiTi, STKaiti, serif',
  song: 'SimSun, "Songti SC", serif',
  "source-sans":
    '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  system: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};
const typographyPaperTones = {
  warm: "#fffcf7",
  white: "#ffffff",
  gray: "#f2f3f1",
};
let appliedTypography = { ...typographyDefaults };
let typographyVersion = 3;

function matchingTypographyPreset(state) {
  return (
    Object.entries(typographyPresets).find(([, preset]) =>
      Object.keys(typographyDefaults).every(
        (key) => preset[key] === state[key],
      ),
    )?.[0] ?? null
  );
}

function writeTypographyControls(state) {
  $("#typographyFont").value = state.font;
  $("#typographyFontSize").value = state.fontSize;
  $("#typographyTitleSize").value = state.titleSize;
  $("#typographyLineHeight").value = state.lineHeight;
  $("#typographyParagraphGap").value = state.paragraphGap;
  $("#typographyWidth").value = state.width;
  $("#typographyIndent").checked = state.indent;
  $$("[data-typography-align]").forEach((button) =>
    button.classList.toggle(
      "is-active",
      button.dataset.typographyAlign === state.align,
    ),
  );
  $$("[data-paper-tone]").forEach((button) =>
    button.classList.toggle(
      "is-active",
      button.dataset.paperTone === state.paper,
    ),
  );
}

function readTypographyControls() {
  return {
    font: $("#typographyFont").value,
    fontSize: Number($("#typographyFontSize").value),
    titleSize: Number($("#typographyTitleSize").value),
    lineHeight: Number($("#typographyLineHeight").value),
    paragraphGap: Number($("#typographyParagraphGap").value),
    width: Number($("#typographyWidth").value),
    indent: $("#typographyIndent").checked,
    align:
      $("[data-typography-align].is-active")?.dataset.typographyAlign ?? "left",
    paper: $("[data-paper-tone].is-active")?.dataset.paperTone ?? "warm",
  };
}

function renderTypography(state, dirty = true) {
  body.style.setProperty("--manuscript-font", typographyFontStacks[state.font]);
  body.style.setProperty("--manuscript-font-size", `${state.fontSize}px`);
  body.style.setProperty("--manuscript-title-size", `${state.titleSize}px`);
  body.style.setProperty("--manuscript-line-height", state.lineHeight);
  body.style.setProperty(
    "--manuscript-paragraph-gap",
    `${state.paragraphGap}em`,
  );
  body.style.setProperty("--manuscript-indent", state.indent ? "2em" : "0");
  body.style.setProperty("--manuscript-align", state.align);
  body.style.setProperty("--manuscript-width", `${state.width}px`);
  body.style.setProperty(
    "--manuscript-paper",
    typographyPaperTones[state.paper],
  );
  $("#typographyPreviewPage").style.setProperty(
    "--typography-preview-width",
    `${400 + (state.width - 600) * 0.55}px`,
  );
  $("#typographyFontSizeValue").textContent = `${state.fontSize} px`;
  $("#typographyTitleSizeValue").textContent = `${state.titleSize} px`;
  $("#typographyLineHeightValue").textContent = state.lineHeight.toFixed(2);
  $("#typographyParagraphGapValue").textContent =
    `${state.paragraphGap.toFixed(1)} em`;
  $("#typographyWidthValue").textContent = `${state.width} px`;
  $("#typographyPreviewMeta").textContent =
    `版心 ${state.width} px · 正文 ${state.fontSize} px`;
  if (dirty) {
    $("#typographyDirtyState").className = "status-chip is-warning";
    $("#typographyDirtyState").textContent = "有未应用修改";
    $("#typographyPresetLabel").textContent = "当前：自定义";
    $$("[data-typography-preset]").forEach((button) =>
      button.classList.remove("is-active"),
    );
  }
}

function restoreAppliedTypography() {
  writeTypographyControls(appliedTypography);
  renderTypography(appliedTypography, false);
  const presetKey = matchingTypographyPreset(appliedTypography);
  $$("[data-typography-preset]").forEach((button) =>
    button.classList.toggle(
      "is-active",
      button.dataset.typographyPreset === presetKey,
    ),
  );
  const presetButton = presetKey
    ? $(`[data-typography-preset="${presetKey}"]`)
    : null;
  $("#typographyPresetLabel").textContent = presetButton
    ? `当前：${$("b", presetButton).textContent}`
    : "当前：自定义";
  $("#typographyDirtyState").className = "status-chip is-success";
  $("#typographyDirtyState").textContent = `已应用 · 版本 ${typographyVersion}`;
}

$("#typographyOpen").addEventListener("click", () => {
  $("#typographyOverlay").dataset.confirmed = "false";
  restoreAppliedTypography();
  openOverlay("#typographyOverlay");
});

$("#typographyOverlay").addEventListener("input", (event) => {
  if (!event.target.matches("input, select")) return;
  renderTypography(readTypographyControls());
});

$$("[data-typography-preset]").forEach((button) =>
  button.addEventListener("click", () => {
    const state = typographyPresets[button.dataset.typographyPreset];
    writeTypographyControls(state);
    renderTypography(state, false);
    $$("[data-typography-preset]").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
    $("#typographyPresetLabel").textContent =
      `当前：${$("b", button).textContent}`;
    $("#typographyDirtyState").className = "status-chip is-warning";
    $("#typographyDirtyState").textContent = "有未应用修改";
  }),
);

$$("[data-typography-align]").forEach((button) =>
  button.addEventListener("click", () => {
    $$("[data-typography-align]").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
    renderTypography(readTypographyControls());
  }),
);

$$("[data-paper-tone]").forEach((button) =>
  button.addEventListener("click", () => {
    $$("[data-paper-tone]").forEach((item) =>
      item.classList.toggle("is-active", item === button),
    );
    renderTypography(readTypographyControls());
  }),
);

$("#typographyReset").addEventListener("click", () => {
  writeTypographyControls(typographyDefaults);
  renderTypography(typographyDefaults);
  showToast("已恢复项目默认排版预览，应用后生效");
});

$("#typographyApply").addEventListener("click", () => {
  appliedTypography = readTypographyControls();
  typographyVersion += 1;
  $("#typographyOverlay").dataset.confirmed = "true";
  closeOverlay($("#typographyOverlay"));
  showToast(`全局排版版本 ${typographyVersion} 已应用到《仙途》全部正文`);
});
restoreAppliedTypography();

// 让第一次打开就能发现选区 AI，同时不替用户真正创建浏览器选择。
$("#selectionDemo").addEventListener("click", () =>
  showToast("拖选正文中的句子，可调出选区 AI 工具栏"),
);
