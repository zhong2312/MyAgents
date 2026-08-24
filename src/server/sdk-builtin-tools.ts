/**
 * MyAgents' product-owned Claude Agent SDK builtin catalog.
 *
 * This is deliberately separate from permission policy: exposing a tool to the
 * model does not auto-approve it. Keeping an explicit catalog also prevents a
 * Claude Code patch from silently adding a new builtin with no MyAgents owner.
 */
export const SDK_BUILTIN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'Task',
  'TaskStop',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'Monitor',
  'ReportFindings',
  'Workflow',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
] as const;

export const SDK_EXCLUDED_BUILTIN_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'PushNotification',
  'DesignSync',
] as const;
