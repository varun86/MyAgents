import { describe, expect, it, vi } from 'vitest';

import {
    parseFullCommandContent,
    parseFullSkillContent,
    parseSkillFrontmatter,
    parseYamlFrontmatter,
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
        });
        expect(parsed.body.trim()).toBe('# Prompt Writer\n\nBody text.');
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
