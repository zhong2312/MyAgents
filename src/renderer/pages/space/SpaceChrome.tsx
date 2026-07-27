import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  GitBranch,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Package,
  Plus,
  Settings,
  UserPlus,
} from "lucide-react";

import type { SpaceInfo, SpaceListItem, SpaceSession } from "@/api/spaceCloud";
import myagentsWebLogo from "@/assets/brand/myagents-web-logo.png";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { currentSupportedLocale } from "@/i18n/format";
import { SpaceAvatar, SpaceIcon, spaceDisplayName } from "./SpaceAvatar";
import { PAPER_GRID_STYLE } from "./spaceUi";

export type SpaceViewMode = "issues" | "goals" | "skills" | "settings";

function joinPolicyLabel(
  policy: string | null | undefined,
  t: (key: string) => string,
): string {
  const normalized = policy?.trim().toLowerCase() ?? "";
  if (normalized === "open_join" || normalized === "open") {
    return t("space.joinPolicies.open");
  }
  if (
    normalized === "approval_required" ||
    normalized === "approval-required"
  ) {
    return t("space.joinPolicies.approvalRequired");
  }
  return t("space.joinPolicies.unknown");
}

function spaceIconAvatarUrl(space: SpaceInfo): string | null {
  return (
    space.avatarUrl ||
    (space.spaceKind === "official" || space.slug === "official"
      ? myagentsWebLogo
      : null)
  );
}

export function SpaceLogin({
  authBusy,
  authFlow,
  onLogin,
}: {
  authBusy: boolean;
  authFlow: { token: string; expiresAt: number } | null;
  onLogin: () => void;
}) {
  const { t } = useTranslation("app");
  return (
    <div
      className="relative flex h-full items-center justify-center overflow-hidden bg-[var(--paper)] px-6"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={PAPER_GRID_STYLE}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-md">
        <div className="mb-6 flex items-center gap-3">
          <img
            src={myagentsWebLogo}
            alt=""
            className="h-11 w-11 rounded-xl shadow-sm"
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--accent-warm)]">
              {t("space.login.eyebrow")}
            </p>
            <h1 className="truncate text-xl font-semibold text-[var(--ink)]">
              {t("space.login.title")}
            </h1>
            <p className="text-sm text-[var(--ink-muted)]">
              {t("space.login.description")}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={authBusy}
          onClick={onLogin}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
        >
          {authBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          {authFlow
            ? t("space.login.waiting")
            : t("space.login.continueWithGoogle")}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--ink-muted)]">
          {t("space.login.returnHint")}
        </p>
      </div>
    </div>
  );
}

