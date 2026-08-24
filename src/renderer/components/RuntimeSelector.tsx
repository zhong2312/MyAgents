// RuntimeSelector — dropdown to switch between Agent Runtime types (v0.1.59)
// Appears in SimpleChatInput toolbar (left of permission mode) and WorkspaceBasicsSection

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/ui/Popover';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';

// Runtime types that have backend implementations (not just type definitions)
const IMPLEMENTED_RUNTIMES = new Set<RuntimeType>(['builtin', 'claude-code', 'codex', 'gemini']);

// ─── Runtime icon assets ───
import myagentsIcon from '@/assets/runtime-icons/myagents.png';
import claudeCodeIcon from '@/assets/runtime-icons/claude-code.png';
import codexIcon from '@/assets/runtime-icons/codex.png';
import geminiIcon from '@/assets/runtime-icons/gemini.png';

const RUNTIME_ICON_MAP: Record<RuntimeType, string> = {
  builtin: myagentsIcon,
  'claude-code': claudeCodeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
};

// ─── Runtime display metadata ───

const RUNTIME_OPTIONS: {
  type: RuntimeType;
  name: string;
}[] = [
    { type: 'builtin', name: 'MyNovelStudio (Claude Agent SDK)' },
    { type: 'claude-code', name: 'Claude Code CLI' },
    { type: 'codex', name: 'Codex CLI' },
    { type: 'gemini', name: 'Gemini CLI' },
  ];

function RuntimeIcon({ type, size = 14 }: { type: RuntimeType; size?: number }) {
  return (
    <img
      src={RUNTIME_ICON_MAP[type]}
      alt=""
      className="shrink-0 rounded-[3px]"
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

// ─── Component ───

interface RuntimeSelectorProps {
  value: RuntimeType;
  detections: RuntimeDetections;
  onChange: (runtime: RuntimeType) => void;
  variant?: 'toolbar' | 'panel';
  onOpenSettings?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  onDisabledClick?: () => void;
}

export default memo(function RuntimeSelector({
  value,
  detections,
  onChange,
  variant = 'toolbar',
  onOpenSettings,
  disabled = false,
  disabledReason,
  onDisabledClick,
}: RuntimeSelectorProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!disabled || !open) return;
    const timer = window.setTimeout(() => setOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [disabled, open]);

  const menuOpen = open && !disabled;

  // Register with close layer system so Cmd+W dismisses dropdown before closing Tab
  useCloseLayer(() => {
    if (menuOpen) { setOpen(false); return true; }
    return false;
  }, menuOpen ? 10 : -1);

  const handleSelect = useCallback((type: RuntimeType) => {
    if (disabled) return;
    if (type === value) {
      setOpen(false);
      return;
    }
    const detection = detections[type];
    if (!detection?.installed) return; // Can't select uninstalled runtime
    setOpen(false);
    onChange(type);
  }, [value, detections, onChange, disabled]);

  const currentOption = RUNTIME_OPTIONS.find(o => o.type === value) ?? RUNTIME_OPTIONS[0];

  if (variant === 'panel') {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          aria-disabled={disabled}
          onClick={() => {
            if (disabled) {
              onDisabledClick?.();
              return;
            }
            setOpen(!menuOpen);
          }}
          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)] ${
            disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : ''
          }`}
          title={disabled ? disabledReason : undefined}
        >
          <span className="flex items-center gap-2">
            <RuntimeIcon type={value} size={16} />
            {currentOption.name}
          </span>
          <ChevronUp className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition-transform ${menuOpen ? '' : 'rotate-180'}`} />
        </button>
        <Popover
          open={menuOpen}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          placement="top-start"
          className="w-72 py-1"
        >
          {RUNTIME_OPTIONS.map((opt) => {
            const detection = detections[opt.type];
            const installed = opt.type === 'builtin' || (detection?.installed && IMPLEMENTED_RUNTIMES.has(opt.type));
            return (
              <button
                key={opt.type}
                type="button"
                onClick={() => installed && handleSelect(opt.type)}
                disabled={!installed}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left whitespace-nowrap transition-colors ${installed
                  ? opt.type === value
                    ? 'bg-[var(--accent-warm-subtle)]'
                    : 'hover:bg-[var(--hover-bg)]'
                  : 'opacity-40 cursor-not-allowed'
                  }`}
              >
                <RuntimeIcon type={opt.type} size={20} />
                <span className={`text-sm font-medium ${opt.type === value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                  {opt.name}
                </span>
                {!installed && (
                  <span className="ml-auto text-[var(--ink-subtle)] text-xs">
                    {detection?.installed && !IMPLEMENTED_RUNTIMES.has(opt.type)
                      ? t('runtime.comingSoon')
                      : t('runtime.notInstalled')}
                  </span>
                )}
              </button>
            );
          })}
        </Popover>
      </>
    );
  }

  // Toolbar variant: compact icon button
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) {
            onDisabledClick?.();
            return;
          }
          setOpen(!menuOpen);
        }}
        className={`flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] ${
          disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-[var(--ink-muted)]' : ''
        }`}
        title={disabled ? disabledReason : `Runtime: ${currentOption.name}`}
      >
        <RuntimeIcon type={value} size={16} />
        <ChevronUp className={`h-2.5 w-2.5 transition-transform ${menuOpen ? '' : 'rotate-180'}`} />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="top-start"
        className="w-72 py-1"
      >
        <div className="flex items-center justify-between px-3 pb-0.5 pt-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">{t('runtime.header')}</span>
          {onOpenSettings && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenSettings(); }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Settings className="h-2.5 w-2.5" />
              {t('runtime.settings')}
            </button>
          )}
        </div>
        {RUNTIME_OPTIONS.map((opt) => {
          const detection = detections[opt.type];
          const installed = opt.type === 'builtin' || (detection?.installed && IMPLEMENTED_RUNTIMES.has(opt.type));
          return (
            <button
              key={opt.type}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (installed) handleSelect(opt.type);
              }}
              disabled={!installed}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left whitespace-nowrap transition-colors ${installed
                ? opt.type === value
                  ? 'bg-[var(--accent-warm-subtle)]'
                  : 'hover:bg-[var(--hover-bg)]'
                : 'opacity-40 cursor-not-allowed'
                }`}
            >
              <RuntimeIcon type={opt.type} size={20} />
              <span className={`text-sm font-medium ${opt.type === value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                {opt.name}
              </span>
              {!installed && (
                <span className="ml-auto text-[var(--ink-subtle)] text-xs">{t('runtime.notInstalled')}</span>
              )}
            </button>
          );
        })}
      </Popover>
    </>
  );
});
