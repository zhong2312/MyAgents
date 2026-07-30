import {
  Bot,
  Check,
  CircleSlash2,
  Columns2,
  Cpu,
  Loader2,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CustomSelect,
  type SelectOption,
  type WorkbenchAvailableProvider,
  type WorkbenchModelSelection,
  type WorkbenchStorage,
  useWorkbenchAvailableProviders,
} from "@/workbench-sdk";

import {
  getModelSceneBinding,
  NOVEL_MODEL_SCENES,
  type ModelSceneSettings,
  type NovelModelSceneDefinition,
  type NovelModelSceneId,
} from "./modelSceneSettings";
import {
  createNovelModelSceneSettingsRepository,
  type LoadedModelSceneSettings,
} from "./modelSceneSettingsRepository";
import {
  createManuscriptAiSettingsRepository,
  type LoadedManuscriptAiSettings,
} from "./manuscriptAiSettingsRepository";

interface NovelModelScenarioSettingsProps {
  readonly storage: WorkbenchStorage;
  readonly isActive: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelsForScene(
  scene: NovelModelSceneDefinition,
  providers: readonly WorkbenchAvailableProvider[],
): readonly WorkbenchAvailableProvider[] {
  return scene.execution === "run"
    ? providers.filter((provider) => !provider.runtimeBacked)
    : providers;
}

function sceneStatus(
  binding: WorkbenchModelSelection | undefined,
  providers: readonly WorkbenchAvailableProvider[],
): "default" | "bound" | "invalid" {
  if (!binding) return "default";
  const provider = providers.find((item) => item.id === binding.providerId);
  if (!provider?.models.some((item) => item.model === binding.model)) {
    return "invalid";
  }
  return "bound";
}

function providerOptions(
  binding: WorkbenchModelSelection | undefined,
  providers: readonly WorkbenchAvailableProvider[],
  defaultLabel = "使用全局默认模型",
): SelectOption[] {
  const options: SelectOption[] = [
    {
      value: "",
      label: defaultLabel,
      icon: <CircleSlash2 className="h-3.5 w-3.5" />,
    },
    ...providers.map((provider) => ({
      value: provider.id,
      label: provider.name,
      suffix: provider.vendor,
    })),
  ];
  if (binding && !providers.some((item) => item.id === binding.providerId)) {
    options.splice(1, 0, {
      value: binding.providerId,
      label: `不可用：${binding.providerId}`,
      suffix: "需重新选择",
    });
  }
  return options;
}

function modelOptions(
  binding: WorkbenchModelSelection | undefined,
  provider: WorkbenchAvailableProvider | undefined,
): SelectOption[] {
  if (!provider) {
    return binding
      ? [{ value: binding.model, label: `不可用：${binding.model}` }]
      : [];
  }
  const options = provider.models.map((model) => ({
    value: model.model,
    label: model.modelName || model.model,
    suffix: model.modelName === model.model ? undefined : model.model,
  }));
  if (
    binding &&
    !provider.models.some((item) => item.model === binding.model)
  ) {
    options.unshift({
      value: binding.model,
      label: `不可用：${binding.model}`,
      suffix: "需重新选择",
    });
  }
  return options;
}

function ModelSceneRow({
  scene,
  binding,
  projectDefaultModel,
  availableProviders,
  disabled,
  isSaving,
  onProviderChange,
  onModelChange,
  onClear,
}: {
  readonly scene: NovelModelSceneDefinition;
  readonly binding: WorkbenchModelSelection | undefined;
  readonly projectDefaultModel: WorkbenchModelSelection | undefined;
  readonly availableProviders: readonly WorkbenchAvailableProvider[];
  readonly disabled: boolean;
  readonly isSaving: boolean;
  readonly onProviderChange: (providerId: string) => void;
  readonly onModelChange: (model: string) => void;
  readonly onClear: () => void;
}) {
  const sceneProviders = modelsForScene(scene, availableProviders);
  const selectedProvider = sceneProviders.find(
    (provider) => provider.id === binding?.providerId,
  );
  const status = sceneStatus(binding, sceneProviders);
  const canChooseModel = Boolean(selectedProvider?.models.length);

  return (
    <article className="grid gap-4 border-b border-[var(--line-subtle)] px-5 py-5 last:border-b-0 lg:grid-cols-[minmax(13rem,1fr)_minmax(12rem,0.78fr)_minmax(14rem,0.92fr)_2rem] lg:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--paper-inset)] text-[var(--accent-cool)]">
            {scene.execution === "agent" ? (
              <Bot className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </span>
          <h2 className="truncate text-sm font-semibold text-[var(--ink)]">
            {scene.label}
          </h2>
          {status === "bound" && (
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
          )}
        </div>
        <p
          className={`mt-2 text-xs ${status === "invalid" ? "text-[var(--warning)]" : "text-[var(--ink-muted)]"}`}
        >
          {status === "default"
            ? projectDefaultModel
              ? "使用小说工作台默认模型"
              : "使用全局默认模型"
            : status === "invalid"
              ? "当前绑定的模型不可用，请重新选择"
              : scene.description}
        </p>
      </div>

      <CustomSelect
        value={binding?.providerId ?? ""}
        options={providerOptions(
          binding,
          sceneProviders,
          projectDefaultModel ? "使用小说工作台默认模型" : undefined,
        )}
        onChange={onProviderChange}
        ariaLabel={`${scene.label}的供应商`}
        placeholder="选择供应商"
        size="toolbar"
        disabled={disabled || isSaving}
      />

      <CustomSelect
        value={binding?.model ?? ""}
        options={modelOptions(binding, selectedProvider)}
        onChange={onModelChange}
        ariaLabel={`${scene.label}的模型`}
        placeholder="先选择供应商"
        size="toolbar"
        disabled={disabled || isSaving || !canChooseModel}
      />

      <button
        type="button"
        onClick={onClear}
        disabled={disabled || isSaving || !binding}
        aria-label={`清除${scene.label}的模型绑定`}
        title={
          projectDefaultModel
            ? "恢复为小说工作台默认模型"
            : "恢复为全局默认模型"
        }
        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
      >
        {isSaving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
      </button>
    </article>
  );
}

export default function NovelModelScenarioSettings({
  storage,
  isActive,
}: NovelModelScenarioSettingsProps) {
  const repository = useMemo(
    () => createNovelModelSceneSettingsRepository(storage),
    [storage],
  );
  const manuscriptAiRepository = useMemo(
    () => createManuscriptAiSettingsRepository(storage),
    [storage],
  );
  const availableProviders = useWorkbenchAvailableProviders();
  const [loaded, setLoaded] = useState<LoadedModelSceneSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savingSceneId, setSavingSceneId] = useState<NovelModelSceneId | null>(
    null,
  );
  const [isSavingDefault, setIsSavingDefault] = useState(false);
  const [manuscriptAiSettings, setManuscriptAiSettings] =
    useState<LoadedManuscriptAiSettings | null>(null);
  const [isSavingManuscriptPresentation, setIsSavingManuscriptPresentation] =
    useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [next, nextManuscriptAiSettings] = await Promise.all([
        repository.load(),
        manuscriptAiRepository.load(),
      ]);
      setLoaded(next);
      setManuscriptAiSettings(nextManuscriptAiSettings);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsLoading(false);
    }
  }, [manuscriptAiRepository, repository]);

