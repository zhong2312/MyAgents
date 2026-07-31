import {
  computed,
  createApp,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
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
import "./MiroFishNovelLab.css";

interface MiroFishNovelLabProps {
  readonly bridge: MiroFishNovelBridge;
  readonly initialView?: MiroFishNovelView;
}

const VIEW_LABELS: Record<MiroFishNovelView, string> = {
  overview: "实验概览",
  graph: "世界图谱",
  dynamics: "传播态势",
  causal: "因果实验",
  council: "角色会商",
  reports: "推演报告",
};

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

function titleForView(view: MiroFishNovelView): string {
  return VIEW_LABELS[view];
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

    const stats = computed(() => countKinds(context.value?.snapshot ?? null));
    const selectedActors = computed(
      () => context.value?.snapshot.actors.slice(0, 8) ?? [],
    );
    const latestRuns = computed(() => context.value?.runs.slice(0, 8) ?? []);

    const load = async (refresh = false) => {
      if (refresh) isRefreshing.value = true;
      else loading.value = true;
      error.value = null;
      try {
        context.value = await props.bridge.loadContext();
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
      ]);
    };

    const renderGraph = () => {
      const snapshot = context.value?.snapshot;
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle("世界图谱", "复用 MiroFish 图谱视图的小说数据适配层"),
        h("div", { class: "mirofish-lab-panel mirofish-lab-panel-wide" }, [
          h("div", { class: "mirofish-lab-graph-placeholder" }, [
            h("div", { class: "mirofish-lab-graph-ring" }),
            h("div", { class: "mirofish-lab-graph-copy" }, [
              h("strong", "图谱投影已就绪"),
              h("span", `${snapshot?.actors.length ?? 0} 个节点 · ${snapshot?.timelineEvents.length ?? 0} 个事实事件`),
              h("small", "下一步将挂载 MiroFish GraphVisualization，并将关系数据替换为 knowledge/relations.json。"),
            ]),
          ]),
          h("div", { class: "mirofish-lab-legend" }, [
            h("span", [h("i", { class: "is-canon" }), "已确认事实"]),
            h("span", [h("i", { class: "is-planned" }), "未来计划"]),
            h("span", [h("i", { class: "is-hypothesis" }), "推演假设"]),
          ]),
        ]),
      ]);
    };

    const renderAnalysis = (view: "dynamics" | "causal") => {
      const isCausal = view === "causal";
      const cards = isCausal
        ? [
            ["事件前因", "从时间线事件和规则约束构建因果链"],
            ["反事实分支", "比较作者干预前后的状态变化"],
            ["规则碰撞", "标记违反硬规则或削弱软规则的结果"],
          ]
        : [
            ["声望传播", "跟踪人物、势力和地点的认知变化"],
            ["影响级联", "查看事件沿关系网络的扩散路径"],
            ["情绪趋势", "关联章节、回合和爽点目标的变化"],
          ];
      return h("div", { class: "mirofish-lab-content" }, [
        sectionTitle(
          titleForView(view),
          isCausal ? "小说事件和世界规则的可解释分析" : "把社交模拟指标转换成剧情可用信号",
        ),
        h("div", { class: "mirofish-lab-analysis-grid" }, cards.map(([title, detail]) =>
          h("article", { class: "mirofish-lab-analysis-card" }, [
            h("span", { class: "mirofish-lab-analysis-index" }, "0"),
            h("h3", title),
            h("p", detail),
            h("span", { class: "mirofish-lab-coming" }, "适配层准备中"),
          ]),
        )),
      ]);
    };

    const renderCouncil = () => h("div", { class: "mirofish-lab-content" }, [
      sectionTitle("角色会商", "复用 MiroFish Debate / Roundtable 的讨论界面"),
      h("div", { class: "mirofish-lab-panel mirofish-lab-council" }, [
        h("div", { class: "mirofish-lab-council-head" }, [
          h("strong", "把剧情问题交给角色、势力代表和规则裁判"),
          h("span", { class: "mirofish-lab-coming" }, "适配层准备中"),
        ]),
        h("p", { class: "mirofish-lab-muted" }, "会商结果会保存为推演报告或待审阅提案，不会直接改写人物库和时间线。"),
        h("div", { class: "mirofish-lab-council-tags" }, selectedActors.value.slice(0, 6).map((actor) =>
          h("span", { class: "mirofish-lab-tag" }, actor.name),
        )),
      ]),
    ]);

    const renderReports = () => h("div", { class: "mirofish-lab-content" }, [
      sectionTitle("推演报告", "报告、回放和证据链统一绑定当前小说项目"),
      h("div", { class: "mirofish-lab-panel mirofish-lab-panel-wide" }, [
        latestRuns.value.length
          ? h("div", { class: "mirofish-lab-run-list" }, latestRuns.value.map((run) =>
              h("button", {
                type: "button",
                class: "mirofish-lab-run",
                onClick: () => props.bridge.navigate("reports"),
              }, [
                h("div", { class: "mirofish-lab-run-main" }, [
                  h("strong", run.scenario.name),
                  h("span", `${run.currentRound}/${run.maxRounds} 回合 · ${safeDate(run.updatedAt)}`),
                ]),
                h("span", { class: ["mirofish-lab-run-status", `is-${run.status}`] }, runStatusLabel(run)),
              ]),
            ))
          : h("p", { class: "mirofish-lab-muted" }, "当前项目还没有推演运行记录。"),
      ]),
    ]);

    const renderContent = () => {
      if (activeView.value === "overview") return renderOverview();
      if (activeView.value === "graph") return renderGraph();
      if (activeView.value === "dynamics" || activeView.value === "causal") {
        return renderAnalysis(activeView.value);
      }
      if (activeView.value === "council") return renderCouncil();
      return renderReports();
    };

    const renderRoot = () => h("div", { class: "mirofish-lab-root" }, [
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
      h("nav", { class: "mirofish-lab-tabs", "aria-label": "世界实验室视图" },
        (Object.keys(VIEW_LABELS) as MiroFishNovelView[]).map((view) =>
          h("button", {
            type: "button",
            class: { "is-active": activeView.value === view },
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
        // The host owns the authoritative state; re-rendering is enough here.
        if (!context.value) void load();
      });
    });

    onUnmounted(() => {
      unsubscribe?.();
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
