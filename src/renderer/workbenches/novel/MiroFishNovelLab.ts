import {
  computed,
  createApp,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type App,
} from "@vue/runtime-dom";

import type {
  WorkbenchSimulationRun,
  WorkbenchSimulationWorldSnapshot,
} from "@/workbench-sdk";

import type {
  MiroFishNovelBridge,
  MiroFishNovelContext,
  MiroFishNovelView,
} from "./mirofishBridge";
import GraphPanel from "./mirofish/GraphPanel.vue";
import { analyzeActorInfluence } from "./mirofish/worldLabAnalysis";
import type {
  CouncilStatement,
  CouncilVote,
  CouncilSession,
} from "./mirofish/councilRound";
import type { WorldGraphPanelData } from "./mirofish/worldGraphData";
import "./MiroFishNovelLab.css";

interface MiroFishNovelLabProps {
  readonly bridge: MiroFishNovelBridge;
  readonly initialView?: MiroFishNovelView;
}

const VIEW_LABELS: Record<MiroFishNovelView, string> = {
  overview: "实验概览",
  graph: "世界图谱",
  dynamics: "事件参与分析",
  causal: "因果实验",
  council: "圆桌会商",
  reports: "推演报告",
};

const WORKFLOW_STEPS = [
  { view: "overview" as const, index: "01", label: "事实基线", detail: "确认边界" },
  { view: "graph" as const, index: "02", label: "世界关系", detail: "实体与事件" },
  { view: "dynamics" as const, index: "03", label: "参与扩散", detail: "主体与共现" },
  { view: "causal" as const, index: "04", label: "因果约束", detail: "前因与规则" },
  { view: "council" as const, index: "05", label: "立场会商", detail: "分歧与行动" },
  { view: "reports" as const, index: "06", label: "推演结论", detail: "变化与审阅" },
] as const;

function countKinds(snapshot: WorkbenchSimulationWorldSnapshot | null) {
  if (!snapshot) return [];
  const counts = new Map<string, number>();
  for (const actor of snapshot.actors) {
    counts.set(actor.kind, (counts.get(actor.kind) ?? 0) + 1);
  }
  return [
    [
      "角色与势力",
      (counts.get("character") ?? 0) + (counts.get("faction") ?? 0),
    ],
    ["地点", snapshot.locations.length],
    ["规则", snapshot.rules.length],
    ["已确认事件", snapshot.timelineEvents.length],
  ] as const;
}

function runStatusLabel(run: WorkbenchSimulationRun): string {
  return {
    draft: "待启动",
    running: "推演中",
    paused: "已暂停",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  }[run.status];
}

function safeDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayScalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sourceShortHash(value: string): string {
  return value.length > 16 ? value.slice(-16) : value;
}

function causalSummary(snapshot: WorkbenchSimulationWorldSnapshot | null) {
  if (!snapshot) {
    return { events: 0, roots: 0, links: 0, constrained: 0 };
  }
  let links = 0;
  for (const event of snapshot.timelineEvents) {
    links += (event.causeEventIds ?? []).length;
  }
  return {
    events: snapshot.timelineEvents.length,
    roots: snapshot.timelineEvents.filter(
      (event) => !(event.causeEventIds ?? []).length,
    ).length,
    links,
    constrained: snapshot.rules.length,
  };
}

function signalCard(label: string, value: string | number, detail: string) {
  return h("article", { class: "mirofish-lab-signal-card" }, [
    h("span", { class: "mirofish-lab-signal-label" }, label),
    h("strong", { class: "mirofish-lab-signal-value" }, String(value)),
    h("small", { class: "mirofish-lab-signal-detail" }, detail),
  ]);
}

function statCard(label: string, value: string | number, detail: string) {
  return h("article", { class: "mirofish-lab-stat" }, [
    h("span", { class: "mirofish-lab-stat-label" }, label),
    h("strong", { class: "mirofish-lab-stat-value" }, String(value)),
    h("span", { class: "mirofish-lab-stat-detail" }, detail),
  ]);
}

function sectionTitle(title: string, detail: string) {
  return h("div", { class: "mirofish-lab-section-title" }, [
    h("div", [h("h2", title), h("p", detail)]),
  ]);
}

