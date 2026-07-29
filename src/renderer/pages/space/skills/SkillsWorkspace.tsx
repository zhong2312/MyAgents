import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  Folder,
  Link,
  Loader2,
  MoreHorizontal,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";

import {
  spaceCleanupSkillExportPackages,
  spaceErrorMessage,
  spaceExportSkillFromUrl,
  spaceInspectSkillSource,
  isSpaceSkillInstallConflict,
  spaceListLocalSkills,
  type SpaceLocalSkill,
  type SpaceSkill,
  type SpaceSkillFile,
  type SpaceSkillSourceInspection,
  type SpaceSkillSourceMeta,
  type SpaceSkillUrlCandidate,
  type SpaceSkillUrlExportResponse,
  type SpaceSkillUrlPackage,
  type SpaceSkillUrlPreview,
} from "@/api/spaceCloud";
import ConfirmDialog from "@/components/ConfirmDialog";
import Markdown from "@/components/Markdown";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import type { Project } from "@/config/types";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useTauriFileDrop } from "@/hooks/useTauriFileDrop";
import { SpaceIdentityLine } from "@/pages/space/SpaceAvatar";
import {
  getSkillFileState,
  getSkillRevisionState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceSkillDetailState,
} from "@/pages/space/spaceStore";
import {
  SPACE_COLLECTION_FRAME_CLASS,
  SPACE_NARRATIVE_INSET_CLASS,
  SPACE_PRIMARY_TOOL_BUTTON_CLASS,
  SPACE_REFRESH_TOOL_BUTTON_CLASS,
  SPACE_TWO_COLUMN_GRID_CLASS,
  formatBytes,
  formatDate,
  formatFullTime,
  formatTime,
} from "@/pages/space/spaceUi";
import { openExternal } from "@/utils/openExternal";
import { createSkillFileTreeRows } from "./skillFileTree";

type SkillDetailMode = "entry" | "files" | "history";
const EMPTY_SKILL_FILES: SpaceSkillFile[] = [];

function skillSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function shortHash(value?: string | null): string {
  return value ? value.slice(0, 10) : "";
}

function skillSourcePrimary(source?: SpaceSkillSourceMeta | null): string {
  if (!source) return "";
  if (source.type === "github" && source.owner && source.repo) {
    return `${source.owner}/${source.repo}`;
  }
  return source.url;
}

function skillSourceSecondary(source?: SpaceSkillSourceMeta | null): string {
  if (!source) return "";
  const parts = [];
  const ref = source.effectiveRef || source.ref;
  if (ref) parts.push(`@${ref}`);
  if (source.rootPath) parts.push(source.rootPath);
  return parts.join(" · ");
}

function skillSourceKindLabel(
  source: SpaceSkillSourceMeta | null | undefined,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!source) return t("space.skills.sourceUrl");
  if (source.type === "github") return "GitHub";
  if (source.type === "raw_zip") return t("space.skills.sourceRawZip");
  return t("space.skills.sourceUrl");
}