  const saveManuscriptPresentation = useCallback(
    async (presentation: "compact-review" | "full-dialog") => {
      if (!manuscriptAiSettings) return;
      setIsSavingManuscriptPresentation(true);
      try {
        const next = await manuscriptAiRepository.save(
          manuscriptAiSettings,
          { schemaVersion: 1, presentation },
        );
        setManuscriptAiSettings(next);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setIsSavingManuscriptPresentation(false);
      }
    },
    [manuscriptAiRepository, manuscriptAiSettings],
  );

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load]);

  const saveSceneBinding = useCallback(
    async (
      sceneId: NovelModelSceneId,
      selection: WorkbenchModelSelection | undefined,
    ) => {
      if (!loaded) return;
      const bindings: Record<string, WorkbenchModelSelection> = {
        ...loaded.settings.bindings,
      };
      if (selection) bindings[sceneId] = selection;
      else delete bindings[sceneId];
      const settings: ModelSceneSettings = {
        schemaVersion: loaded.settings.schemaVersion,
        ...(loaded.settings.defaultModel
          ? { defaultModel: loaded.settings.defaultModel }
          : {}),
        bindings,
      };
      setSavingSceneId(sceneId);
      try {
        const next = await repository.save(loaded, settings);
        setLoaded(next);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSavingSceneId(null);
      }
    },
    [loaded, repository],
  );

  const saveDefaultModel = useCallback(
    async (selection: WorkbenchModelSelection | undefined) => {
      if (!loaded) return;
      const settings: ModelSceneSettings = {
        schemaVersion: loaded.settings.schemaVersion,
        ...(selection ? { defaultModel: selection } : {}),
        bindings: loaded.settings.bindings,
      };
      setIsSavingDefault(true);
      try {
        const next = await repository.save(loaded, settings);
        setLoaded(next);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setIsSavingDefault(false);
      }
    },
    [loaded, repository],
  );

  const groupedScenes = useMemo(() => {
    const groups = new Map<string, NovelModelSceneDefinition[]>();
    for (const scene of NOVEL_MODEL_SCENES) {
      const bucket = groups.get(scene.group) ?? [];
      bucket.push(scene);
      groups.set(scene.group, bucket);
    }
    return [...groups.entries()];
  }, []);
  const defaultProviders = useMemo(
    () => availableProviders.filter((provider) => !provider.runtimeBacked),
    [availableProviders],
  );
  const defaultModel = loaded?.settings.defaultModel;
  const selectedDefaultProvider = defaultProviders.find(
    (provider) => provider.id === defaultModel?.providerId,
  );

  return (
    <main className="mx-auto min-h-full w-full max-w-6xl px-5 py-7 max-md:px-4">
      <header className="flex items-start justify-between gap-5 border-b border-[var(--line-strong)] pb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--accent-cool)]">
            <Cpu className="h-3.5 w-3.5" />
            设置
          </div>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--ink)]">
            模型场景
          </h1>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            场景未绑定时使用小说工作台默认模型；未设置时使用全局默认模型
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading || savingSceneId !== null}
          aria-label="重新读取模型场景设置"
          title="重新读取"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
          />
        </button>
      </header>

      {error && (
        <div className="mt-4 border-l-2 border-[var(--warning)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-[var(--warning)]">
          {error}
        </div>
      )}

      <section className="mt-4 grid gap-4 border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-5 py-4 lg:grid-cols-[minmax(13rem,1fr)_minmax(26rem,1.7fr)] lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-cool-subtle)] text-[var(--accent-cool)]">
              <Columns2 className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              正文 AI 交互
            </h2>
          </div>
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            决定完整生成、续写、润色和扩写的执行窗口
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="正文 AI 交互方式"
          className="grid grid-cols-2 gap-1 border border-[var(--line)] bg-[var(--paper-inset)] p-1"
        >
          {([
            {
              value: "compact-review" as const,
              label: "简易协作窗",
              detail: "执行过程与差异审阅并排",
              icon: Columns2,
            },
            {
              value: "full-dialog" as const,
              label: "完整 Agent 对话",
              detail: "使用标准对话窗口",
              icon: MessagesSquare,
            },
          ]).map((option) => {
            const Icon = option.icon;
            const active =
              manuscriptAiSettings?.settings.presentation === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={
                  isLoading ||
                  !manuscriptAiSettings ||
                  isSavingManuscriptPresentation
                }
                onClick={() => void saveManuscriptPresentation(option.value)}
                className={`flex min-h-14 items-center gap-3 px-3 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm"
                    : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                }`}
              >
                {isSavingManuscriptPresentation && active ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <Icon className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0">
                  <strong className="block text-xs font-semibold">
                    {option.label}
                  </strong>
                  <small className="mt-0.5 block text-xs text-[var(--ink-subtle)]">
                    {option.detail}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-4 grid gap-4 border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-5 py-4 lg:grid-cols-[minmax(13rem,1fr)_minmax(12rem,0.78fr)_minmax(14rem,0.92fr)_2rem] lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <Cpu className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              小说工作台默认模型
            </h2>
          </div>
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            未绑定场景的默认选择
          </p>
        </div>
        <CustomSelect
          value={defaultModel?.providerId ?? ""}
          options={providerOptions(defaultModel, defaultProviders)}
          onChange={(providerId) => {
            if (!providerId) {
              void saveDefaultModel(undefined);
              return;
            }
            const provider = defaultProviders.find(
              (item) => item.id === providerId,
            );
            const model =
              provider?.models.find(
                (item) => item.model === provider.primaryModel,
              ) ?? provider?.models[0];
            if (!provider || !model) {
              setError("所选供应商没有可用模型，请先在 MyAgents 配置模型");
              return;
            }
            void saveDefaultModel({
              providerId: provider.id,
              model: model.model,
            });
          }}
          ariaLabel="默认模型的供应商"
          placeholder="选择供应商"
          size="toolbar"
          disabled={
            isLoading || !loaded || isSavingDefault || savingSceneId !== null
          }
        />
        <CustomSelect
          value={defaultModel?.model ?? ""}
          options={modelOptions(defaultModel, selectedDefaultProvider)}
          onChange={(model) => {
            if (!defaultModel || !model) return;
            void saveDefaultModel({
              providerId: defaultModel.providerId,
              model,
            });
          }}
          ariaLabel="默认模型"
          placeholder="先选择供应商"
          size="toolbar"
          disabled={
            isLoading ||
            !loaded ||
            isSavingDefault ||
            savingSceneId !== null ||
            !selectedDefaultProvider?.models.length
          }
        />
        <button
          type="button"
          onClick={() => void saveDefaultModel(undefined)}
          disabled={
            isLoading ||
            !loaded ||
            isSavingDefault ||
            savingSceneId !== null ||
            !defaultModel
          }
          aria-label="清除默认模型"
          title="恢复为全局默认模型"
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {isSavingDefault ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
        </button>
      </section>

      <div className="mt-6 overflow-hidden border border-[var(--line-strong)] bg-[var(--paper-elevated)]">
        {groupedScenes.map(([group, scenes], index) => (
          <section
            key={group}
            className={
              index === 0 ? "" : "border-t border-[var(--line-strong)]"
            }
          >
            <div className="flex items-center justify-between border-b border-[var(--line-subtle)] bg-[var(--paper-inset)] px-5 py-2.5">
              <h2 className="text-xs font-semibold text-[var(--ink-muted)]">
                {group}
              </h2>
              <span className="text-xs text-[var(--ink-subtle)]">
                {scenes.length} 个场景
              </span>
            </div>
            {scenes.map((scene) => (
              <ModelSceneRow
                key={scene.id}
                scene={scene}
                binding={
                  loaded
                    ? getModelSceneBinding(loaded.settings, scene.id)
                    : undefined
                }
                projectDefaultModel={defaultModel}
                availableProviders={availableProviders}
                disabled={isLoading || !loaded}
                isSaving={savingSceneId === scene.id}
                onProviderChange={(providerId) => {
                  if (!providerId) {
                    void saveSceneBinding(scene.id, undefined);
                    return;
                  }
                  const provider = modelsForScene(
                    scene,
                    availableProviders,
                  ).find((item) => item.id === providerId);
                  const model =
                    provider?.models.find(
                      (item) => item.model === provider.primaryModel,
                    ) ?? provider?.models[0];
                  if (!provider || !model) {
                    setError(
                      "所选供应商没有可用模型，请先在 MyAgents 配置模型",
                    );
                    return;
                  }
                  void saveSceneBinding(scene.id, {
                    providerId: provider.id,
                    model: model.model,
                  });
                }}
                onModelChange={(model) => {
                  const binding = loaded
                    ? getModelSceneBinding(loaded.settings, scene.id)
                    : undefined;
                  if (!binding || !model) return;
                  void saveSceneBinding(scene.id, {
                    providerId: binding.providerId,
                    model,
                  });
                }}
                onClear={() => void saveSceneBinding(scene.id, undefined)}
              />
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
