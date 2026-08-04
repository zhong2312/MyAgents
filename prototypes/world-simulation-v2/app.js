(function () {
  "use strict";

  var state = {
    view: "console",
    chapterMode: "none",
    narrativeMode: "guide",
    toastTimer: null,
    event: "seal",
  };

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () { toast.classList.remove("is-visible"); }, 2600);
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll("[data-view-target]").forEach(function (button) {
      var active = button.dataset.viewTarget === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-view]").forEach(function (panel) {
      panel.classList.toggle("is-active", panel.dataset.view === view);
    });
    showToast(view === "console" ? "已回到运行控制台" : view === "lab" ? "已打开世界实验室" : "已打开立场会商");
  }

  function setChapterMode(mode) {
    state.chapterMode = mode;
    document.querySelectorAll("[data-chapter-mode]").forEach(function (button) {
      button.classList.toggle("is-selected", button.dataset.chapterMode === mode);
    });
    var options = document.getElementById("chapter-options");
    var note = document.getElementById("chapter-source-note");
    var help = document.getElementById("chapter-mode-help");
    var sidebar = document.getElementById("sidebar-chapter");
    var messages = {
      none: ["正文不是事实源", "不使用章节", "基线只取正式时间线的事实截止点"],
      continue: ["正文明确事实进入沙盒", "第 42 章后继续", "只编译正文中明确发生的事实"],
      replay: ["章节作为观察目标", "第 42 章前重演", "章节剧情不会被当作已发生事实"],
      branch: ["从章节节点创建分支", "第 42 章处分支", "第 42 章之前固定，第 42 章之后重新选择"],
    };
    var message = messages[mode] || messages.none;
    if (options) options.classList.toggle("is-hidden", mode === "none");
    if (note) note.textContent = message[0];
    if (sidebar) sidebar.textContent = message[1];
    if (help) help.textContent = message[2];
    updateNarrativeSummary();
    showToast(message[1]);
  }

  function updateNarrativeSummary() {
    var mode = document.getElementById("narrative-mode");
    var note = document.getElementById("narrative-source-note");
    var sidebar = document.getElementById("sidebar-narrative");
    if (!mode || !note || !sidebar) return;
    var labels = { guide: "引导", observe: "仅观察", enforce: "强约束", off: "关闭" };
    var selected = Array.from(document.querySelectorAll("[data-narrative-source]:checked"));
    var names = selected.map(function (input) { return input.dataset.narrativeSource; }).filter(Boolean);
    var readable = { mainline: "主线", arc: "故事弧", outline: "大纲", chapter: "章节" };
    note.textContent = "当前：" + labels[mode.value] + " · " + selected.length + " 项设计";
    sidebar.textContent = labels[mode.value] + " · " + (names.length ? names.map(function (name) { return readable[name] || name; }).join("/") : "无设计");
  }

  function setLabPanel(panel) {
    document.querySelectorAll("[data-lab-panel]").forEach(function (button) { button.classList.toggle("is-active", button.dataset.labPanel === panel); });
    document.querySelectorAll("[data-lab-content]").forEach(function (content) { content.classList.toggle("is-active", content.dataset.labContent === panel); });
  }

  function selectEvent(eventId) {
    state.event = eventId;
    document.querySelectorAll("[data-event]").forEach(function (node) { node.classList.toggle("is-selected", node.dataset.event === eventId); });
    var content = {
      seal: { title: "封印能量开始加速下降", reason: "守阵人失踪后，封印维护中断；青崖山灵脉同时进入枯竭周期。确定性内核先判定规则触发，再邀请主体做出响应。" },
      boy: { title: "小山村外的少年第一次感应灵气", reason: "封印外泄让无名小镇的灵气浓度超过感知阈值。少年只能感知到异常，不会自动知道青崖山的秘密。" },
      war: { title: "丹衍宗与剑宗在落霞谷交战", reason: "灵脉争夺、双方情报延迟和势力目标发生碰撞。主线只提高谈判与冲突候选的评分，不替势力做决定。" },
    }[eventId] || { title: "选中一条世界事件", reason: "事件的触发条件、空间路径和后续影响会在这里展开。" };
    var title = document.getElementById("inspector-title");
    var reason = document.getElementById("inspector-reason");
    if (title) title.textContent = content.title;
    if (reason) reason.textContent = content.reason;
  }

  function startRun() {
    var status = document.getElementById("run-status");
    var label = document.getElementById("run-status-label");
    var clock = document.getElementById("run-clock");
    var button = document.getElementById("start-run");
    if (status) status.classList.add("is-running");
    if (label) label.textContent = "推演运行中";
    if (clock) clock.textContent = "正在推进 · 第 25 日";
    if (button) { button.innerHTML = '<i data-lucide="pause"></i>暂停推演'; button.dataset.toast = "已暂停推演，状态已保存到检查点"; }
    refreshIcons();
    showToast("已从事实终点启动主分支");
  }

  function selectParty(partyId) {
    var parties = {
      dan: { avatar: "丹", tone: "is-warm", name: "丹衍宗", title: "丹衍宗 · 守住灵脉，避免全面战争", stance: "他们知道封印正在衰减，但不知道剑宗已经派出先遣队。", facts: ["青崖山封印维护中断", "落霞谷灵脉浓度上升", "王城驻军无法在两日内增援"] },
      sword: { avatar: "剑", tone: "is-red", name: "剑宗", title: "剑宗 · 先取得落霞谷，再判断封印真相", stance: "他们掌握灵气异常的方向，但误以为丹衍宗已经独占新灵脉。", facts: ["落霞谷灵气正在升高", "丹衍宗开始召回外门弟子", "王城尚未公开介入争端"] },
      boy: { avatar: "苏", tone: "is-cool", name: "苏照夜", title: "苏照夜 · 找到灵气异变和师门失踪的联系", stance: "他只知道山中出现异象，并不知道两宗已经围绕灵脉展开博弈。", facts: ["第 25 日曾感知异常灵气", "师父留下北行线索", "无名小镇流传守阵人失踪的传闻"] },
      court: { avatar: "王", tone: "is-green", name: "北境王城", title: "北境王城 · 维持法统，避免宗门战争外溢", stance: "王城收到的消息已经延迟六日，对封印衰减程度存在严重低估。", facts: ["两宗在落霞谷增派人手", "边军只能维持现有防线", "王城对青崖山仍有名义辖权"] },
    };
    var party = parties[partyId] || parties.dan;
    document.querySelectorAll("[data-party]").forEach(function (item) { item.classList.toggle("is-selected", item.dataset.party === partyId); });
    var avatar = document.getElementById("party-avatar");
    var title = document.getElementById("party-title");
    var stance = document.getElementById("party-stance");
    var facts = document.getElementById("party-facts");
    var proposalHeading = document.getElementById("proposal-heading-title");
    if (avatar) { avatar.textContent = party.avatar; avatar.className = "party-avatar " + party.tone; }
    if (title) title.textContent = party.title;
    if (stance) stance.textContent = party.stance;
    if (facts) facts.innerHTML = party.facts.map(function (fact) { return "<li>" + fact + "</li>"; }).join("");
    if (proposalHeading) proposalHeading.textContent = party.name + "准备怎么做";
    showToast("已切换到" + party.name + "的知识投影");
  }

  function selectProposal(target) {
    document.querySelectorAll("[data-proposal]").forEach(function (item) { item.classList.toggle("is-selected", item === target); });
    var title = target.querySelector("strong")?.textContent || "候选方案";
    var score = target.querySelector("b")?.textContent || "-";
    var inspectorTitle = document.getElementById("proposal-inspector-title");
    var inspectorScore = document.getElementById("proposal-score");
    if (inspectorTitle) inspectorTitle.textContent = title;
    if (inspectorScore) inspectorScore.textContent = score;
    showToast("已选中：" + title);
  }

  document.addEventListener("click", function (event) {
    var target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.viewTarget) { setView(target.dataset.viewTarget); return; }
    if (target.dataset.chapterMode) { setChapterMode(target.dataset.chapterMode); return; }
    if (target.dataset.labPanel) { setLabPanel(target.dataset.labPanel); return; }
    if (target.dataset.event) { selectEvent(target.dataset.event); return; }
    if (target.dataset.party) { selectParty(target.dataset.party); return; }
    if (target.hasAttribute("data-proposal")) { selectProposal(target); return; }
    if (target.classList.contains("scale-option") || target.classList.contains("scale-pill")) { target.classList.toggle("is-selected"); if (target.classList.contains("scale-pill")) { target.parentElement.querySelectorAll(".scale-pill").forEach(function (item) { if (item !== target) item.classList.remove("is-active"); }); target.classList.add("is-active"); } return; }
    if (target.id === "start-run") { startRun(); return; }
    if (target.dataset.toast) { showToast(target.dataset.toast); }
  });

  document.addEventListener("change", function (event) {
    if (event.target.id === "narrative-mode" || event.target.matches("[data-narrative-source]")) { updateNarrativeSummary(); }
    if (event.target.id === "chapter-anchor") { showToast("已切换章节锚点：" + event.target.options[event.target.selectedIndex].textContent); }
  });

  window.addEventListener("DOMContentLoaded", function () { refreshIcons(); updateNarrativeSummary(); selectEvent("seal"); });
})();
