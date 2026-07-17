import {
  Component,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  Clapperboard,
  Clock3,
  Code2,
  FileText,
  FolderOpen,
  Library,
  LayoutDashboard,
  LayoutTemplate,
  ListTree,
  Loader2,
  Map,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  WORKBENCH_AGENT_SESSION_REQUEST_VERSION,
  WORKBENCH_AI_RUN_REQUEST_VERSION,
  WORKBENCH_HOST_API_VERSION,
  formatWorkbenchApiVersion,
  type WorkbenchAgentSessionRequest,
  type WorkbenchAiRunRequest,
  type WorkbenchAiRunResult,
  type WorkbenchTabTarget,
} from "../../shared/workbench-sdk";
import { getFolderName } from "@/types/tab";
import { workbenchRegistry } from "@/workbench-registry";
import type { WorkbenchRegistry } from "./registry";
import { WorkbenchHeaderActionsProvider } from "./WorkbenchHeaderActions";
import { useWorkbenchStorage } from "@/workbench-host/useWorkbenchStorage";

interface WorkbenchShellProps {
  readonly target: WorkbenchTabTarget | undefined;
  readonly workspacePath: string;
  readonly isActive: boolean;
  readonly onNavigate: (route: string) => void;
  readonly onOpenAgentSession?: (
    workspacePath: string,
    request: WorkbenchAgentSessionRequest,
  ) => Promise<void>;
  readonly onRunAi?: (
    workspacePath: string,
    request: WorkbenchAiRunRequest,
  ) => Promise<WorkbenchAiRunResult>;
  readonly registry?: WorkbenchRegistry;
}

interface BoundaryProps {
  readonly resetKey: string;
  readonly fallback: (error: Error) => ReactNode;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly error: Error | null;
}

class WorkbenchModuleBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      "[WorkbenchShell] Workbench renderer failed:",
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    return this.state.error
      ? this.props.fallback(this.state.error)
      : this.props.children;
  }
}

const NAV_ICONS = {
  "layout-dashboard": LayoutDashboard,
  "file-text": FileText,
  "book-open": BookOpen,
  "clock-3": Clock3,
  library: Library,
  "list-tree": ListTree,
  map: Map,
  network: Network,
  "layout-template": LayoutTemplate,
  users: Users,
  clapperboard: Clapperboard,
  boxes: Boxes,
  settings: Settings,
  "code-2": Code2,
} as const;

function FailureState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--paper)] px-8">
      <div className="max-w-xl text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--warning-bg)] text-[var(--warning)]">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h2 className="text-xl font-semibold text-[var(--ink)]">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
          {detail}
        </p>
      </div>
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation("app");
  return (
    <div className="flex h-full items-center justify-center bg-[var(--paper)] text-[var(--ink-muted)]">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("workbench.loading")}</span>
      </div>
    </div>
  );
}

