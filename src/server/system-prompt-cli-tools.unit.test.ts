import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<myagents-user-tools>registered</myagents-user-tools>',
}));

const { buildCliToolsAppend } = await import('./system-prompt-cli-tools');

describe('buildCliToolsAppend', () => {
  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<myagents-cli-cron>');
    expect(text).toContain('<myagents-cli-thought>');
    expect(text).not.toContain('<myagents-user-tools>');
  });

  it('includes user-registered CLI tools only when explicitly enabled', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: true });

    expect(text).toContain('<myagents-user-tools>registered</myagents-user-tools>');
  });
});
