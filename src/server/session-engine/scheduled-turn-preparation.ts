import type { RuntimeConfig, RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { coerceModelForRuntime } from '../../shared/types/runtime';
import type { RequiredSystemSkill } from '../../shared/systemSkills';
import type { DispatchGuard } from '../session-core/turn-queue';

export function runtimeConfigModel(
  config: RuntimeConfig | null | undefined,
  runtime: RuntimeType,
): string | undefined {
  const model = config?.model?.trim();
  return model ? coerceModelForRuntime(model, runtime) : undefined;
}

export function runtimeConfigSource(
  config: RuntimeConfig | null | undefined,
): RuntimeSource | undefined {
  const source = config?.source;
  return source === 'managed-provider' || source === 'system-cli' ? source : undefined;
}

export function createScheduledDispatchGuard(input: {
  preceding: DispatchGuard;
  requiredSystemSkill?: RequiredSystemSkill;
  requireNativeSystemSkill?: (skill: RequiredSystemSkill) => Promise<void>;
}): DispatchGuard {
  const requiredSystemSkill = input.requiredSystemSkill;
  if (!requiredSystemSkill) return input.preceding;

  let canceled = false;
  const guard: DispatchGuard = async () => {
    if (canceled) {
      return { accepted: false, code: 'system_skill_dispatch_canceled', error: 'System skill dispatch was canceled' };
    }
    const prior = await input.preceding();
    if (!prior.accepted) return prior;
    if (canceled) {
      return { accepted: false, code: 'system_skill_dispatch_canceled', error: 'System skill dispatch was canceled' };
    }
    try {
      await input.requireNativeSystemSkill?.(requiredSystemSkill);
      return canceled
        ? { accepted: false, code: 'system_skill_dispatch_canceled', error: 'System skill dispatch was canceled' }
        : { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        code: 'required_system_skill_unavailable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  guard.cancel = () => {
    canceled = true;
    input.preceding.cancel?.();
  };
  return guard;
}