export function SpaceSidebar({
  session,
  mode,
  onSpaceTabChange,
  onSpaceSwitch,
  onJoinSpace,
  onCreateSpace,
  onLogout,
  onOpenProfileSettings,
  onRefreshAccountPlan,
}: {
  session: SpaceSession;
  mode: SpaceViewMode;
  onSpaceTabChange: (mode: SpaceViewMode) => void;
  onSpaceSwitch: (spaceId: string, mode: SpaceViewMode) => void;
  onJoinSpace: () => void;
  onCreateSpace: () => void;
  onLogout: () => void;
  onOpenProfileSettings: () => void;
  onRefreshAccountPlan?: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const [accountPlanViewedAt, setAccountPlanViewedAt] = useState(() =>
    Date.now(),
  );
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const displayName = spaceDisplayName(session.user);
  const canManageSpace =
    session.membership.role === "owner" || session.membership.role === "admin";
  const activeSpaceId = session.space.id || session.space.slug;
  const [expandedSpaceId, setExpandedSpaceId] = useState<string | null>(
    activeSpaceId,
  );
  const listedSpaces = session.spaces ?? [];
  const activeSpaceListed = listedSpaces.some((space) => {
    const spaceId = space.id || space.slug;
    return spaceId === activeSpaceId || space.slug === session.space.slug;
  });
  const activeSpaceFallback: SpaceListItem = {
    ...session.space,
    membership: session.membership,
    canManage: canManageSpace,
    pendingJoinRequestCount: 0,
  };
  const spaces = activeSpaceListed
    ? listedSpaces
    : [activeSpaceFallback, ...listedSpaces];
  const accountPlan = session.accountPlan;
  const membershipExpiry = accountPlan?.membership?.expiresAt ?? null;
  const expiryDate = membershipExpiry ? new Date(membershipExpiry) : null;
  const expiryValid = Boolean(
    expiryDate && !Number.isNaN(expiryDate.getTime()),
  );
  const expiryMs = expiryValid ? expiryDate!.getTime() : null;
  const activePro = Boolean(
    accountPlan?.effectiveTier === "pro" &&
      accountPlan.membership?.status === "active" &&
      expiryValid &&
      expiryMs! > accountPlanViewedAt,
  );
  const daysRemaining =
    activePro && expiryValid
      ? Math.max(
          1,
          Math.ceil((expiryDate!.getTime() - accountPlanViewedAt) / 86_400_000),
        )
      : null;
  const membershipRevoked = accountPlan?.membership?.status === "revoked";
  const planDescription = membershipRevoked
    ? t("space.accountPlan.free")
    : activePro && expiryValid
      ? daysRemaining !== null && daysRemaining <= 7
        ? t("space.accountPlan.proDaysRemaining", { count: daysRemaining })
        : t("space.accountPlan.proUntil", {
            date: expiryDate!.toLocaleDateString(currentSupportedLocale(), {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          })
      : expiryValid &&
          (accountPlan?.membership?.status === "expired" ||
            expiryMs! <= accountPlanViewedAt)
        ? t("space.accountPlan.expiredAt", {
            date: expiryDate!.toLocaleDateString(currentSupportedLocale(), {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          })
        : t("space.accountPlan.free");
  useCloseLayer(() => {
    if (!accountMenuOpen) return false;
    setAccountMenuOpen(false);
    return true;
  }, 20);

  useEffect(() => {
    setExpandedSpaceId(activeSpaceId);
  }, [activeSpaceId]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (accountMenuRef.current?.contains(target)) return;
      setAccountMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!accountMenuOpen || expiryMs === null) return;
    const remainingMs = expiryMs - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(
      () => setAccountPlanViewedAt(Date.now()),
      Math.min(remainingMs + 50, 2_147_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [accountMenuOpen, expiryMs]);

  const toggleAccountMenu = () => {
    const nextOpen = !accountMenuOpen;
    setAccountMenuOpen(nextOpen);
    if (nextOpen) setAccountPlanViewedAt(Date.now());
    if (!nextOpen || !onRefreshAccountPlan || accountRefreshing) return;
    const lastValidatedAt = Date.parse(accountPlan?.evaluatedAt ?? "");
    const projectionAgeMs = Date.now() - lastValidatedAt;
    if (
      Number.isFinite(lastValidatedAt) &&
      projectionAgeMs >= 0 &&
      projectionAgeMs <= 60_000
    )
      return;
    setAccountRefreshing(true);
    void onRefreshAccountPlan()
      .catch(() => undefined)
      .finally(() => setAccountRefreshing(false));
  };

  const communityItemsFor = (space: SpaceListItem) => {
    const canManage =
      space.canManage === true ||
      space.membership.role === "owner" ||
      space.membership.role === "admin";
    const items: Array<{
      mode: SpaceViewMode;
      label: string;
      icon: typeof MessageSquare;
      badge?: number;
    }> = [
      { mode: "issues", label: t("space.sidebar.issues"), icon: MessageSquare },
      { mode: "goals", label: t("space.sidebar.goals"), icon: GitBranch },
      { mode: "skills", label: t("space.sidebar.skills"), icon: Package },
    ];
    if (canManage) {
      items.push({
        mode: "settings",
        label: t("space.sidebar.settings"),
        icon: Settings,
        badge: space.pendingJoinRequestCount,
      });
    }
    return items;
  };

  return (
    <aside className="grid w-64 shrink-0 grid-rows-[minmax(0,1fr)_auto] gap-3.5 border-r border-[var(--line)] bg-[var(--paper)]/70 p-3.5">
      <div className="min-h-0 overflow-y-auto">
        <div className="mb-2 grid gap-1.5">
          <button
            type="button"
            onClick={onJoinSpace}
            className="grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <UserPlus className="h-3.5 w-3.5" />
            <span className="truncate">
              {t("space.sidebar.joinSpace", { defaultValue: "加入空间" })}
            </span>
          </button>
          <button
            type="button"
            onClick={onCreateSpace}
            className="grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="truncate">
              {t("space.sidebar.createSpace", { defaultValue: "创建空间" })}
            </span>
          </button>
        </div>
        <ul className="mb-2.5 grid gap-1 border-b border-[var(--line-subtle)] pb-2.5">
          {spaces.map((space) => {
            const spaceId = space.id || space.slug;
            const selected =
              spaceId === activeSpaceId || space.slug === session.space.slug;
            const expanded = expandedSpaceId === spaceId;
            const displaySpace = selected ? session.space : space;
            const communityItems = communityItemsFor(space);
            const identity = (
              <>
                <SpaceIcon
                  name={displaySpace.name}
                  avatarUrl={spaceIconAvatarUrl(displaySpace)}
                  size={32}
                  className="shadow-sm"
                />
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-semibold text-[var(--ink)]">
                    {displaySpace.name}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs font-medium text-[var(--ink-muted)]">
                    {joinPolicyLabel(displaySpace.joinPolicy, t)}
                  </span>
                </span>
              </>
            );

            return (
              <li key={spaceId} className="min-w-0">
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedSpaceId((current) =>
                      current === spaceId ? null : spaceId,
                    )
                  }
                  className={`grid min-h-10 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${selected ? "hover:bg-[var(--paper-elevated)]/70" : "hover:bg-[var(--hover-bg)]"}`}
                >
                  {identity}
                  <ChevronDown
                    className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
                  />
                </button>
                {expanded ? (
                  <nav
                    className="mt-1 grid gap-1 border-t border-[var(--line-subtle)] pt-2 pl-5"
                    aria-label={displaySpace.name}
                  >
                    {communityItems.map((item) => {
                      const Icon = item.icon;
                      const itemSelected = selected && mode === item.mode;
                      return (
                        <button
                          key={item.mode}
                          type="button"
                          aria-label={item.label}
                          onClick={() => {
                            if (selected) {
                              onSpaceTabChange(item.mode);
                              return;
                            }
                            onSpaceSwitch(spaceId, item.mode);
                          }}
                          className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors ${itemSelected ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {"badge" in item && item.badge ? (
                            <span className="rounded-full bg-[var(--accent-warm-subtle)] px-1.5 text-xs text-[var(--accent-warm)]">
                              {item.badge}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </nav>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div
        ref={accountMenuRef}
        className="relative border-t border-[var(--line-subtle)] pt-3"
      >
        <button
          type="button"
          onClick={toggleAccountMenu}
          aria-expanded={accountMenuOpen}
          className="flex h-9 w-full items-center gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 px-2.5 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
        >
          <SpaceAvatar
            name={displayName}
            email={session.user.email}
            avatarUrl={session.user.avatarUrl}
            size={22}
          />
          <span className="min-w-0 flex-1 truncate">{displayName}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
        {accountMenuOpen ? (
          <div
            className="absolute bottom-full left-0 z-20 mb-2 w-[280px] max-w-[calc(100vw-28px)] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-2 shadow-md backdrop-blur-md"
            style={{ animation: "overlayPanelIn 160ms ease-out" }}
          >
            <div className="mb-1 border-b border-dashed border-[var(--line-subtle)] px-2 py-2.5">
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5">
                <SpaceAvatar
                  name={displayName}
                  email={session.user.email}
                  avatarUrl={session.user.avatarUrl}
                  size={40}
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold leading-tight text-[var(--ink)]">
                    {displayName}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs font-medium leading-tight text-[var(--ink-muted)]">
                    {session.user.email}
                  </span>
                </span>
                <span
                  className={`rounded-md px-2 py-1 text-xs font-semibold tracking-wide ${activePro ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]" : "bg-[var(--paper-inset)] text-[var(--ink-muted)]"}`}
                >
                  {activePro ? "PRO" : "FREE"}
                </span>
              </div>
              <div
                className={`mt-2.5 flex items-center gap-1.5 text-xs font-semibold ${activePro && daysRemaining !== null && daysRemaining <= 7 ? "text-[var(--warning)]" : "text-[var(--ink-muted)]"}`}
              >
                <span className="min-w-0 flex-1">{planDescription}</span>
                {accountRefreshing ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setAccountMenuOpen(false);
                onOpenProfileSettings();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Settings className="h-3.5 w-3.5" />
              {t("space.sidebar.settings")}
            </button>
            <button
              type="button"
              onClick={() => {
                setAccountMenuOpen(false);
                onLogout();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t("space.sidebar.logout")}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
