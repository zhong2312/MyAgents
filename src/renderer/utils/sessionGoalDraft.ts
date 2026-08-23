import type { GoalEndConditions, SessionGoalDraftConfig } from '@/types/sessionGoal';
import type { RuntimeType } from '@/../shared/types/runtime';

export const DEFAULT_SESSION_GOAL_END_CONDITIONS: Readonly<GoalEndConditions> = {
  aiCanExit: true,
};

export const DEFAULT_SESSION_GOAL_NOTIFY_ENABLED = true;

export function createDefaultSessionGoalDraftConfig(args: {
  runtime?: RuntimeType;
  permissionMode?: string;
}): SessionGoalDraftConfig {
  return {
    taskKind: 'goal',
    prompt: '',
    endConditions: { ...DEFAULT_SESSION_GOAL_END_CONDITIONS },
    notifyEnabled: DEFAULT_SESSION_GOAL_NOTIFY_ENABLED,
    permissionMode: args.permissionMode,
    runtime: args.runtime,
  };
}