export function SkillsWorkspace({
  admin,
  skills,
  loading,
  error,
  selectedSkillId,
  projects,
  actions,
  skillDetailState,
  isActive,
  remoteUpdateAvailable,
  onSelectSkill,
  onRefresh,
  onApplyRemoteUpdate,
  onUploaded,
}: {
  admin: boolean;
  skills: SpaceSkill[];
  loading: boolean;
  error: string | null;
  selectedSkillId: string | null;
  projects: Project[];
  actions: SpaceActions;
  skillDetailState?: SpaceSkillDetailState;
  isActive: boolean;
  remoteUpdateAvailable: boolean;
  onSelectSkill: (id: string | null) => void;
  onRefresh: () => Promise<void>;
  onApplyRemoteUpdate: () => Promise<void>;
  onUploaded: (id: string) => void;
}) {
  const { t } = useTranslation("app");
  const [detailMode, setDetailMode] = useState<SkillDetailMode>("entry");
  const [publishOpen, setPublishOpen] = useState(false);
  const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  const openSkill = (id: string) => {
    onSelectSkill(id);
    setDetailMode("entry");
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
          <Package className="h-4 w-4 shrink-0" />
          <span>Skills</span>
          <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
            {skills.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {admin && (
            <button
              type="button"
              onClick={() => setPublishOpen(true)}
              className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
            >
              <UploadCloud className="h-4 w-4" />
              {t("space.skills.publish")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onRefresh().catch(() => undefined)}
            className={SPACE_REFRESH_TOOL_BUTTON_CLASS}
            aria-label={t("space.common.refresh")}
            title={t("space.common.refresh")}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-10 pt-5">
        <section
          className={SPACE_COLLECTION_FRAME_CLASS}
          aria-label="Skill list"
        >
          {remoteUpdateAvailable ? (
            <button
              type="button"
              onClick={() => void onApplyRemoteUpdate().catch(() => undefined)}
              className="mb-3 flex min-h-9 w-full items-center justify-center gap-2 rounded-xl border border-[var(--accent-warm)]/20 bg-[var(--accent-warm-subtle)]/70 px-3 text-sm font-semibold text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("space.common.remoteUpdatesAvailable")}
            </button>
          ) : null}
          {error && skills.length > 0 ? (
            <div
              role="alert"
              className="mb-3 flex min-h-10 items-center gap-2 rounded-xl border border-[var(--warning)]/20 bg-[var(--warning-bg)] px-3 text-sm text-[var(--warning)]"
            >
              <CircleAlert className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 font-medium">
                {t("space.common.listRefreshFailed")}
              </span>
              <button
                type="button"
                onClick={() => void onRefresh().catch(() => undefined)}
                className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold transition-colors hover:bg-[var(--paper-elevated)]/60"
              >
                {t("space.common.retry")}
              </button>
            </div>
          ) : null}
          {skills.length === 0 && error ? (
            <div
              role="alert"
              className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--line-subtle)] bg-[var(--paper-elevated)]/55 text-sm text-[var(--ink-muted)]"
            >
              <div className="text-center">
                <CircleAlert className="mx-auto mb-2 h-7 w-7 text-[var(--warning)]" />
                <p>{t("space.common.listRefreshFailed")}</p>
                <button
                  type="button"
                  onClick={() => void onRefresh().catch(() => undefined)}
                  className="mt-3 inline-flex h-9 items-center rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                >
                  {t("space.common.retry")}
                </button>
              </div>
            </div>
          ) : skills.length === 0 && loading ? (
            <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3"
                >
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-32 rounded-md bg-[var(--paper-inset)]" />
                    <div className="h-5 w-12 rounded-md bg-[var(--paper-inset)]" />
                  </div>
                  <div className="mt-3 h-3 w-full rounded-md bg-[var(--paper-inset)]" />
                  <div className="mt-2 h-3 w-2/3 rounded-md bg-[var(--paper-inset)]" />
                  <div className="mt-3 h-3 w-56 rounded-md bg-[var(--paper-inset)]/70" />
                </div>
              ))}
            </div>
          ) : skills.length === 0 ? (
            <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-[var(--line-subtle)] bg-[var(--paper-elevated)]/55 text-sm text-[var(--ink-muted)]">
              <div className="text-center">
                <Package className="mx-auto mb-3 h-9 w-9 text-[var(--ink-subtle)]" />
                <p>{t("space.skills.empty")}</p>
                {admin && (
                  <button
                    type="button"
                    onClick={() => setPublishOpen(true)}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                  >
                    <UploadCloud className="h-4 w-4" />
                    {t("space.skills.publishSkill")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
              {skills.map((skill) => (
                <SpaceSkillCard
                  key={skill.id}
                  skill={skill}
                  onOpen={() => openSkill(skill.id)}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {selected && (
        <SkillDetailWorkspace
          skill={selected}
          mode={detailMode}
          admin={admin}
          projects={projects}
          actions={actions}
          detailState={skillDetailState}
          onModeChange={setDetailMode}
          onBack={() => onSelectSkill(null)}
          onDeleted={() => onSelectSkill(null)}
          t={t}
        />
      )}
      {publishOpen && (
        <PublishSkillDialog
          skills={skills}
          projects={projects}
          actions={actions}
          isActive={isActive}
          onClose={() => setPublishOpen(false)}
          onPublished={(skill) => {
            setPublishOpen(false);
            void actions
              .refreshSkills({ force: true, silent: true })
              .catch(() => undefined);
            onUploaded(skill.id);
            setDetailMode("entry");
          }}
          t={t}
        />
      )}
    </div>
  );
}

function SpaceSkillCard({
  skill,
  onOpen,
  t,
}: {
  skill: SpaceSkill;
  onOpen: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const uploader = skill.uploader;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 text-left transition-shadow hover:shadow-sm"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">
          {skill.name}
        </span>
      </span>
      <span className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">
        {skill.description || t("space.common.noDescription")}
      </span>
      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-[var(--ink-subtle)]">
        <SpaceIdentityLine
          name={
            uploader?.name ?? uploader?.id ?? t("space.skills.unknownUploader")
          }
          avatarUrl={uploader?.avatarUrl}
          avatarSize={18}
          nameClassName="font-semibold text-[var(--ink-muted)]"
        />
        <span className="text-[var(--line-strong)]">·</span>
        <span>
          <span
            title={formatFullTime(skill.updatedAt)}
            className="font-semibold text-[var(--ink-muted)]"
          >
            {formatTime(skill.updatedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

type PublishSourceMode = "local" | "file" | "url";
const SKILL_PUBLISH_FILE_DROP_ZONE_ID = "space-skill-publish-file";

function PublishSkillDialog({
  skills,
  projects,
  actions,
  isActive,
  onClose,
  onPublished,
  t,
}: {
  skills: SpaceSkill[];
  projects: Project[];
  actions: SpaceActions;
  isActive: boolean;
  onClose: () => void;
  onPublished: (skill: SpaceSkill) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const toast = useToast();
  const [mode, setMode] = useState<PublishSourceMode>("local");
  const [localSkills, setLocalSkills] = useState<SpaceLocalSkill[]>([]);
  const [localQuery, setLocalQuery] = useState("");
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceScopeLabel, setSourceScopeLabel] = useState("");
  const [sourceHasDangerousTools, setSourceHasDangerousTools] = useState(false);
  const [sourceMeta, setSourceMeta] = useState<SpaceSkillSourceMeta | null>(
    null,
  );
  const [inspection, setInspection] =
    useState<SpaceSkillSourceInspection | null>(null);
  const [publishAction, setPublishAction] = useState<"create" | "update">(
    "create",
  );
  const [newName, setNewName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlPreview, setUrlPreview] = useState<SpaceSkillUrlPreview | null>(
    null,
  );
  const [urlPackages, setUrlPackages] = useState<SpaceSkillUrlPackage[]>([]);
  const inspectSeqRef = useRef(0);
  const fileDropRef = useRef<HTMLDivElement | null>(null);
  const { isDragging, activeZoneId, registerZone, unregisterZone } =
    useTauriFileDrop({ enabled: isActive && mode === "file" });
  const fileDropActive =
    isDragging && activeZoneId === SKILL_PUBLISH_FILE_DROP_ZONE_ID;
  const urlPackagesRef = useRef<SpaceSkillUrlPackage[]>([]);

  useEffect(() => {
    urlPackagesRef.current = urlPackages;
  }, [urlPackages]);

  const cleanupUrlPackages = useCallback(
    (packages = urlPackagesRef.current) => {
      const paths = packages.map((item) => item.filePath);
      if (paths.length > 0) {
        void spaceCleanupSkillExportPackages(paths).catch(() => undefined);
      }
    },
    [],
  );

  const closeAndCleanup = useCallback(() => {
    cleanupUrlPackages();
    onClose();
  }, [cleanupUrlPackages, onClose]);

  useCloseLayer(() => {
    closeAndCleanup();
    return true;
  }, 240);

  useEffect(() => () => cleanupUrlPackages(), [cleanupUrlPackages]);

  useEffect(() => {
    let alive = true;
    setLoadingLocal(true);
    spaceListLocalSkills(projects)
      .then((items) => {
        if (!alive) return;
        setLocalSkills(items);
      })
      .catch((error) => toast.error(spaceErrorMessage(error)))
      .finally(() => {
        if (alive) setLoadingLocal(false);
      });
    return () => {
      alive = false;
    };
  }, [projects, toast]);

  const conflict = useMemo(() => {
    if (!inspection) return null;
    const slug = skillSlug(
      publishAction === "create" && newName.trim() ? newName : inspection.name,
    );
    return skills.find((skill) => skill.slug === slug) ?? null;
  }, [inspection, newName, publishAction, skills]);

  const filteredLocalSkills = useMemo(() => {
    const query = localQuery.trim().toLowerCase();
    if (!query) return localSkills;
    return localSkills.filter((skill) =>
      skill.name.toLowerCase().includes(query),
    );
  }, [localQuery, localSkills]);

  const clearSelectedSource = useCallback(() => {
    inspectSeqRef.current += 1;
    setSourcePath("");
    setSourceLabel("");
    setSourceScopeLabel("");
    setSourceHasDangerousTools(false);
    setSourceMeta(null);
    setInspection(null);
    setPublishAction("create");
    setNewName("");
  }, []);

  const changePublishMode = useCallback(
    (nextMode: PublishSourceMode) => {
      if (nextMode === mode) return;
      clearSelectedSource();
      setMode(nextMode);
    },
    [clearSelectedSource, mode],
  );

  const inspectPath = useCallback(
    async (
      path: string,
      label: string,
      scopeLabel: string,
      hasDangerousTools = false,
      source: SpaceSkillSourceMeta | null = null,
    ) => {
      const seq = ++inspectSeqRef.current;
      setSourcePath("");
      setSourceLabel(label);
      setSourceScopeLabel(scopeLabel);
      setSourceHasDangerousTools(false);
      setSourceMeta(null);
      setInspection(null);
      setNewName("");
      setPublishAction("create");
      try {
        const result = await spaceInspectSkillSource(path);
        if (seq !== inspectSeqRef.current) return;
        setSourcePath(path);
        setSourceLabel(label);
        setSourceScopeLabel(scopeLabel);
        setSourceHasDangerousTools(hasDangerousTools);
        setSourceMeta(source);
        setInspection(result);
        setNewName(result.name);
        const nextConflict =
          skills.find((skill) => skill.slug === skillSlug(result.name)) ?? null;
        setPublishAction(nextConflict ? "update" : "create");
      } catch (error) {
        if (seq !== inspectSeqRef.current) return;
        setSourcePath("");
        setSourceHasDangerousTools(false);
        setSourceMeta(null);
        setInspection(null);
        setNewName("");
        toast.error(spaceErrorMessage(error));
      }
    },
    [skills, toast],
  );

  useEffect(() => {
    if (mode !== "file") return;
    registerZone(
      SKILL_PUBLISH_FILE_DROP_ZONE_ID,
      fileDropRef.current,
      (paths) => {
        const selectedPath = paths[0];
        if (!selectedPath) return;
        if (paths.length > 1) {
          toast.error(t("space.skills.singleSourceOnly"));
        }
        void inspectPath(
          selectedPath,
          selectedPath.split(/[\\/]/).pop() || selectedPath,
          t("space.skills.sourceFileOrFolder"),
        );
      },
    );
    return () => unregisterZone(SKILL_PUBLISH_FILE_DROP_ZONE_ID);
  }, [inspectPath, mode, registerZone, t, toast, unregisterZone]);

  const inspectUrlPackage = async (item: SpaceSkillUrlPackage) => {
    await inspectPath(
      item.filePath,
      item.rootPath || item.suggestedFolderName,
      skillSourceKindLabel(item.source, t),
      item.hasDangerousTools,
      item.source ?? null,
    );
  };

  const applyUrlResponse = async (result: SpaceSkillUrlExportResponse) => {
    if (!result.success) {
      setUrlError(result.error || t("space.skills.urlImportFailed"));
      return;
    }
    setUrlError(null);
    if (result.mode === "exported" && result.packages?.length) {
      setUrlPreview(null);
      cleanupUrlPackages();
      setUrlPackages(result.packages);
      if (result.packages.length === 1) {
        await inspectUrlPackage(result.packages[0]);
      }
      return;
    }
    if (result.preview) {
      setUrlPreview(result.preview);
      cleanupUrlPackages();
      setUrlPackages([]);
      return;
    }
    setUrlError(t("space.skills.urlImportFailed"));
  };

  const probeUrl = async () => {
    if (!urlValue.trim() || urlLoading) return;
    setUrlLoading(true);
    setUrlError(null);
    setUrlPreview(null);
    cleanupUrlPackages();
    setUrlPackages([]);
    clearSelectedSource();
    try {
      const result = await spaceExportSkillFromUrl({ url: urlValue.trim() });
      await applyUrlResponse(result);
    } catch (error) {
      setUrlError(spaceErrorMessage(error));
    } finally {
      setUrlLoading(false);
    }
  };

  const exportUrlCandidate = async (selection: {
    pluginName?: string;
    folderNames: string[];
  }) => {
    if (!urlValue.trim() || urlLoading) return;
    setUrlLoading(true);
    setUrlError(null);
    try {
      const result = await spaceExportSkillFromUrl({
        url: urlValue.trim(),
        confirmedSelection: selection,
      });
      await applyUrlResponse(result);
    } catch (error) {
      setUrlError(spaceErrorMessage(error));
    } finally {
      setUrlLoading(false);
    }
  };

  const chooseFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: t("space.skills.pickPublishFileTitle"),
        filters: [{ name: "Skill", extensions: ["zip", "skill", "md"] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setMode("file");
      await inspectPath(
        selectedPath,
        selectedPath.split(/[\\/]/).pop() || selectedPath,
        t("space.skills.sourceFile"),
      );
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const chooseFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selectedPath = await open({
        multiple: false,
        directory: true,
        title: t("space.skills.pickPublishFolderTitle"),
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setMode("file");
      await inspectPath(
        selectedPath,
        selectedPath.split(/[\\/]/).pop() || selectedPath,
        t("space.skills.sourceFolder"),
      );
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const publish = async () => {
    if (!inspection || !sourcePath) return;
    if (publishAction === "create" && conflict) {
      toast.error(t("space.toasts.skillNameConflict"));
      return;
    }
    setPublishing(true);
    try {
      const targetName =
        publishAction === "create"
          ? newName.trim() || inspection.name
          : undefined;
      const result =
        publishAction === "update" && conflict
          ? await actions.uploadSkillRevision(
              conflict.id,
              sourcePath,
              sourceMeta,
            )
          : await actions.uploadSkillZip({
              filePath: sourcePath,
              name: targetName,
              description: inspection.description ?? undefined,
              source: sourceMeta,
            });
      cleanupUrlPackages();
      setUrlPackages([]);
      toast.success(t("space.toasts.skillPublished", { name: result.name }));
      onPublished(result);
    } catch (error) {
      const message = spaceErrorMessage(error);
      if (String(error).includes("SKILL_SLUG_CONFLICT")) {
        await actions
          .refreshSkills({ force: true, silent: true })
          .catch(() => undefined);
        setPublishAction("update");
        toast.error(t("space.skills.concurrentConflictResolved"));
        return;
      }
      toast.error(message);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <OverlayBackdrop
      onClose={closeAndCleanup}
      className="z-[240] items-center justify-center bg-black/25 backdrop-blur-sm"
    >
      <section className="relative flex h-[min(88vh,780px)] max-h-[calc(100vh-40px)] w-[min(92vw,960px)] flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex min-h-14 items-center gap-3 border-b border-[var(--line)] px-5">
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-[var(--ink)]">
            {t("space.skills.publishTitle")}
          </h2>
          <button
            type="button"
            onClick={closeAndCleanup}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t("space.detail.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="border-r border-[var(--line)] bg-[var(--paper)]/55 p-3 max-md:border-b max-md:border-r-0">
            <div className="grid gap-1">
              {(
                [
                  ["local", Search, t("space.skills.publishFromLocal")],
                  ["file", UploadCloud, t("space.skills.publishFromFile")],
                  ["url", Link, t("space.skills.publishFromUrl")],
                ] as const
              ).map(([value, Icon, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => changePublishMode(value)}
                  className={`flex h-10 items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold transition-colors ${mode === value ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </aside>

          <main className="relative min-h-0 overflow-hidden p-5">
            <div
              className={`h-full min-h-0 overflow-y-auto pr-1 ${inspection ? "pb-60" : ""}`}
            >
              {mode === "local" && (
                <section className="grid min-h-0 gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-base font-semibold text-[var(--ink)]">
                      {t("space.skills.localSkills")}
                    </h3>
                    <div className="flex min-w-56 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5">
                      <Search className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
                      <input
                        value={localQuery}
                        onChange={(event) => setLocalQuery(event.target.value)}
                        placeholder={t("space.skills.localSearchPlaceholder")}
                        className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-subtle)]"
                      />
                      {loadingLocal && (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ink-muted)]" />
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2">
                    {filteredLocalSkills.map((skill) => (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() =>
                          void inspectPath(
                            skill.path,
                            skill.name,
                            skill.scope === "project"
                              ? skill.workspaceLabel ||
                                  t("space.skills.sourceProject")
                              : t("space.skills.sourceGlobal"),
                          )
                        }
                        className={`rounded-lg border px-3 py-2 text-left transition-colors ${sourcePath === skill.path ? "border-[var(--ink)] bg-[var(--paper)]" : "border-[var(--line-subtle)] bg-[var(--paper-elevated)] hover:border-[var(--line)]"}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">
                            {skill.name}
                          </span>
                          <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
                            {skill.scope === "project"
                              ? skill.workspaceLabel ||
                                t("space.skills.sourceProject")
                              : t("space.skills.sourceGlobal")}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-xs font-medium text-[var(--ink-subtle)]">
                          {skill.path}
                        </p>
                      </button>
                    ))}
                    {!loadingLocal && localSkills.length === 0 && (
                      <div className="rounded-lg border border-dashed border-[var(--line-subtle)] px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                        {t("space.skills.noLocalSkills")}
                      </div>
                    )}
                    {!loadingLocal &&
                      localSkills.length > 0 &&
                      filteredLocalSkills.length === 0 && (
                        <div className="rounded-lg border border-dashed border-[var(--line-subtle)] px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                          {t("space.skills.noMatchingLocalSkills")}
                        </div>
                      )}
                  </div>
                </section>
              )}

              {mode === "file" && (
                <section
                  ref={fileDropRef}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => event.preventDefault()}
                  className={`grid min-h-64 place-items-center rounded-lg border border-dashed px-4 py-10 text-center transition-colors ${fileDropActive ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]" : "border-[var(--line-subtle)] bg-[var(--paper)]/45"}`}
                >
                  <div className="max-w-md">
                    <UploadCloud className="mx-auto mb-3 h-8 w-8 text-[var(--ink-subtle)]" />
                    <h3 className="text-base font-semibold text-[var(--ink)]">
                      {t("space.skills.dropSkillSource")}
                    </h3>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                      {t("space.skills.dropSkillSourceHint")}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => void chooseFile()}
                        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                      >
                        <UploadCloud className="h-4 w-4" />
                        {t("space.skills.chooseSkillFile")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void chooseFolder()}
                        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                      >
                        <Folder className="h-4 w-4" />
                        {t("space.skills.chooseSkillFolder")}
                      </button>
                    </div>
                    <p className="mt-3 text-xs font-medium text-[var(--ink-subtle)]">
                      {t("space.skills.supportedSourceFormats")}
                    </p>
                  </div>
                </section>
              )}

              {mode === "url" && (
                <section className="grid gap-3">
                  <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)]/45 p-3">
                    <textarea
                      value={urlValue}
                      onChange={(event) => setUrlValue(event.target.value)}
                      rows={4}
                      placeholder={t("space.skills.urlInputPlaceholder")}
                      className="w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 font-mono text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink)]"
                    />
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        disabled={!urlValue.trim() || urlLoading}
                        onClick={() => void probeUrl()}
                        className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {urlLoading && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        {t("space.skills.analyzeUrl")}
                      </button>
                    </div>
                  </div>
                  {urlError && (
                    <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error)]">
                      {urlError}
                    </div>
                  )}
                  {urlPreview?.mode === "multi" && (
                    <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
                      <p className="text-sm font-semibold text-[var(--ink-secondary)]">
                        {t("space.skills.urlCandidates")}
                      </p>
                      {urlPreview.candidates.map((candidate) => (
                        <UrlCandidateButton
                          key={`${candidate.suggestedFolderName}:${candidate.rootPath}`}
                          candidate={candidate}
                          disabled={urlLoading}
                          onSelect={() =>
                            void exportUrlCandidate({
                              folderNames: [candidate.suggestedFolderName],
                            })
                          }
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                  {urlPreview?.mode === "marketplace" && (
                    <div className="grid max-h-72 gap-3 overflow-y-auto pr-1">
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink-secondary)]">
                          {urlPreview.marketplaceName}
                        </p>
                        {urlPreview.marketplaceDescription && (
                          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                            {urlPreview.marketplaceDescription}
                          </p>
                        )}
                      </div>
                      {urlPreview.plugins.map((plugin) => (
                        <div
                          key={plugin.name}
                          className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-elevated)] p-3"
                        >
                          <div className="mb-2">
                            <p className="text-sm font-semibold text-[var(--ink)]">
                              {plugin.name}
                            </p>
                            {plugin.description && (
                              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                                {plugin.description}
                              </p>
                            )}
                          </div>
                          <div className="grid gap-2">
                            {plugin.skills.map((candidate) => (
                              <UrlCandidateButton
                                key={`${plugin.name}:${candidate.suggestedFolderName}:${candidate.rootPath}`}
                                candidate={candidate}
                                disabled={urlLoading}
                                onSelect={() =>
                                  void exportUrlCandidate({
                                    pluginName: plugin.name,
                                    folderNames: [
                                      candidate.suggestedFolderName,
                                    ],
                                  })
                                }
                                t={t}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {urlPackages.length > 1 && (
                    <div className="grid gap-2">
                      <p className="text-sm font-semibold text-[var(--ink-secondary)]">
                        {t("space.skills.preparedUrlPackages")}
                      </p>
                      {urlPackages.map((item) => (
                        <button
                          key={item.tempId}
                          type="button"
                          onClick={() => void inspectUrlPackage(item)}
                          className={`rounded-lg border px-3 py-2 text-left transition-colors ${sourcePath === item.filePath ? "border-[var(--ink)] bg-[var(--paper)]" : "border-[var(--line-subtle)] bg-[var(--paper-elevated)] hover:border-[var(--line)]"}`}
                        >
                          <span className="block truncate text-sm font-semibold text-[var(--ink)]">
                            {item.name}
                          </span>
                          <span className="mt-1 block truncate text-xs font-medium text-[var(--ink-subtle)]">
                            {item.rootPath || item.suggestedFolderName}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>

            {inspection && (
              <PublishInspectionDock
                inspection={inspection}
                sourceLabel={sourceLabel}
                sourceScopeLabel={sourceScopeLabel}
                sourceHasDangerousTools={sourceHasDangerousTools}
                conflict={conflict}
                publishAction={publishAction}
                newName={newName}
                onPublishActionChange={setPublishAction}
                onNewNameChange={setNewName}
                onClose={clearSelectedSource}
                t={t}
              />
            )}
          </main>
        </div>

        <footer className="flex min-h-14 justify-end gap-2 border-t border-[var(--line)] px-5 py-2.5">
          <button
            type="button"
            onClick={closeAndCleanup}
            className="h-9 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            {t("space.common.cancel")}
          </button>
          <button
            type="button"
            disabled={
              !inspection ||
              publishing ||
              (publishAction === "create" && Boolean(conflict))
            }
            onClick={() => void publish()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {publishing && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("space.skills.publish")}
          </button>
        </footer>
      </section>
    </OverlayBackdrop>
  );
}

function PublishInspectionDock({
  inspection,
  sourceLabel,
  sourceScopeLabel,
  sourceHasDangerousTools,
  conflict,
  publishAction,
  newName,
  onPublishActionChange,
  onNewNameChange,
  onClose,
  t,
}: {
  inspection: SpaceSkillSourceInspection;
  sourceLabel: string;
  sourceScopeLabel: string;
  sourceHasDangerousTools: boolean;
  conflict: SpaceSkill | null;
  publishAction: "create" | "update";
  newName: string;
  onPublishActionChange: (action: "create" | "update") => void;
  onNewNameChange: (value: string) => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <section className="absolute inset-x-5 bottom-4 z-10 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-3.5 shadow-xl backdrop-blur-md">
      <header className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-[var(--ink)]">
              {inspection.name}
            </h3>
            <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
              {sourceScopeLabel}
            </span>
            {sourceHasDangerousTools && (
              <span className="shrink-0 rounded-md bg-[var(--warning-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
                {t("space.skills.dangerousTools")}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-[var(--ink-muted)]">
            {inspection.description || t("space.common.noDescription")}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <div className="pt-0.5 text-right text-xs font-semibold text-[var(--ink-subtle)]">
            <div>{formatBytes(inspection.packageSizeBytes)}</div>
            <div>{shortHash(inspection.packageHash)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t("space.detail.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-[var(--ink-muted)]">
        <span className="shrink-0">
          {t("space.skills.filesCount", { count: inspection.fileCount })}
        </span>
        <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--line-strong)]" />
        <span className="min-w-0 flex-1 truncate">{sourceLabel}</span>
      </div>
      {conflict && (
        <p className="mt-2 truncate text-xs font-semibold text-[var(--warning)]">
          {t("space.skills.conflictWith", { name: conflict.name })}
        </p>
      )}

      <div className="mt-3 grid gap-2">
        <label
          className={`grid min-h-10 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors max-md:grid-cols-1 ${publishAction === "create" ? "border-[var(--ink)] bg-[var(--paper)] text-[var(--ink)]" : "border-[var(--line-subtle)] text-[var(--ink-secondary)] hover:border-[var(--line)] hover:bg-[var(--paper)]/65"}`}
        >
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <input
              type="radio"
              checked={publishAction === "create"}
              onChange={() => onPublishActionChange("create")}
              className="accent-[var(--ink)]"
            />
            <span className="truncate">{t("space.skills.publishAsNew")}</span>
          </span>
          <input
            value={newName}
            onFocus={() => onPublishActionChange("create")}
            onChange={(event) => onNewNameChange(event.target.value)}
            className="h-8 min-w-0 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-sm font-medium text-[var(--ink)] outline-none transition-colors focus:border-[var(--ink)]"
          />
        </label>

        {conflict && (
          <label
            className={`grid min-h-10 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors max-md:grid-cols-1 ${publishAction === "update" ? "border-[var(--ink)] bg-[var(--paper)] text-[var(--ink)]" : "border-[var(--line-subtle)] text-[var(--ink-secondary)] hover:border-[var(--line)] hover:bg-[var(--paper)]/65"}`}
          >
            <span className="flex min-w-0 items-center gap-2 font-semibold">
              <input
                type="radio"
                checked={publishAction === "update"}
                onChange={() => onPublishActionChange("update")}
                className="accent-[var(--ink)]"
              />
              <span className="truncate">
                {t("space.skills.publishAsUpdate", {
                  version: conflict.latestRevision + 1,
                })}
              </span>
            </span>
            <span className="min-w-0 truncate text-xs font-semibold text-[var(--ink-muted)]">
              {conflict.name}
            </span>
          </label>
        )}
      </div>
    </section>
  );
}

function UrlCandidateButton({
  candidate,
  disabled,
  onSelect,
  t,
}: {
  candidate: SpaceSkillUrlCandidate;
  disabled: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-3 py-2 text-left transition-colors hover:border-[var(--line)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">
          {candidate.name}
        </span>
        {candidate.hasDangerousTools && (
          <span className="shrink-0 rounded-md bg-[var(--warning-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">
            {t("space.skills.dangerousTools")}
          </span>
        )}
      </div>
      {candidate.description && (
        <p className="mt-1 line-clamp-2 text-xs text-[var(--ink-muted)]">
          {candidate.description}
        </p>
      )}
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs font-medium text-[var(--ink-subtle)]">
        <span className="truncate">
          {candidate.rootPath || candidate.suggestedFolderName}
        </span>
        <span className="shrink-0 text-[var(--ink)]">
          {t("space.skills.selectCandidate")}
        </span>
      </div>
    </button>
  );
}

function isRootFile(file: SpaceSkillFile, name: string): boolean {
  return (
    !file.isDir &&
    file.parentPath === "" &&
    file.name.toLowerCase() === name.toLowerCase()
  );
}

function findEntryFile(files: SpaceSkillFile[]): SpaceSkillFile | null {
  return (
    files.find((file) => isRootFile(file, "SKILL.md")) ??
    files.find((file) => isRootFile(file, "README.md")) ??
    null
  );
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function SkillMarkdownDocument({ text }: { text: string }) {
  return (
    <div className="ai-message-content text-[var(--ink-secondary)]">
      <Markdown raw>{stripFrontmatter(text)}</Markdown>
    </div>
  );
}

function SkillDetailWorkspace({
  skill,
  mode,
  admin,
  projects,
  actions,
  detailState,
  onModeChange,
  onBack,
  onDeleted,
  t,
}: {
  skill: SpaceSkill;
  mode: SkillDetailMode;
  admin: boolean;
  projects: Project[];
  actions: SpaceActions;
  detailState?: SpaceSkillDetailState;
  onModeChange: (mode: SkillDetailMode) => void;
  onBack: () => void;
  onDeleted: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const toast = useToast();
  const [previewPath, setPreviewPath] = useState("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [installingTarget, setInstallingTarget] = useState<
    "global" | "project" | null
  >(null);
  const [installConflict, setInstallConflict] = useState<{
    target: "global" | "project";
    workspacePath?: string;
  } | null>(null);
  const [revisionUploading, setRevisionUploading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [expandedFileTreePaths, setExpandedFileTreePaths] = useState<
    Set<string>
  >(() => new Set());
  const workspaceMenuRef = useRef<HTMLSpanElement | null>(null);
  const adminMenuRef = useRef<HTMLSpanElement | null>(null);
  const detail = detailState?.detail ?? null;
  const detailLoading = detailState?.isLoading ?? true;
  const files = detail?.files ?? EMPTY_SKILL_FILES;
  const entryFile = useMemo(() => findEntryFile(files), [files]);
  const fileTreeRows = useMemo(
    () => createSkillFileTreeRows(files, expandedFileTreePaths),
    [expandedFileTreePaths, files],
  );
  const activeMode: SkillDetailMode =
    mode === "history" ? "history" : entryFile ? mode : "files";
  const previewFile =
    activeMode === "files" && previewPath
      ? (files.find((file) => file.path === previewPath && !file.isDir) ?? null)
      : null;
  const activeFile = activeMode === "entry" ? entryFile : previewFile;
  const activePath = activeFile?.path ?? "";
  const fileState = activePath ? getSkillFileState(skill.id, activePath) : null;
  const fileLoading = fileState?.isLoading ?? false;
  const fileText = fileState?.text ?? "";
  const revisionState = getSkillRevisionState(skill.id);
  const history = revisionState?.history ?? null;

  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        value: project.path,
        label: project.displayName || project.name,
      })),
    [projects],
  );
  const hasProjects = projectOptions.length > 0;

  useEffect(() => {
    setPreviewPath("");
    setExpandedFileTreePaths(new Set());
    setWorkspaceMenuOpen(false);
    setAdminMenuOpen(false);
    setInstallConflict(null);
    void actions
      .refreshSkillDetail(skill.id, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS })
      .catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, skill.id, toast]);

  useEffect(() => {
    if (!detail || entryFile || mode !== "entry") return;
    onModeChange("files");
  }, [detail, entryFile, mode, onModeChange]);

  useEffect(() => {
    if (!activePath) return;
    void actions
      .refreshSkillFile(skill.id, activePath, {
        maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
      })
      .catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, activePath, skill.id, toast]);

  useEffect(() => {
    if (activeMode !== "history") return;
    void actions
      .refreshSkillRevisions(skill.id, {
        maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
      })
      .catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, activeMode, skill.id, toast]);

  useEffect(() => {
    if (!workspaceMenuOpen && !adminMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        workspaceMenuOpen &&
        workspaceMenuRef.current &&
        !workspaceMenuRef.current.contains(target)
      ) {
        setWorkspaceMenuOpen(false);
      }
      if (
        adminMenuOpen &&
        adminMenuRef.current &&
        !adminMenuRef.current.contains(target)
      ) {
        setAdminMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [adminMenuOpen, workspaceMenuOpen]);

  const changeMode = (nextMode: SkillDetailMode) => {
    setPreviewPath("");
    setWorkspaceMenuOpen(false);
    setAdminMenuOpen(false);
    onModeChange(nextMode);
  };

  const toggleFileTreeFolder = useCallback((path: string) => {
    setExpandedFileTreePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const install = async (
    target: "global" | "project",
    workspacePath?: string,
    overwrite = false,
  ) => {
    if (target === "project" && !workspacePath) {
      toast.error(t("space.toasts.selectWorkspace"));
      return;
    }
    setInstallingTarget(target);
    try {
      const result = await actions.installSkill({
        skillId: skill.id,
        skillName: skill.name,
        target,
        workspacePath,
        overwrite,
      });
      setInstallConflict(null);
      toast.success(
        t("space.toasts.skillInstalled", { target: result.target }),
      );
    } catch (error) {
      if (!overwrite && isSpaceSkillInstallConflict(error)) {
        setInstallConflict({ target, workspacePath });
      } else {
        toast.error(spaceErrorMessage(error));
      }
    } finally {
      setInstallingTarget(null);
    }
  };

  const uploadRevision = async () => {
    setAdminMenuOpen(false);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: t("space.skills.pickRevisionZipTitle"),
        filters: [{ name: "Skill", extensions: ["zip", "skill", "md"] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setRevisionUploading(true);
      const result = await actions.uploadSkillRevision(skill.id, selectedPath);
      toast.success(
        t("space.toasts.skillRevisionUploaded", {
          revision: result.latestRevision,
        }),
      );
      await Promise.all([
        actions.refreshSkills({ force: true, silent: true }),
        actions.refreshSkillDetail(skill.id, { force: true, silent: true }),
        activeMode === "history"
          ? actions.refreshSkillRevisions(skill.id, {
              force: true,
              silent: true,
            })
          : Promise.resolve(),
      ]);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setRevisionUploading(false);
    }
  };

  const deleteSkill = async () => {
    setAdminMenuOpen(false);
    setDeleting(true);
    try {
      await actions.deleteSkill(skill.id);
      toast.success(t("space.toasts.skillDeleted"));
      setDeleteConfirmOpen(false);
      onDeleted();
      await actions.refreshSkills({ force: true, silent: true });
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  const rollback = async () => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      const result = await actions.rollbackSkill(skill.id, rollbackTarget);
      toast.success(
        t("space.toasts.skillRolledBack", { revision: result.currentRevision }),
      );
      setRollbackTarget(null);
      await Promise.all([
        actions.refreshSkills({ force: true, silent: true }),
        actions.refreshSkillDetail(skill.id, { force: true, silent: true }),
        actions.refreshSkillRevisions(skill.id, { force: true, silent: true }),
      ]);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setRollingBack(false);
    }
  };

  useCloseLayer(() => {
    onBack();
    return true;
  }, 230);

  const renderFilePreview = () => {
    if (!previewFile) return null;
    return (
      <section className="overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]">
        <header className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--line-subtle)] px-3.5">
          <button
            type="button"
            onClick={() => setPreviewPath("")}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("space.skills.backToFiles")}
          </button>
          <div className="min-w-0 text-center">
            <div className="truncate text-sm font-semibold text-[var(--ink)]">
              {previewFile.path}
            </div>
            <div className="text-xs font-medium text-[var(--ink-subtle)]">
              {formatBytes(previewFile.sizeBytes)}
            </div>
          </div>
          <FileText className="h-4 w-4 text-[var(--ink-subtle)]" />
        </header>
        <div className="min-h-[460px] bg-[var(--paper-elevated)]">
          {fileLoading ? (
            <div className="flex min-h-[360px] items-center justify-center text-sm text-[var(--ink-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("space.skills.loadingFile")}
            </div>
          ) : fileState?.error ? (
            <div className="flex min-h-[360px] items-center justify-center px-8 text-sm text-[var(--ink-muted)]">
              {fileState.error}
            </div>
          ) : (
            <pre className="max-h-[64vh] min-h-[460px] overflow-auto whitespace-pre p-5 font-mono text-sm leading-6 text-[var(--ink-secondary)]">
              {fileText}
            </pre>
          )}
        </div>
      </section>
    );
  };

  const renderFilesList = () => (
    <section>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-[var(--ink)]">
          {t("space.skills.packageContents")}
        </h3>
        <span className="text-sm font-medium text-[var(--ink-muted)]">
          {t("space.skills.totalFiles", { count: files.length })}
        </span>
      </header>
      <div className="mt-3 overflow-hidden rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 p-1.5">
        {fileTreeRows.map(({ file, depth, hasChildren, isExpanded }) => {
          const isEntry = entryFile?.path === file.path;
          const isSelected = previewPath === file.path;
          if (file.isDir) {
            return (
              <button
                key={file.id}
                type="button"
                onClick={() => {
                  if (hasChildren) toggleFileTreeFolder(file.path);
                }}
                aria-expanded={hasChildren ? isExpanded : undefined}
                className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm transition-colors ${
                  hasChildren
                    ? "hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    : "cursor-default opacity-80"
                }`}
              >
                <span
                  className="flex min-w-0 flex-1 items-center gap-2.5"
                  style={{ paddingLeft: `${depth * 1.25}rem` }}
                >
                  {hasChildren ? (
                    isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-subtle)]" />
                    )
                  ) : (
                    <span className="h-4 w-4 shrink-0" />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  <span className="min-w-0 truncate font-semibold text-[var(--ink-secondary)]">
                    {file.name}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-[var(--ink-muted)]" />
              </button>
            );
          }
          return (
            <button
              key={file.id}
              type="button"
              onClick={() => setPreviewPath(file.path)}
              className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm transition-colors ${
                isSelected
                  ? "bg-[var(--paper-inset)] text-[var(--ink)]"
                  : "hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              }`}
            >
              <span
                className="flex min-w-0 flex-1 items-center gap-2.5"
                style={{ paddingLeft: `${depth * 1.25 + 1.625}rem` }}
              >
                <FileText className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                <span
                  className={`min-w-0 truncate font-medium ${isSelected ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"}`}
                >
                  {file.name}
                </span>
                {isEntry && (
                  <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
                    {t("space.skills.mainFile")}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm font-medium text-[var(--ink-muted)]">
                {formatBytes(file.sizeBytes)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );

  const renderEntryDocument = () => {
    if (!entryFile) return null;
    return (
      <article className="rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)] px-6 py-5 max-sm:px-5">
        {fileLoading ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("space.skills.loadingFile")}
          </div>
        ) : fileState?.error ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-[var(--ink-muted)]">
            {fileState.error}
          </div>
        ) : (
          <SkillMarkdownDocument text={fileText} />
        )}
      </article>
    );
  };

  const renderHistory = () => (
    <section>
      {revisionState?.isLoading && !history ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-[var(--ink-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t("space.skills.loadingHistory")}
        </div>
      ) : revisionState?.error ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-[var(--ink-muted)]">
          {revisionState.error}
        </div>
      ) : (
        <div className="grid gap-2">
          {(history?.items ?? []).map((revision) => (
            <div
              key={revision.id}
              className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-3 py-2"
            >
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-sm font-semibold text-[var(--ink)]">
                v{revision.revision}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                  <SpaceIdentityLine
                    name={
                      revision.uploader?.name ??
                      revision.uploader?.id ??
                      t("space.skills.unknownUploader")
                    }
                    avatarUrl={revision.uploader?.avatarUrl}
                    avatarSize={18}
                    nameClassName="font-semibold text-[var(--ink-muted)]"
                  />
                  <span className="text-[var(--line-strong)]">·</span>
                  <span>{formatDate(revision.createdAt)}</span>
                  {revision.packageHash && (
                    <>
                      <span className="text-[var(--line-strong)]">·</span>
                      <span>{shortHash(revision.packageHash)}</span>
                    </>
                  )}
                </div>
              </div>
              {revision.isCurrent ? (
                <span className="rounded-md bg-[var(--success-bg)] px-2 py-1 text-xs font-semibold text-[var(--success)]">
                  {t("space.skills.currentVersion")}
                </span>
              ) : admin ? (
                <button
                  type="button"
                  onClick={() => setRollbackTarget(revision.revision)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-xs font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("space.skills.rollback")}
                </button>
              ) : null}
            </div>
          ))}
          {history && history.items.length === 0 && (
            <div className="py-10 text-center text-sm text-[var(--ink-muted)]">
              {t("space.skills.noHistory")}
            </div>
          )}
        </div>
      )}
    </section>
  );

  return (
    <>
      <OverlayBackdrop
        onClose={onBack}
        className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm"
      >
        <aside className="relative h-full w-[min(78vw,1180px)] border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
          <header className="absolute right-4 top-4 z-10 flex justify-end">
            <button
              type="button"
              onClick={onBack}
              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t("space.detail.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <section className="h-full min-h-0 overflow-y-auto px-12 py-11 max-lg:px-8 max-sm:px-5">
            <div className="mx-auto max-w-[900px] pb-8">
              <section className="border-b border-[var(--line-subtle)] pb-5">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                  <SpaceIdentityLine
                    name={
                      skill.uploader?.name ??
                      skill.uploader?.id ??
                      t("space.skills.unknownUploader")
                    }
                    avatarUrl={skill.uploader?.avatarUrl}
                    avatarSize={20}
                    nameClassName="font-semibold text-[var(--ink-subtle)]"
                  />
                  <span className="text-[var(--line-strong)]">·</span>
                  <span>{formatDate(skill.createdAt)}</span>
                  <span className="min-w-0 flex-1" />
                  {admin && (
                    <span ref={adminMenuRef} className="relative">
                      <button
                        type="button"
                        disabled={revisionUploading || deleting}
                        onClick={() => setAdminMenuOpen((open) => !open)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                        aria-label={t("space.skills.moreActions")}
                        title={t("space.skills.moreActions")}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {adminMenuOpen && (
                        <span className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                          <button
                            type="button"
                            disabled={revisionUploading || deleting}
                            onClick={() => void uploadRevision()}
                            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-wait disabled:opacity-60"
                          >
                            {revisionUploading ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <UploadCloud className="h-4 w-4" />
                            )}
                            {t("space.skills.updateRevision")}
                          </button>
                          <button
                            type="button"
                            disabled={revisionUploading || deleting}
                            onClick={() => {
                              setAdminMenuOpen(false);
                              setDeleteConfirmOpen(true);
                            }}
                            className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-wait disabled:opacity-60"
                          >
                            {deleting ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                            {t("space.skills.delete")}
                          </button>
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="mt-3 min-w-0">
                  <h2 className="max-w-[68ch] text-xl font-semibold leading-snug text-[var(--ink)]">
                    {skill.name}
                  </h2>
                  <p
                    className={`mt-2 max-w-[72ch] whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)] ${SPACE_NARRATIVE_INSET_CLASS}`}
                  >
                    {skill.description || t("space.common.noDescription")}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-[var(--ink-muted)]">
                    <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1">
                      v{skill.currentRevision}
                    </span>
                    {skill.currentRevision !== skill.latestRevision && (
                      <span className="rounded-md bg-[var(--accent-warm-subtle)] px-2 py-1 text-[var(--accent-warm)]">
                        {t("space.skills.latestVersion", {
                          revision: skill.latestRevision,
                        })}
                      </span>
                    )}
                  </div>
                  {skill.source && (
                    <div className="mt-3 flex max-w-[72ch] items-center gap-2.5 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)]/50 px-3 py-2 text-sm">
                      <Link className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="shrink-0 text-xs font-semibold text-[var(--ink-subtle)]">
                            {t("space.skills.source")}
                          </span>
                          <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
                            {skillSourceKindLabel(skill.source, t)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void openExternal(skill.source?.url ?? "")
                            }
                            className="min-w-0 truncate text-left text-sm font-semibold text-[var(--ink)] underline-offset-4 hover:underline"
                          >
                            {skillSourcePrimary(skill.source)}
                          </button>
                        </div>
                        {skillSourceSecondary(skill.source) && (
                          <p className="mt-0.5 truncate text-xs font-medium text-[var(--ink-muted)]">
                            {skillSourceSecondary(skill.source)}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="mt-5 border-b border-[var(--line-subtle)] pb-5">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold text-[var(--ink)]">
                    {t("space.skills.install")}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={installingTarget !== null}
                    onClick={() => void install("global")}
                    className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3.5 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                  >
                    {installingTarget === "global" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {t("space.skills.installGlobal")}
                  </button>
                  <span ref={workspaceMenuRef} className="relative">
                    <button
                      type="button"
                      disabled={installingTarget !== null || !hasProjects}
                      title={
                        hasProjects
                          ? t("space.skills.installWorkspaceTitle")
                          : t("space.skills.noInstallProjectsTitle")
                      }
                      onClick={() => setWorkspaceMenuOpen((open) => !open)}
                      className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3.5 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {installingTarget === "project" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {t("space.skills.installWorkspace")}
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    {workspaceMenuOpen && (
                      <span className="absolute right-0 top-12 z-20 max-h-72 w-64 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                        {projectOptions.map((project) => (
                          <button
                            key={project.value}
                            type="button"
                            onClick={() => {
                              setWorkspaceMenuOpen(false);
                              void install("project", project.value);
                            }}
                            className="flex min-h-10 w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                          >
                            <span className="max-w-full truncate text-sm font-semibold text-[var(--ink)]">
                              {project.label}
                            </span>
                            <span className="max-w-full truncate text-xs font-medium text-[var(--ink-subtle)]">
                              {project.value}
                            </span>
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                  {!hasProjects && (
                    <span className="text-sm font-medium text-[var(--ink-muted)]">
                      {t("space.skills.noProjects")}
                    </span>
                  )}
                </div>
              </section>

              {!detail && detailLoading ? (
                <div className="flex min-h-80 items-center justify-center text-sm text-[var(--ink-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("space.skills.loadingSkill")}
                </div>
              ) : !detail ? (
                <div className="flex min-h-80 items-center justify-center text-sm text-[var(--ink-muted)]">
                  {detailState?.error ?? t("space.skills.notFound")}
                </div>
              ) : (
                <>
                  <nav
                    className="mt-6 flex items-center gap-6 border-b border-[var(--line)]"
                    aria-label="Skill detail"
                  >
                    {entryFile && (
                      <button
                        type="button"
                        onClick={() => changeMode("entry")}
                        className={`border-b-2 px-0 pb-2.5 text-sm font-semibold transition-colors ${activeMode === "entry" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                      >
                        {entryFile.name}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => changeMode("files")}
                      className={`border-b-2 px-0 pb-2.5 text-sm font-semibold transition-colors ${activeMode === "files" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                    >
                      {t("space.skills.files")}
                    </button>
                    <button
                      type="button"
                      onClick={() => changeMode("history")}
                      className={`border-b-2 px-0 pb-2.5 text-sm font-semibold transition-colors ${activeMode === "history" ? "border-[var(--ink)] text-[var(--ink)]" : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"}`}
                    >
                      {t("space.skills.history")}
                    </button>
                  </nav>
                  <div className="mt-5">
                    {activeMode === "history"
                      ? renderHistory()
                      : activeMode === "entry"
                        ? renderEntryDocument()
                        : previewFile
                          ? renderFilePreview()
                          : renderFilesList()}
                  </div>
                </>
              )}
            </div>
          </section>
        </aside>
      </OverlayBackdrop>
      {deleteConfirmOpen && (
        <ConfirmDialog
          title={t("space.skills.deleteTitle")}
          message={t("space.skills.deleteMessage", { name: skill.name })}
          confirmText={t("space.skills.delete")}
          cancelText={t("space.common.cancel")}
          confirmVariant="danger"
          loading={deleting}
          onConfirm={() => void deleteSkill()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
      {installConflict && (
        <ConfirmDialog
          title={t("space.skills.overwriteInstallTitle")}
          message={t("space.skills.overwriteInstallMessage", {
            name: skill.name,
            target:
              installConflict.target === "global"
                ? t("space.skills.globalInstallTarget")
                : installConflict.workspacePath,
          })}
          confirmText={t("space.skills.overwriteInstallConfirm")}
          cancelText={t("space.common.cancel")}
          loading={installingTarget !== null}
          disableEnterShortcut
          onConfirm={() =>
            void install(
              installConflict.target,
              installConflict.workspacePath,
              true,
            )
          }
          onCancel={() => setInstallConflict(null)}
        />
      )}
      {rollbackTarget !== null && (
        <ConfirmDialog
          title={t("space.skills.rollbackTitle")}
          message={t("space.skills.rollbackMessage", {
            current: skill.currentRevision,
            target: rollbackTarget,
          })}
          confirmText={t("space.skills.rollback")}
          cancelText={t("space.common.cancel")}
          loading={rollingBack}
          onConfirm={() => void rollback()}
          onCancel={() => setRollbackTarget(null)}
        />
      )}
    </>
  );
}
