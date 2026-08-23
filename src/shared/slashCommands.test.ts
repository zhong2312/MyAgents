import { describe, expect, it, vi } from 'vitest';

import {
    isValidSlashCommandName,
    parseFullCommandContent,
    parseFullSkillContent,
    parseSkillFrontmatter,
    parseYamlFrontmatter,
    serializeSkillContent,
    slashCommandNameFromSourceLocalId,
} from './slashCommands';

const invalidPlainScalarFrontmatter = `---
name: prompt-writer
description: Methodology for writing prompts. Triggers: "write a prompt", "help me write a prompt". Not for: direct answers.
author: MyAgents
---

# Prompt Writer

Body text.`;

describe('slash command frontmatter parsing', () => {
    it('recovers skill list metadata from common unquoted description text without warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(parseSkillFrontmatter(invalidPlainScalarFrontmatter)).toEqual({
                name: 'prompt-writer',
                description: 'Methodology for writing prompts. Triggers: "write a prompt", "help me write a prompt". Not for: direct answers.',
                author: 'MyAgents',
            });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('strips the frontmatter block when full skill parsing falls back to loose scalar metadata', () => {
        const parsed = parseFullSkillContent(invalidPlainScalarFrontmatter);

        expect(parsed.frontmatter).toMatchObject({
            name: 'prompt-writer',
            description: 'Methodology for writing prompts. Triggers: "write a prompt", "help me write a prompt". Not for: direct answers.',
            author: 'MyAgents',
        });
        expect(parsed.body.trim()).toBe('# Prompt Writer\n\nBody text.');
    });

    it('prefers standard metadata.author while keeping legacy top-level author readable', () => {
        const standard = `---
name: standard-skill
description: Standard metadata
license: Apache-2.0
compatibility: Requires git
author: Legacy Author
metadata:
  author: Standard Author
  version: "1.2"
---

# Standard Skill`;

        expect(parseSkillFrontmatter(standard).author).toBe('Standard Author');
        expect(parseFullSkillContent(standard).frontmatter).toMatchObject({
            author: 'Standard Author',
            license: 'Apache-2.0',
            compatibility: 'Requires git',
            metadata: {
                author: 'Standard Author',
                version: '1.2',
            },
        });
        expect(parseSkillFrontmatter(invalidPlainScalarFrontmatter).author).toBe('MyAgents');
    });

    it('serializes normalized legacy author as metadata.author and preserves standard metadata', () => {
        const parsed = parseFullSkillContent(`---
name: legacy-skill
description: Legacy author
author: MyAgents
metadata:
  version: 2
---

# Legacy Skill`);
        const serialized = serializeSkillContent(parsed.frontmatter, parsed.body);

        expect(serialized).not.toMatch(/^author:/m);
        expect(serialized).toContain('metadata:\n  version: "2"\n  author: "MyAgents"');
        expect(parseFullSkillContent(serialized).frontmatter).toMatchObject({
            author: 'MyAgents',
            metadata: { version: '2', author: 'MyAgents' },
        });
    });

    it('applies the same loose scalar fallback to command metadata', () => {
        const content = `---
name: review-helper
description: Use when reviewing code. Triggers: "review this", "find bugs".
---

# Review Helper`;

        expect(parseYamlFrontmatter(content)).toEqual({
            description: 'Use when reviewing code. Triggers: "review this", "find bugs".',
            author: undefined,
        });
        const parsed = parseFullCommandContent(content);
        expect(parsed).toMatchObject({
            frontmatter: {
                name: 'review-helper',
                description: 'Use when reviewing code. Triggers: "review this", "find bugs".',
            },
        });
        expect(parsed.body.trim()).toBe('# Review Helper');
    });

    it('does not silently accept genuinely malformed frontmatter after strict YAML fails', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const parsed = parseFullSkillContent(`---
name: broken-skill
description: Looks parseable
allowed-tools: [Bash, Edit
---

# Broken Skill`);

            expect(parsed.frontmatter).toEqual({});
            expect(parsed.body.trim()).toBe('# Broken Skill');
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('slash command invocation identity', () => {
    it('accepts Unicode command tokens without accepting whitespace or punctuation', () => {
        expect(isValidSlashCommandName('中文总结')).toBe(true);
        expect(isValidSlashCommandName('发布:生成-周报_2')).toBe(true);
        expect(isValidSlashCommandName('中文 总结')).toBe(false);
        expect(isValidSlashCommandName('总结.md')).toBe(false);
    });

    it('derives the invocation token from the source path instead of display metadata', () => {
        expect(slashCommandNameFromSourceLocalId('中文-总结')).toBe('中文-总结');
        expect(slashCommandNameFromSourceLocalId('发布/生成-周报')).toBe('发布:生成-周报');
        expect(slashCommandNameFromSourceLocalId('invalid folder/ship')).toBeNull();
    });
});
