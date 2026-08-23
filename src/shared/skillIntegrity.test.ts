import { describe, expect, it } from 'vitest';

import cases from './fixtures/skill-integrity-cases.json';
import {
  classifySkillIntegrity,
  type SkillIntegrityEvidence,
} from './skillIntegrity';

describe('Skill integrity classifier contract', () => {
  for (const fixture of cases) {
    it(fixture.name, () => {
      const evidence = {
        ...fixture.evidence,
        ...(fixture.evidence.declaredName === null ? { declaredName: undefined } : {}),
      } as SkillIntegrityEvidence;
      expect(classifySkillIntegrity(evidence)).toEqual(fixture.expected);
    });
  }
});
