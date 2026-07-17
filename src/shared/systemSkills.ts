/** Version shared with Rust's SYSTEM_SKILLS_VERSION contract. */
export const SYSTEM_SKILLS_VERSION = '35';

/**
 * Product-owned skills required by managed memory workflows.
 *
 * These cannot be disabled as ordinary user skills: disabling one would leave
 * an enabled product automation without its versioned execution contract.
 */
export const REQUIRED_MEMORY_SYSTEM_SKILLS = [
  'myagents-memory-update',
  'myagents-memory-gardener',
  'myagents-memory-molt',
] as const;

export type RequiredMemorySystemSkill = typeof REQUIRED_MEMORY_SYSTEM_SKILLS[number];

const REQUIRED_MEMORY_SYSTEM_SKILL_SET = new Set<string>(REQUIRED_MEMORY_SYSTEM_SKILLS);

export function isRequiredMemorySystemSkill(name: string): name is RequiredMemorySystemSkill {
  return REQUIRED_MEMORY_SYSTEM_SKILL_SET.has(name);
}
