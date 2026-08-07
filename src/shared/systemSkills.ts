/** Version shared with Rust's SYSTEM_SKILLS_VERSION contract. */
export const SYSTEM_SKILLS_VERSION = '47';

/**
 * Product-owned skills that are part of MyAgents' always-available runtime
 * contract.
 *
 * These cannot be disabled as ordinary user skills. The task and memory
 * skills back managed workflows, while myagents-cli and myagents-docs are the
 * product's baseline operation and product-knowledge surfaces.
 */
export const REQUIRED_SYSTEM_SKILLS = [
  'task-alignment',
  'task-implement',
  'myagents-memory-update',
  'myagents-memory-gardener',
  'myagents-memory-molt',
  'myagents-cli',
  'myagents-task-automation',
  'myagents-docs',
] as const;

export type RequiredSystemSkill = typeof REQUIRED_SYSTEM_SKILLS[number];

const REQUIRED_SYSTEM_SKILL_SET = new Set<string>(REQUIRED_SYSTEM_SKILLS);

export function isRequiredSystemSkill(name: string): name is RequiredSystemSkill {
  return REQUIRED_SYSTEM_SKILL_SET.has(name);
}

/** Canonicalize persisted disabled names so required contracts stay enabled. */
export function withoutRequiredSystemSkills(names: readonly unknown[]): string[] {
  return names.filter((name): name is string => (
    typeof name === 'string' && !isRequiredSystemSkill(name)
  ));
}