export default function WorkbenchShell({
  target,
  workspacePath,
  isActive,
  onNavigate,
  onOpenAgentSession,
  onRunAi,
  registry = workbenchRegistry,
}: WorkbenchShellProps) {
  const { t } = useTranslation("app");
  const storage = useWorkbenchStorage(workspacePath);
  const registration = target ? registry.get(target.workbenchId) : undefined;
  const definition = registration?.definition;
  const manifest = definition?.manifest;
  const Renderer = registration?.Renderer;
  const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(
    () => definition?.shell?.defaultNavigationCollapsed ?? false,
  );
  const [headerActionsTarget, setHeaderActionsTarget] =
    useState<HTMLElement | null>(null);
  const routeIds = useMemo(
    () => new Set(manifest?.navigation.map((item) => item.id) ?? []),
    [manifest],
  );
  const route =
    target && routeIds.has(target.route)
      ? target.route
      : (manifest?.entry.defaultRoute ?? "");
  const navigate = useCallback(
    (nextRoute: string) => {
      if (routeIds.has(nextRoute)) onNavigate(nextRoute);
    },
    [onNavigate, routeIds],
  );
  const openAgentSession = useCallback(
    async (request: WorkbenchAgentSessionRequest) => {
      if (request.version !== WORKBENCH_AGENT_SESSION_REQUEST_VERSION) {
        throw new Error(
          `Unsupported workbench Agent Session request version: ${request.version}`,
        );
      }
      if (!onOpenAgentSession) {
        throw new Error("MyAgents Agent Session host is unavailable");
      }
      await onOpenAgentSession(workspacePath, request);
    },
    [onOpenAgentSession, workspacePath],
  );
  const runAi = useCallback(
    async (request: WorkbenchAiRunRequest) => {
      if (request.version !== WORKBENCH_AI_RUN_REQUEST_VERSION) {
        throw new Error(
          `Unsupported workbench AI run version: ${request.version}`,
        );
      }
      if (!onRunAi) throw new Error("MyAgents AI run host is unavailable");
      return onRunAi(workspacePath, request);
    },
    [onRunAi, workspacePath],
  );

  if (!target) {
    return (
      <FailureState
        title={t("workbench.invalidTab")}
        detail={t("workbench.invalidTabDetail")}
      />
    );
  }
  if (!registration || !manifest || !Renderer) {
    return (
      <FailureState
        title={t("workbench.notInstalled")}
        detail={t("workbench.notInstalledDetail", { id: target.workbenchId })}
      />
    );
  }
  if (!registration.compatibility.compatible) {
    const requirement = manifest.api;
    const hostVersion = formatWorkbenchApiVersion(WORKBENCH_HOST_API_VERSION);
    const detail =
      registration.compatibility.reason === "major-mismatch"
        ? t("workbench.apiMajorMismatch", {
            required: requirement.major,
            host: hostVersion,
          })
        : registration.compatibility.reason === "host-too-old"
          ? t("workbench.apiHostTooOld", {
              required: `${requirement.major}.${requirement.minMinor}`,
              host: hostVersion,
            })
          : t("workbench.apiHostTooNew", {
              required: `${requirement.major}.${requirement.maxMinor}`,
              host: hostVersion,
            });
    return <FailureState title={t("workbench.incompatible")} detail={detail} />;
  }

  const navigation = [...manifest.navigation].sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) ||
      left.label.localeCompare(right.label),
  );
  const workspaceName = getFolderName(workspacePath);
  const context = Object.freeze({
    manifest,
    workspacePath,
    workspaceName,
    route,
    isActive,
    storage,
    agentSessions: Object.freeze({
      isAvailable: Boolean(onOpenAgentSession),
      open: openAgentSession,
    }),
    aiRuns: Object.freeze({
      isAvailable: Boolean(onRunAi),
      run: runAi,
    }),
    navigate,
  });

  return (
    <div className="flex h-full min-h-0 bg-[var(--paper)] text-[var(--ink)]">
      <aside
        className={`flex flex-shrink-0 flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--paper-elevated)] transition-[width] duration-200 motion-reduce:transition-none ${
          isNavigationCollapsed ? "w-16" : "w-60 max-lg:w-52"
        }`}
      >
        <div
          className={`border-b border-[var(--line-subtle)] py-4 ${
            isNavigationCollapsed ? "px-3" : "px-4"
          }`}
        >
          <div
            className={`flex items-center ${
              isNavigationCollapsed ? "justify-center" : "gap-2.5"
            }`}
          >
            <button
              type="button"
              aria-controls="workbench-navigation"
              aria-expanded={!isNavigationCollapsed}
              aria-label={t(
                isNavigationCollapsed
                  ? "workbench.expandNavigation"
                  : "workbench.collapseNavigation",
              )}
              title={t(
                isNavigationCollapsed
                  ? "workbench.expandNavigation"
                  : "workbench.collapseNavigation",
              )}
              onClick={() => setIsNavigationCollapsed((current) => !current)}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-muted)]"
            >
              {isNavigationCollapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
            {!isNavigationCollapsed && (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--ink)]">
                  {manifest.name}
                </div>
                <div
                  className="mt-0.5 truncate text-xs text-[var(--ink-muted)]"
                  title={workspacePath}
                >
                  {workspaceName}
                </div>
              </div>
            )}
          </div>
        </div>

        <nav
          id="workbench-navigation"
          className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
          aria-label={t("workbench.navigation")}
        >
          {navigation.map((item) => {
            const Icon =
              NAV_ICONS[item.icon as keyof typeof NAV_ICONS] ?? Boxes;
            const active = item.id === route;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={item.label}
                className={`mb-0.5 flex h-9 w-full items-center rounded-md text-left text-sm transition-colors ${
                  isNavigationCollapsed
                    ? "justify-center px-2"
                    : "gap-2.5 px-2.5"
                } ${
                  active
                    ? "bg-[var(--accent-warm-subtle)] font-medium text-[var(--ink)]"
                    : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                }`}
                onClick={() => navigate(item.id)}
              >
                <Icon
                  className={`h-4 w-4 flex-shrink-0 ${active ? "text-[var(--accent-warm)]" : ""}`}
                />
                {!isNavigationCollapsed && (
                  <span className="truncate">{item.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {!isNavigationCollapsed && (
          <div className="border-t border-[var(--line-subtle)] px-4 py-3 text-xs text-[var(--ink-subtle)]">
            {t("workbench.version", { version: manifest.version })}
          </div>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="truncate text-base font-semibold text-[var(--ink)]">
                {navigation.find((item) => item.id === route)?.label ??
                  manifest.name}
              </h1>
              <span
                ref={setHeaderActionsTarget}
                className="flex shrink-0 items-center gap-2"
              />
            </div>
            <p
              className="truncate text-xs text-[var(--ink-muted)] max-md:hidden"
              title={workspacePath}
            >
              {workspacePath}
            </p>
          </div>
          <div className="ml-4 flex items-center gap-1.5 rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] max-md:hidden">
            <FolderOpen className="h-3.5 w-3.5" />
            <span>{workspaceName}</span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto">
          <WorkbenchModuleBoundary
            resetKey={`${manifest.id}:${route}`}
            fallback={(error) => (
              <FailureState
                title={t("workbench.rendererFailed")}
                detail={error.message || t("workbench.rendererFailedDetail")}
              />
            )}
          >
            <Suspense fallback={<LoadingState />}>
              <WorkbenchHeaderActionsProvider target={headerActionsTarget}>
                <Renderer context={context} />
              </WorkbenchHeaderActionsProvider>
            </Suspense>
          </WorkbenchModuleBoundary>
        </main>
      </section>
    </div>
  );
}