const MiroFishNovelLab = defineComponent({
  name: "MiroFishNovelLab",
  props: {
    bridge: {
      type: Object as () => MiroFishNovelBridge,
      required: true,
    },
    initialView: {
      type: String as () => MiroFishNovelView,
      default: "overview",
    },
  },
  setup(props) {
    const activeView = ref<MiroFishNovelView>(props.initialView);
    const context = ref<MiroFishNovelContext | null>(null);
    const error = ref<string | null>(null);
    const loading = ref(true);
    const isRefreshing = ref(false);
    const graphData = ref<WorldGraphPanelData | null>(null);
    const graphLoading = ref(false);
    const graphError = ref<string | null>(null);
    const graphMaximized = ref(false);
    const reportRun = ref<WorkbenchSimulationRun | null>(null);
    const reportLoading = ref(false);
    const reportError = ref<string | null>(null);
    const reportPlayIndex = ref(-1);
    const reportPlaying = ref(false);
    const focusEventId = ref<string | null>(null);
    const labRoot = ref<HTMLElement | null>(null);
    let reportTimer: ReturnType<typeof setInterval> | null = null;

    const reportEvents = computed(() => reportRun.value?.events ?? []);

    const stopReportPlayback = () => {
      if (reportTimer) {
        clearInterval(reportTimer);
        reportTimer = null;
      }
      reportPlaying.value = false;
    };

    const loadReport = async (runId: string) => {
      stopReportPlayback();
      reportLoading.value = true;
      reportError.value = null;
      reportPlayIndex.value = -1;
      try {
        const run = await props.bridge.request({
          version: 1,
          operation: "get",
          runId,
        });
        reportRun.value = run;
      } catch (cause) {
        reportError.value = cause instanceof Error ? cause.message : String(cause);
      } finally {
        reportLoading.value = false;
      }
    };

    const toggleReportPlayback = () => {
      const total = reportEvents.value.length;
      if (!total) return;
      if (reportPlaying.value) {
        stopReportPlayback();
        return;
      }
      if (reportPlayIndex.value >= total - 1) reportPlayIndex.value = -1;
      reportPlaying.value = true;
      reportTimer = setInterval(() => {
        reportPlayIndex.value += 1;
        if (reportPlayIndex.value >= total) {
          stopReportPlayback();
          reportPlayIndex.value = -1;
        }
      }, 1_400);
    };

    const reportActorName = (id: string) =>
      reportRun.value?.snapshot.actors.find((actor) => actor.id === id)?.name ??
      id;
    const councilActorIds = ref<string[]>([]);
    const councilTopic = ref("");
    const councilRunning = ref(false);
    const councilStatus = ref<"idle" | "running" | "completed" | "error">("idle");
    const councilRound = ref(0);
    const councilMaxRounds = ref(3);
    const councilHistory = ref<readonly CouncilStatement[]>([]);
    const councilVotes = ref<readonly CouncilVote[]>([]);
    const councilError = ref<string | null>(null);
    const councilRequestToken = ref(0);
    const councilHistoryRestored = ref(false);
    const councilSessions = computed(
      () => context.value?.councilSessions ?? [],
    );

    const restoreCouncilSession = (session: CouncilSession) => {
      const currentActorIds = new Set(
        (context.value?.snapshot.actors ?? []).map((actor) => actor.id),
      );
      councilTopic.value = session.topic;
      councilActorIds.value = session.actorIds.filter((id) =>
        currentActorIds.has(id),
      );
      councilMaxRounds.value = session.maxRounds;
      councilRound.value = session.round;
      councilHistory.value = session.history;
      councilVotes.value = session.votes;
      councilRunning.value = false;
      councilStatus.value =
        session.status === "running" ? "error" : session.status;
      councilError.value =
        session.status === "running"
          ? "上次会商未完成，已保留实录。请重新开始以继续讨论。"
          : session.error;
    };
    const persistCouncil = async (status: CouncilSession["status"], errorText: string | null = null): Promise<boolean> => {
      const snapshot = context.value?.snapshot;
      if (!snapshot) return false;
      // Bridge intentionally hides storage. Persistence is injected by the Host through
      // an optional method to keep the Vue surface unable to access workspace paths.
      if (!("saveCouncilSession" in props.bridge)) return true;
      const saveCouncilSession = (props.bridge as MiroFishNovelBridge & {
        saveCouncilSession?: (session: CouncilSession) => Promise<void>;
      }).saveCouncilSession;
      if (!saveCouncilSession) return true;
      const session: CouncilSession = {
        schemaVersion: 1,
        topic: councilTopic.value,
        actorIds: councilActorIds.value,
        maxRounds: councilMaxRounds.value,
        round: councilRound.value,
        history: councilHistory.value,
        votes: councilVotes.value,
        status,
        updatedAt: new Date().toISOString(),
        error: errorText,
      };
      try {
        await saveCouncilSession(session);
        return true;
      } catch (cause) {
        councilError.value = cause instanceof Error ? cause.message : String(cause);
        return false;
      }
    };
    const toggleCouncilActor = (id: string) => {
      councilActorIds.value = councilActorIds.value.includes(id)
        ? councilActorIds.value.filter((item) => item !== id)
        : [...councilActorIds.value, id];
    };

    const runCouncilRound = async (round: number) => {
      if (councilStatus.value !== "running") return;
      const requestToken = ++councilRequestToken.value;
      const snapshot = context.value?.snapshot;
      const actors = (snapshot?.actors ?? [])
        .filter((actor) => councilActorIds.value.includes(actor.id))
        .map((actor) => ({
          id: actor.id,
          name: actor.name,
          kind: actor.kind,
          goals: actor.goals,
          resources: actor.resources,
          constraints: actor.constraints,
        }));
      councilError.value = null;
      try {
        const result = await props.bridge.runCouncilRound({
          topic: councilTopic.value,
          actors,
          round,
          maxRounds: councilMaxRounds.value,
          history: councilHistory.value,
          isFinal: round === councilMaxRounds.value,
        });
        if (requestToken !== councilRequestToken.value) return;
        councilHistory.value = [...councilHistory.value, ...result.statements];
        if (result.votes.length) {
          councilVotes.value = result.votes;
        }
        councilRound.value = round;
        if (round >= councilMaxRounds.value || result.votes.length) {
          councilStatus.value = "completed";
          councilRunning.value = false;
          if (!(await persistCouncil("completed"))) {
            councilStatus.value = "error";
            councilRunning.value = false;
          }
        } else if (!(await persistCouncil("running"))) {
          councilStatus.value = "error";
          councilRunning.value = false;
        }
      } catch (cause) {
        if (requestToken !== councilRequestToken.value) return;
        councilError.value =
          cause instanceof Error ? cause.message : String(cause);
        councilStatus.value = "error";
        councilRunning.value = false;
        await persistCouncil("error", councilError.value);
      }
    };

    const startCouncil = async () => {
      if (!councilTopic.value.trim()) {
        councilError.value = "请先填写会商议题";
        return;
      }
      if (!councilActorIds.value.length) {
        councilError.value = "请至少选择一位会商主体";
        return;
      }
      if (councilStatus.value === "running") return;
      councilRunning.value = true;
      councilStatus.value = "running";
      councilRound.value = 0;
      councilHistory.value = [];
      councilVotes.value = [];
      councilError.value = null;
      if (!(await persistCouncil("running"))) {
        councilStatus.value = "error";
        councilRunning.value = false;
        return;
      }
      await runCouncilRound(1);
    };

    const councilActorName = (id: string) =>
      context.value?.snapshot.actors.find((actor) => actor.id === id)?.name ??
      id;

    // 回放推进时把当前事件滚入视野。
    watch(reportPlayIndex, (index) => {
      if (index < 0) return;
      const el = labRoot.value?.querySelector<HTMLElement>(
        `[data-event-index="${index}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    });

    const loadGraph = async () => {
      graphLoading.value = true;
      graphError.value = null;
      try {
        graphData.value = await props.bridge.loadWorldGraph();
      } catch (cause) {
        graphError.value = cause instanceof Error ? cause.message : String(cause);
      } finally {
        graphLoading.value = false;
      }
    };

    const stats = computed(() => countKinds(context.value?.snapshot ?? null));
    const dynamics = computed(() => {
      const snapshot = context.value?.snapshot;
      return snapshot ? analyzeActorInfluence(snapshot) : null;
    });
    const focusEvent = computed(() => {
      const events = context.value?.snapshot.timelineEvents ?? [];
      return events.find((event) => event.id === focusEventId.value) ?? null;
    });
    const selectedActors = computed(
      () => context.value?.snapshot.actors.slice(0, 8) ?? [],
    );
    const latestRuns = computed(() => context.value?.runs.slice(0, 8) ?? []);

    const load = async (refresh = false) => {
      if (refresh) isRefreshing.value = true;
      else loading.value = true;
      error.value = null;
      try {
        const nextContext = await props.bridge.loadContext();
        context.value = nextContext;
        const events = nextContext.snapshot.timelineEvents;
        if (!events.some((event) => event.id === focusEventId.value)) {
          focusEventId.value = events.at(-1)?.id ?? null;
        }
        if (!councilHistoryRestored.value) {
          const session = context.value.councilSessions?.[0];
          if (session) restoreCouncilSession(session);
          councilHistoryRestored.value = true;
        }
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      } finally {
        loading.value = false;
        isRefreshing.value = false;
      }
    };

    const goTo = (view: MiroFishNovelView) => {
      activeView.value = view;
      props.bridge.navigate(view);
      // 每次进入世界图谱都重新加载：既保证数据新鲜，也让 GraphPanel 的
      // deep watch 拿到新引用从而触发渲染（上游组件 watch 无 immediate，
      // 仅在 graphData 引用变化时重绘，二次进入必须强制刷新）。
      if (view === "graph") {
        void loadGraph();
      }
      // 首次进入圆桌会商时默认推选前 4 个行动主体。
      if (view === "council" && !councilActorIds.value.length) {
        councilActorIds.value = (context.value?.snapshot.actors ?? [])
          .slice(0, 4)
          .map((actor) => actor.id);
      }
    };

    const selectFocusEvent = (
      eventId: string,
      nextView?: MiroFishNovelView,
    ) => {
      focusEventId.value = eventId;
      if (nextView) goTo(nextView);
    };

    const enterCouncilWithFocus = () => {
      const event = focusEvent.value;
      if (event) {
        if (!councilTopic.value.trim()) {
          councilTopic.value = `围绕“${event.title}”，各方下一步应如何行动？`;
        }
        if (!councilActorIds.value.length) {
          councilActorIds.value = event.actorIds.filter((actorId) =>
            context.value?.snapshot.actors.some((actor) => actor.id === actorId),
          );
        }
      }
      goTo("council");
    };

    const renderWorkflow = () => {
      const snapshot = context.value?.snapshot ?? null;
      const summary = causalSummary(snapshot);
      return h("nav", {
        class: "mirofish-lab-workflow",
        "aria-label": "世界推演分析链路",
      }, [
        h("div", { class: "mirofish-lab-workflow-caption" }, [
          h("span", "分析链路"),
          h("small", `${summary.events} 个事实事件 · ${summary.links} 条显式因果`),
        ]),
        h("div", { class: "mirofish-lab-workflow-steps" },
          WORKFLOW_STEPS.flatMap((step, index) => [
            h("button", {
              type: "button",
              role: "link",
              class: [
                "mirofish-lab-workflow-step",
                activeView.value === step.view ? "is-active" : "",
                index < WORKFLOW_STEPS.findIndex((item) => item.view === activeView.value)
                  ? "is-past"
                  : "",
              ],
              "aria-current": activeView.value === step.view ? "page" : undefined,
              onClick: () => goTo(step.view),
              key: step.view,
            }, [
              h("span", { class: "mirofish-lab-workflow-index" }, step.index),
              h("span", { class: "mirofish-lab-workflow-copy" }, [
                h("strong", step.label),
                h("small", step.detail),
              ]),
            ]),
            index < WORKFLOW_STEPS.length - 1
              ? h("span", {
                  class: "mirofish-lab-workflow-arrow",
                  "aria-hidden": "true",
                  key: `${step.view}-arrow`,
                }, "→")
              : null,
          ]),
        ),
      ]);
    };

    const renderFocusContext = () => {
      const event = focusEvent.value;
      if (!event) return null;
      const actorNames = event.actorIds
        .map(
          (actorId) =>
            context.value?.snapshot.actors.find((actor) => actor.id === actorId)
              ?.name ?? actorId,
        )
        .join("、");
      return h("section", {
        class: "mirofish-lab-focus-context",
        "aria-label": "当前研究事件",
      }, [
        h("div", { class: "mirofish-lab-focus-copy" }, [
          h("span", { class: "mirofish-lab-eyebrow" }, "当前研究事件"),
          h("strong", event.title),
          h(
            "small",
            [event.timeLabel || "未标时", actorNames || "未登记行动主体"].join(" · "),
          ),
        ]),
        h("div", { class: "mirofish-lab-focus-actions" }, [
          h("span", { class: "mirofish-lab-focus-status" }, "事实锚点内"),
          h("button", {
            type: "button",
            class: "mirofish-lab-action-button",
            onClick: () => goTo("causal"),
          }, "查看因果"),
        ]),
      ]);
    };

    const renderConnection = () => {
      const capabilities = context.value?.capabilities;
      return h(
        "span",
        {
          class: [
            "mirofish-lab-connection",
            capabilities ? "is-connected" : "is-local-only",
          ],
        },
        capabilities
          ? `MiroFish ${capabilities.engineVersion || "已连接"}`
          : "仅本地快照",
      );
    };

    const renderOverview = () => {
      const snapshot = context.value?.snapshot ?? null;
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle(
          "世界实验室",
          "在当前事实锚点上查看关系、传播和分支推演结果。",
        ),
        h(
          "div",
          { class: "mirofish-lab-stat-grid" },
          stats.value.map(([label, value]) =>
            statCard(label, value, "来自当前小说快照"),
          ),
        ),
        h("div", { class: "mirofish-lab-columns" }, [
          h("section", { class: "mirofish-lab-panel" }, [
            sectionTitle("当前事实锚点", "未来规划不会被当作既成事实"),
            h("div", { class: "mirofish-lab-anchor" }, [
              h("strong", snapshot?.anchor ?? "尚未读取"),
              h("span", `源修订：${snapshot?.sourceRevision ?? "-"}`),
            ]),
            h(
              "p",
              { class: "mirofish-lab-muted" },
              "图谱与分析结果均携带来源和权威状态，推演结果需要经过审阅才能采纳。",
            ),
          ]),
          h("section", { class: "mirofish-lab-panel" }, [
            sectionTitle("已选对象", "首批角色与势力投影"),
            h(
              "div",
              { class: "mirofish-lab-entity-list" },
              selectedActors.value.length
                ? selectedActors.value.map((actor) =>
                    h("button", {
                      class: "mirofish-lab-entity",
                      type: "button",
                      onClick: () => goTo("graph"),
                      title: `查看 ${actor.name} 的关系投影`,
                    }, [
                      h("span", { class: "mirofish-lab-entity-kind" }, actor.kind),
                      h("strong", actor.name),
                      h("small", actor.summary || "暂无摘要"),
                    ]),
                  )
                : [h("p", { class: "mirofish-lab-muted" }, "快照中暂无角色或势力")],
            ),
          ]),
        ]),
        h("section", { class: "mirofish-lab-panel mirofish-lab-panel-wide" }, [
          sectionTitle("从事实到结论", "每一步都应该能回到当前锚点，或明确标记为推演结果。"),
          h("div", { class: "mirofish-lab-signal-grid" }, [
            signalCard("事实事件", snapshot?.timelineEvents.length ?? 0, "截止锚点前"),
            signalCard("显式因果", causalSummary(snapshot).links, "时间线已登记"),
            signalCard("硬规则", snapshot?.rules.filter((rule) => rule.severity === "hard").length ?? 0, "不可违背"),
            signalCard("最近推演", latestRuns.value.length, latestRuns.value.length ? "已有运行记录" : "等待创建"),
          ]),
          h("div", { class: "mirofish-lab-analysis-lane" }, [
            h("article", { class: "mirofish-lab-lane-item" }, [
              h("span", { class: "mirofish-lab-lane-index" }, "A"),
              h("div", [h("strong", "事实边界"), h("p", "先确认哪些事件已经发生，未来计划不会进入推演前提。")]),
            ]),
            h("article", { class: "mirofish-lab-lane-item" }, [
              h("span", { class: "mirofish-lab-lane-index" }, "B"),
              h("div", [h("strong", "关系解释"), h("p", "再看谁参与、谁影响谁，以及规则在哪些位置施加约束。")]),
            ]),
            h("article", { class: "mirofish-lab-lane-item" }, [
              h("span", { class: "mirofish-lab-lane-index" }, "C"),
              h("div", [h("strong", "行动结论"), h("p", "最后才进入会商与推演，所有变化都保留事件、状态和警告证据。")]),
            ]),
          ]),
        ]),
        h("section", { class: "mirofish-lab-panel mirofish-lab-panel-wide" }, [
          sectionTitle("最近推演", "从报告回看一次推演是如何改变世界状态的。"),
          latestRuns.value.length
            ? h("div", { class: "mirofish-lab-run-list" }, latestRuns.value.slice(0, 4).map((run) =>
                h("button", {
                  type: "button",
                  class: "mirofish-lab-run",
                  onClick: () => {
                    void loadReport(run.runId);
                    goTo("reports");
                  },
                  key: run.runId,
                }, [
                  h("div", { class: "mirofish-lab-run-main" }, [
                    h("strong", run.scenario.name),
                    h("span", `${run.currentRound}/${run.maxRounds} 回合 · ${safeDate(run.updatedAt)}`),
                  ]),
                  h("span", { class: ["mirofish-lab-run-status", `is-${run.status}`] }, runStatusLabel(run)),
                ]),
              ))
            : h("p", { class: "mirofish-lab-muted" }, "还没有推演记录。完成事实与方案配置后，可从运行控制台启动第一次推演。"),
        ]),
      ]);
    };

    const renderGraph = () => {
      const nodes = graphData.value?.nodes ?? [];
      const edges = graphData.value?.edges ?? [];
      const eventNodes = nodes.filter((node) => node.labels.includes("事件"));
      const causalEdges = edges.filter((edge) => edge.fact_type === "causes");
      const event = focusEvent.value;
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("世界图谱", "知识实体、设定、地点与已发生事件的关系投影"),
        h("div", { class: "mirofish-lab-signal-grid" }, [
          signalCard("图谱节点", graphData.value ? nodes.length : "—", "实体、地点、事件"),
          signalCard("关系边", graphData.value ? edges.length : "—", "参与、发生地、关联"),
          signalCard("事件节点", graphData.value ? eventNodes.length : "—", "来自事实快照"),
          signalCard("因果边", graphData.value ? causalEdges.length : "—", "显式导致关系"),
        ]),
        h("section", { class: "mirofish-lab-panel mirofish-lab-panel-wide" }, [
          sectionTitle(
            "读图顺序",
            event
              ? `当前围绕“${event.title}”展开：从事件回到行动主体、因果与规则。`
              : "先找事件，再沿参与、发生地和导致关系回到主体与规则。",
          ),
          h("div", { class: "mirofish-lab-graph-reading" }, [
            h("div", { class: "mirofish-lab-graph-reading-step" }, [h("b", "01"), h("span", "事件"), h("small", "当前事实节点")]),
            h("span", { class: "mirofish-lab-workflow-arrow", "aria-hidden": "true" }, "→"),
            h("div", { class: "mirofish-lab-graph-reading-step" }, [h("b", "02"), h("span", "参与主体"), h("small", "谁在行动")]),
            h("span", { class: "mirofish-lab-workflow-arrow", "aria-hidden": "true" }, "→"),
            h("div", { class: "mirofish-lab-graph-reading-step" }, [h("b", "03"), h("span", "因果边"), h("small", "什么导致什么")]),
            h("span", { class: "mirofish-lab-workflow-arrow", "aria-hidden": "true" }, "→"),
            h("div", { class: "mirofish-lab-graph-reading-step" }, [h("b", "04"), h("span", "规则"), h("small", "哪些结果不可行")]),
          ]),
          h("div", { class: "mirofish-lab-action-row" }, [
            h("button", { type: "button", class: "mirofish-lab-action-button", onClick: () => goTo("dynamics") }, "查看主体参与"),
            h("button", { type: "button", class: "mirofish-lab-action-button", onClick: () => goTo("causal") }, "查看因果约束"),
          ]),
        ]),
        h(
          "div",
          { class: ["mirofish-lab-graph-panel", graphMaximized.value ? "is-maximized" : ""] },
          graphError.value
            ? h(
                "div",
                { class: "mirofish-lab-state is-error" },
                graphError.value,
              )
            : h(GraphPanel, {
                graphData: graphData.value,
                loading: graphLoading.value,
                currentPhase: 0,
                isSimulating: false,
                onRefresh: () => void loadGraph(),
                "onToggle-maximize": () => {
                  graphMaximized.value = !graphMaximized.value;
                },
              }),
        ),
      ]);
    };

    const renderDynamics = () => {
      const analysis = dynamics.value;
      const snapshot = context.value?.snapshot ?? null;
      const busiest = analysis?.actors[0];
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("事件参与分析", "从已发生事件提取主体参与度与共现关系"),
        h("div", { class: "mirofish-lab-signal-grid" }, [
          signalCard("已发生事件", snapshot?.timelineEvents.length ?? 0, "参与分析的时间范围"),
          signalCard("活跃主体", analysis?.actors.length ?? 0, "至少参与一个事件"),
          signalCard("共现关系", analysis?.cooccurrences.length ?? 0, "同一事件共同出现"),
          signalCard("最高参与", busiest?.name ?? "—", busiest ? `${busiest.eventCount} 个事件` : "等待快照"),
        ]),
        !analysis
          ? h("p", { class: "mirofish-lab-muted" }, "当前快照暂无行动主体。")
          : [
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h(
                  "h3",
                  `事件参与排行 · ${analysis.actors.length} 个活跃主体`,
                ),
                analysis.actors.length
                  ? h(
                      "div",
                      { class: "mirofish-lab-influence-list" },
                      analysis.actors.slice(0, 12).map((actor, index) =>
                        h(
                          "div",
                          {
                            class: "mirofish-lab-influence-row",
                            key: actor.actorId,
                          },
                          [
                            h(
                              "span",
                              { class: "mirofish-lab-influence-rank" },
                              String(index + 1),
                            ),
                            h("div", { class: "mirofish-lab-influence-copy" }, [
                              h("strong", actor.name),
                              h(
                                "small",
                                `${actor.kind === "faction" ? "势力" : "人物"} · 参与 ${actor.eventCount} 个事件 · 关联 ${actor.connectionCount} 个主体`,
                              ),
                            ]),
                          ],
                        ),
                      ),
                    )
                  : h(
                      "p",
                      { class: "mirofish-lab-muted" },
                      "时间线中还没有已发生事件。",
                    ),
              ]),
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h(
                  "h3",
                  `主体共现 · ${analysis.cooccurrences.length} 组`,
                ),
                analysis.cooccurrences.length
                  ? h(
                      "div",
                      { class: "mirofish-lab-cooccurrence-list" },
                      analysis.cooccurrences
                        .slice(0, 12)
                        .map((pair) =>
                          h(
                            "div",
                            {
                              class: "mirofish-lab-cooccurrence-row",
                              key: `${pair.sourceId}::${pair.targetId}`,
                            },
                            [
                              h("strong", pair.sourceName),
                              h("span", "↔"),
                              h("strong", pair.targetName),
                              h("b", `${pair.count} 次共现`),
                            ],
                          ),
                        ),
                    )
                  : h(
                      "p",
                      { class: "mirofish-lab-muted" },
                      "尚未有主体在同一事件中共现。",
                    ),
              ]),
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h("h3", "事件参与脉络 · 从事件回看主体"),
                snapshot?.timelineEvents.length
                  ? h("div", { class: "mirofish-lab-event-thread" }, snapshot.timelineEvents.slice(-8).map((event) =>
                      h("button", {
                        type: "button",
                        class: [
                          "mirofish-lab-event-thread-row",
                          focusEvent.value?.id === event.id ? "is-focused" : "",
                        ],
                        "aria-pressed": focusEvent.value?.id === event.id,
                        onClick: () => selectFocusEvent(event.id, "causal"),
                        key: event.id,
                      }, [
                        h("span", { class: "mirofish-lab-event-thread-time" }, event.timeLabel || "未标时"),
                        h("div", { class: "mirofish-lab-event-thread-copy" }, [
                          h("strong", event.title),
                          h("small", event.actorIds.length ? `${event.actorIds.length} 位主体参与 · 点击查看因果` : "暂无主体关联"),
                        ]),
                        h("span", { class: "mirofish-lab-event-thread-count" }, String(event.actorIds.length)),
                      ]),
                    ))
                  : h("p", { class: "mirofish-lab-muted" }, "时间线中还没有可分析的事实事件。"),
              ]),
              h("div", { class: "mirofish-lab-next-step" }, [
                h("strong", "参与关系不是因果结论"),
                h("span", "共现只能说明主体出现在同一事件；下一步请进入“因果约束”，确认前因、规则与可行结果。"),
                h("button", { type: "button", class: "mirofish-lab-action-button", onClick: () => goTo("causal") }, "进入因果约束"),
              ]),
            ],
      ]);
    };

    const renderCausal = () => {
      const snapshot = context.value?.snapshot ?? null;
      const causal = causalSummary(snapshot);
      const downstream = new Map<string, number>();
      for (const event of snapshot?.timelineEvents ?? []) {
        for (const causeId of event.causeEventIds ?? []) {
          downstream.set(causeId, (downstream.get(causeId) ?? 0) + 1);
        }
      }
      const actorName = (id: string) =>
        snapshot?.actors.find((actor) => actor.id === id)?.name ?? id;
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("因果实验", "时间线事件链与世界规则约束"),
        h("div", { class: "mirofish-lab-signal-grid" }, [
          signalCard("事实事件", causal.events, "当前锚点内"),
          signalCard("根事件", causal.roots, "没有登记前因"),
          signalCard("因果链接", causal.links, "显式前因边"),
          signalCard("规则约束", causal.constrained, "硬规则与软规则"),
        ]),
        !snapshot
          ? h("p", { class: "mirofish-lab-muted" }, "当前快照暂无数据。")
          : [
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h(
                  "h3",
                  `事件因果链 · ${snapshot.timelineEvents.length} 个已发生事件`,
                ),
                snapshot.timelineEvents.length
                  ? h(
                      "div",
                      { class: "mirofish-lab-causal-chain" },
                      snapshot.timelineEvents.map((event, index) => {
                        const causeNames = (event.causeEventIds ?? []).map(
                          (causeId) =>
                            snapshot.timelineEvents.find(
                              (candidate) => candidate.id === causeId,
                            )?.title ?? causeId,
                        );
                        return h(
                          "button",
                          {
                            type: "button",
                            class: [
                              "mirofish-lab-causal-event",
                              focusEvent.value?.id === event.id ? "is-focused" : "",
                            ],
                            "aria-pressed": focusEvent.value?.id === event.id,
                            onClick: () => selectFocusEvent(event.id),
                            key: event.id,
                          },
                          [
                            h(
                              "span",
                              { class: "mirofish-lab-causal-index" },
                              String(index + 1),
                            ),
                            h("div", { class: "mirofish-lab-causal-copy" }, [
                              h("strong", event.title),
                              event.summary ? h("p", event.summary) : null,
                              h(
                                "small",
                                [
                                  event.timeLabel
                                    ? `${event.timeLabel} · `
                                    : "",
                                  event.actorIds.map(actorName).join("、"),
                                ].join(""),
                              ),
                              h(
                                "div",
                                { class: "mirofish-lab-causal-causes" },
                                causeNames.length
                                  ? `前因：${causeNames.join("、")}`
                                  : "根事件：暂无已登记前因",
                              ),
                              h(
                                "small",
                                downstream.get(event.id)
                                  ? `影响后续 ${downstream.get(event.id)} 个事件`
                                  : "暂无已登记后续事件",
                              ),
                            ]),
                          ],
                        );
                      }),
                    )
                  : h(
                      "p",
                      { class: "mirofish-lab-muted" },
                      "时间线还没有已发生事件。",
                    ),
              ]),
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h("h3", `规则约束 · ${snapshot.rules.length} 条`),
                snapshot.rules.length
                  ? h(
                      "div",
                      { class: "mirofish-lab-rule-list" },
                      snapshot.rules.map((rule) =>
                        h(
                          "div",
                          {
                            class: [
                              "mirofish-lab-rule-row",
                              `is-${rule.severity}`,
                            ],
                            key: rule.id,
                          },
                          [
                            h("strong", rule.title),
                            rule.description
                              ? h("p", rule.description)
                              : null,
                            h(
                              "span",
                              rule.severity === "hard" ? "硬规则" : "软规则",
                            ),
                          ],
                        ),
                      ),
                    )
                  : h(
                      "p",
                      { class: "mirofish-lab-muted" },
                      "尚未配置世界规则。",
                    ),
              ]),
              h("div", { class: "mirofish-lab-next-step" }, [
                h("strong", "因果链的下一步"),
                h(
                  "span",
                  focusEvent.value
                    ? `已选“${focusEvent.value.title}”。将以它为议题基线，比较主体在规则约束下的行动分歧。`
                    : "选择一个根事件或高影响事件，把它带入圆桌会商，比较不同主体在规则约束下的行动分歧。",
                ),
                h("button", { type: "button", class: "mirofish-lab-action-button", onClick: enterCouncilWithFocus }, "带入立场会商"),
              ]),
            ],
      ]);
    };

    const renderCouncil = () => {
      const snapshot = context.value?.snapshot;
      const event = focusEvent.value;
      const selected = (snapshot?.actors ?? []).filter((actor) =>
        councilActorIds.value.includes(actor.id),
      );
      const ready = Boolean(councilTopic.value.trim() && councilActorIds.value.length);
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("圆桌会商", "把剧情问题交给角色、势力代表和规则裁判"),
        h("div", { class: "mirofish-lab-council-context" }, [
          h("div", { class: "mirofish-lab-council-context-main" }, [
            h("span", { class: "mirofish-lab-eyebrow" }, "承接因果实验"),
            h("strong", councilTopic.value || "尚未提出会商问题"),
            h(
              "p",
              ready
                ? `已选 ${selected.length} 位主体，将基于 ${event?.title ?? snapshot?.anchor ?? "当前事实锚点"} 讨论行动分歧。`
                : event
                  ? `当前研究事件为“${event.title}”。可直接使用它生成会商议题，或自行改写问题。`
                  : "先选择主体并填写议题，再启动逐轮会商。",
            ),
          ]),
          h("div", { class: "mirofish-lab-council-context-status" }, [
            h("span", councilStatus.value === "completed" ? "已形成结论" : councilStatus.value === "running" ? "正在收集立场" : "待配置"),
            h("small", `第 ${councilRound.value}/${councilMaxRounds.value} 轮`),
          ]),
        ]),
        !snapshot
          ? h(
              "p",
              { class: "mirofish-lab-muted" },
              "当前快照暂无行动主体。",
            )
          : [
              councilSessions.value.length
                ? h("section", { class: "mirofish-lab-analysis-block" }, [
                    h("h3", `历史会商 · ${councilSessions.value.length} 场`),
                    h(
                      "div",
                      { class: "mirofish-lab-council-history" },
                      councilSessions.value.slice(0, 8).map((session) =>
                        h(
                          "button",
                          {
                            type: "button",
                            class: [
                              "mirofish-lab-council-history-item",
                              councilTopic.value === session.topic &&
                              councilRound.value === session.round
                                ? "is-active"
                                : "",
                            ],
                            title: `恢复 ${safeDate(session.updatedAt)} 的会商记录`,
                            onClick: () => restoreCouncilSession(session),
                            key: `${session.updatedAt}-${session.topic}`,
                          },
                          [
                            h("strong", session.topic),
                            h(
                              "span",
                              `${session.round}/${session.maxRounds} 轮 · ${safeDate(session.updatedAt)}`,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ])
                : null,
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h(
                  "h3",
                  `选择会商主体 · ${councilActorIds.value.length} 个`,
                ),
                h(
                  "div",
                  { class: "mirofish-lab-council-picker" },
                  snapshot.actors.map((actor) =>
                    h(
                      "button",
                      {
                        type: "button",
                        class: [
                          "mirofish-lab-council-actor",
                          councilActorIds.value.includes(actor.id)
                            ? "is-selected"
                            : "",
                        ],
                        "aria-pressed": councilActorIds.value.includes(actor.id),
                        onClick: () => toggleCouncilActor(actor.id),
                        key: actor.id,
                      },
                      [
                        h("strong", actor.name),
                        h(
                          "small",
                          actor.kind === "faction" ? "势力" : "人物",
                        ),
                      ],
                    ),
                  ),
                ),
              ]),
              h("section", { class: "mirofish-lab-analysis-block" }, [
                h("h3", "会商议题"),
                h("input", {
                  class: "mirofish-lab-council-topic",
                  placeholder: "例如：封山后各方下一步会如何行动？",
                  value: councilTopic.value,
                  disabled: councilRunning.value,
                  onInput: (event: Event) => {
                    councilTopic.value = (
                      event.target as HTMLInputElement
                    ).value;
                  },
                }),
                councilStatus.value !== "running"
                  ? h(
                      "button",
                      {
                        type: "button",
                        class: "mirofish-lab-council-start",
                        disabled: !councilTopic.value.trim() || !councilActorIds.value.length,
                        onClick: () => void startCouncil(),
                      },
                      "开始会商",
                    )
                  : h("div", { class: "mirofish-lab-council-progress" }, [
                      h(
                        "span",
                        `第 ${councilRound.value}/${councilMaxRounds.value} 轮`,
                      ),
                      councilVotes.value.length
                        ? h("span", { class: "is-done" }, "已完成投票")
                        : h(
                            "button",
                            {
                              type: "button",
                          disabled: councilRound.value >= councilMaxRounds.value || councilStatus.value !== "running",
                              onClick: () =>
                              void runCouncilRound(councilRound.value + 1),
                            },
                            councilRound.value === councilMaxRounds.value - 1
                              ? "最终轮 · 投票"
                              : "下一轮",
                          ),
                    ]),
                councilError.value
                  ? h(
                      "p",
                      { class: "mirofish-lab-council-error" },
                      councilError.value,
                    )
                  : null,
              ]),
              councilHistory.value.length
                ? h("section", { class: "mirofish-lab-analysis-block" }, [
                    h(
                      "h3",
                      `会商实录 · ${councilHistory.value.length} 条发言`,
                    ),
                    h(
                      "div",
                      { class: "mirofish-lab-council-transcript" },
                      councilHistory.value.map((statement, index) =>
                        h(
                          "div",
                          {
                            class: "mirofish-lab-council-statement",
                            key: `${statement.actorId}-${index}`,
                          },
                          [
                            h(
                              "strong",
                              councilActorName(statement.actorId),
                            ),
                            h("p", statement.message),
                          ],
                        ),
                      ),
                    ),
                  ])
                : null,
              councilVotes.value.length
                ? h("section", { class: "mirofish-lab-analysis-block" }, [
                    h("h3", "投票结果"),
                    h(
                      "div",
                      { class: "mirofish-lab-council-votes" },
                      councilVotes.value.map((vote, index) =>
                        h(
                          "div",
                          {
                            class: [
                              "mirofish-lab-council-vote",
                              `is-${vote.choice}`,
                            ],
                            key: `${vote.actorId}-${index}`,
                          },
                          [
                            h("strong", councilActorName(vote.actorId)),
                            h("span", vote.choice),
                          ],
                        ),
                      ),
                    ),
                  ])
                : null,
              councilVotes.value.length
                ? h("div", { class: "mirofish-lab-next-step" }, [
                    h("strong", "会商结论已形成"),
                    h("span", "投票只代表当前主体立场，是否改变世界状态仍需回到推演报告审阅事件与状态变化。"),
                    h("button", { type: "button", class: "mirofish-lab-action-button", onClick: () => goTo("reports") }, "查看推演报告"),
                  ])
                : null,
              councilStatus.value === "completed"
                ? h(
                    "button",
                    {
                      type: "button",
                      onClick: () => {
                        councilStatus.value = "idle";
                        councilRunning.value = false;
                        councilRound.value = 0;
                        councilHistory.value = [];
                        councilVotes.value = [];
                      },
                    },
                    "重新开始",
                  )
                : null,
              selected.length
                ? h("section", { class: "mirofish-lab-analysis-block" }, [
                    h(
                      "h3",
                      `立场台 · ${selected.length} 位代表`,
                    ),
                    h(
                      "div",
                      { class: "mirofish-lab-council-grid" },
                      selected.map((actor) =>
                        h(
                          "article",
                          { class: "mirofish-lab-council-card", key: actor.id },
                          [
                            h("header", [
                              h("strong", actor.name),
                              h(
                                "span",
                                actor.kind === "faction" ? "势力" : "人物",
                              ),
                            ]),
                            actor.summary
                              ? h(
                                  "p",
                                  { class: "mirofish-lab-muted" },
                                  actor.summary,
                                )
                              : null,
                            actor.goals.length
                              ? h("dl", [
                                  h("dt", "目标"),
                                  h("dd", actor.goals.join("；")),
                                ])
                              : null,
                            actor.resources.length
                              ? h("dl", [
                                  h("dt", "资源"),
                                  h("dd", actor.resources.join("；")),
                                ])
                              : null,
                            actor.constraints.length
                              ? h("dl", [
                                  h("dt", "约束"),
                                  h("dd", actor.constraints.join("；")),
                                ])
                              : null,
                          ],
                        ),
                      ),
                    ),
                  ])
                : null,
            ],
      ]);
    };

    const renderReports = () =>
      h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("推演报告", "完整事件流、状态变化与逐轮回放"),
        h("div", { class: "mirofish-lab-report-intro" }, [
          h("div", [
            h("span", { class: "mirofish-lab-eyebrow" }, "结论审阅"),
            h("strong", reportRun.value ? reportRun.value.scenario.name : "选择一次推演，查看它如何偏离事实基线"),
            h("p", reportRun.value
              ? `本次推演基于 ${reportRun.value.snapshot.anchor}，源修订 ${sourceShortHash(reportRun.value.snapshot.sourceRevision)}。`
              : "报告页是工作流终点：只展示推演产生的事件、状态变化、警告和可采纳线索。"),
          ]),
          reportRun.value
            ? h("div", { class: "mirofish-lab-report-intro-metrics" }, [
                signalCard("回合", `${reportRun.value.currentRound}/${reportRun.value.maxRounds}`, "执行进度"),
                signalCard("事件", reportRun.value.events.length, "推演新增"),
                signalCard("状态变化", reportRun.value.stateChanges.length, "实体字段"),
                signalCard("警告", reportRun.value.warnings.length, "需要审阅"),
              ])
            : null,
        ]),
        h("div", { class: "mirofish-lab-reports" }, [
          h(
            "div",
            { class: "mirofish-lab-report-list" },
            latestRuns.value.length
              ? latestRuns.value.map((run) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: [
                        "mirofish-lab-run",
                        reportRun.value?.runId === run.runId ? "is-active" : "",
                      ],
                      onClick: () => void loadReport(run.runId),
                    },
                    [
                      h("div", { class: "mirofish-lab-run-main" }, [
                        h("strong", run.scenario.name),
                        h(
                          "span",
                          `${run.currentRound}/${run.maxRounds} 回合 · ${safeDate(run.updatedAt)}`,
                        ),
                      ]),
                      h(
                        "span",
                        { class: ["mirofish-lab-run-status", `is-${run.status}`] },
                        runStatusLabel(run),
                      ),
                    ],
                  ),
                )
              : h("p", { class: "mirofish-lab-muted" }, "当前项目还没有推演运行记录。"),
          ),
          h("div", { class: "mirofish-lab-report-body" }, [
            reportError.value
              ? h("div", { class: "mirofish-lab-state is-error" }, reportError.value)
              : !reportRun.value
                ? h(
                    "p",
                    { class: "mirofish-lab-muted" },
                    reportLoading.value ? "正在读取报告…" : "选择左侧推演记录查看完整报告。",
                  )
                : [
                    h("div", { class: "mirofish-lab-report-head" }, [
                      h("div", { class: "mirofish-lab-report-heading" }, [
                        h("h3", reportRun.value.scenario.name),
                        h(
                          "span",
                          `${reportRun.value.currentRound}/${reportRun.value.maxRounds} 轮 · 基线 ${reportRun.value.snapshot.sourceRevision.slice(-10)}`,
                        ),
                      ]),
                      h("div", { class: "mirofish-lab-playback" }, [
                        h(
                          "button",
                          {
                            type: "button",
                            disabled: !reportEvents.value.length,
                            onClick: toggleReportPlayback,
                          },
                          reportPlaying.value ? "暂停" : "回放",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            disabled: reportPlayIndex.value <= 0,
                            onClick: () => {
                              reportPlayIndex.value -= 1;
                            },
                          },
                          "上一步",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            disabled:
                              reportPlayIndex.value >= reportEvents.value.length - 1,
                            onClick: () => {
                              reportPlayIndex.value += 1;
                            },
                          },
                          "下一步",
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            disabled: reportPlayIndex.value < 0,
                            onClick: () => {
                              reportPlayIndex.value = -1;
                            },
                          },
                          "重置",
                        ),
                      ]),
                    ]),
                    h(
                      "div",
                      { class: "mirofish-lab-report-events" },
                      reportEvents.value.length
                        ? reportEvents.value.map((event, index) => {
                            const current = index === reportPlayIndex.value;
                            return h(
                              "article",
                              {
                                class: [
                                  "mirofish-lab-report-event",
                                  current ? "is-current" : "",
                                ],
                                "data-event-index": String(index),
                              },
                              [
                                h(
                                  "span",
                                  { class: "mirofish-lab-report-round" },
                                  `第 ${displayScalar(event.round) || index + 1} 轮`,
                                ),
                                h("div", { class: "mirofish-lab-report-event-copy" }, [
                                  h(
                                    "h4",
                                    textField(event.title) || "世界状态变化",
                                  ),
                                  textField(event.summary)
                                    ? h("p", textField(event.summary))
                                    : null,
                                  textField(event.cause) ||
                                  textField(event.consequence)
                                    ? h("dl", [
                                        textField(event.cause)
                                          ? [
                                              h("dt", "因"),
                                              h("dd", textField(event.cause)),
                                            ]
                                          : null,
                                        textField(event.consequence)
                                          ? [
                                              h("dt", "果"),
                                              h("dd", textField(event.consequence)),
                                            ]
                                          : null,
                                      ])
                                    : null,
                                  stringList(event.actorIds).length
                                    ? h(
                                        "div",
                                        { class: "mirofish-lab-report-actors" },
                                        stringList(event.actorIds).map((id) =>
                                          h(
                                            "span",
                                            { class: "mirofish-lab-tag" },
                                            reportActorName(id),
                                          ),
                                        ),
                                      )
                                    : null,
                                ]),
                              ],
                            );
                          })
                        : h(
                            "p",
                            { class: "mirofish-lab-muted" },
                            "本次推演尚未产生事件。",
                          ),
                    ),
                    reportRun.value.stateChanges.length
                      ? h(
                          "section",
                          { class: "mirofish-lab-report-section" },
                          [
                            h("h3", "状态变化"),
                            h(
                              "div",
                              { class: "mirofish-lab-change-list" },
                              reportRun.value.stateChanges.map(
                                (change, index) =>
                                  h(
                                    "div",
                                    {
                                      key: `${textField(change.entityId)}-${textField(change.field)}-${index}`,
                                    },
                                    [
                                      h(
                                        "strong",
                                        textField(change.entityId) || "世界",
                                      ),
                                      h("span", textField(change.field)),
                                      h(
                                        "p",
                                        `${textField(change.before) || "未记录"} → ${textField(change.after) || "未记录"}`,
                                      ),
                                    ],
                                  ),
                              ),
                            ),
                          ],
                        )
                      : null,
                    reportRun.value.warnings.length
                      ? h(
                          "section",
                          {
                            class:
                              "mirofish-lab-report-section is-warning",
                          },
                          [
                            h("h3", "推演警告"),
                            h(
                              "ul",
                              reportRun.value.warnings.map((warning, index) =>
                                h("li", { key: index }, warning),
                              ),
                            ),
                          ],
                        )
                      : null,
                    h("div", { class: "mirofish-lab-report-conclusion" }, [
                      h("strong", "审阅出口"),
                      h("span", "报告中的事件与状态变化仍是假设结果。确认符合事实、因果和规则后，才能回到运行控制台执行采纳或回滚。"),
                      h("button", { type: "button", class: "mirofish-lab-action-button", onClick: () => goTo("overview") }, "回到事实基线"),
                    ]),
                    ],
                  ],
          ),
        ]),
      ]);

    const renderContent = () => {
      if (activeView.value === "overview") return renderOverview();
      if (activeView.value === "graph") return renderGraph();
      if (activeView.value === "dynamics") return renderDynamics();
      if (activeView.value === "causal") return renderCausal();
      if (activeView.value === "council") return renderCouncil();
      return renderReports();
    };

    const renderRoot = () => h("div", { ref: labRoot, class: "mirofish-lab-root" }, [
      h("header", { class: "mirofish-lab-header" }, [
        h("div", { class: "mirofish-lab-brand" }, [
          h("span", { class: "mirofish-lab-brand-mark" }, "MF"),
          h("div", [
            h("strong", "世界实验室"),
            h("small", context.value?.title ?? "小说项目"),
          ]),
        ]),
        h("div", { class: "mirofish-lab-header-actions" }, [
          renderConnection(),
          h("button", {
            type: "button",
            class: "mirofish-lab-refresh",
            disabled: isRefreshing.value,
            onClick: () => void load(true),
            title: "重新读取当前小说快照和推演运行",
          }, isRefreshing.value ? "读取中" : "刷新"),
        ]),
      ]),
      renderWorkflow(),
      renderFocusContext(),
      h("nav", { class: "mirofish-lab-tabs", "aria-label": "世界实验室视图", role: "tablist" },
        (Object.keys(VIEW_LABELS) as MiroFishNovelView[]).map((view) =>
          h("button", {
            type: "button",
            class: { "is-active": activeView.value === view },
            role: "tab",
            "aria-selected": activeView.value === view,
            onClick: () => goTo(view),
          }, VIEW_LABELS[view]),
        ),
      ),
      loading.value
        ? h("div", { class: "mirofish-lab-state" }, "正在读取小说事实快照…")
        : error.value
          ? h("div", { class: "mirofish-lab-state is-error" }, [
              h("strong", "世界实验室暂时无法读取"),
              h("p", error.value),
              h("button", { type: "button", onClick: () => void load(true) }, "重试"),
            ])
          : renderContent(),
    ]);

    let unsubscribe: (() => void) | null = null;
    onMounted(() => {
      void load();
      unsubscribe = props.bridge.subscribe(() => {
        // Host is authoritative: run controls in the sibling console may change
        // status/events, so refresh the lab context on every notification.
        if (!loading.value && !isRefreshing.value) void load(true);
      });
    });

    onUnmounted(() => {
      unsubscribe?.();
      stopReportPlayback();
    });

    return renderRoot;
  },
});

export function mountMiroFishNovelLab(
  target: HTMLElement,
  props: MiroFishNovelLabProps,
): () => void {
  const app: App = createApp(
    MiroFishNovelLab,
    props as unknown as Record<string, unknown>,
  );
  app.mount(target);
  return () => app.unmount();
}

export default MiroFishNovelLab;
