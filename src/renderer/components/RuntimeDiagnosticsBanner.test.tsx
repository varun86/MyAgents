import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import type { RuntimeDiagnostics } from '../../shared/types/runtime';
import RuntimeDiagnosticsBanner from './RuntimeDiagnosticsBanner';

function expectTextContaining(...parts: string[]) {
  expect(
    screen.getAllByText((_content, element) => {
      const text = element?.textContent ?? '';
      return parts.every((part) => text.includes(part));
    }).length,
  ).toBeGreaterThan(0);
}

describe('RuntimeDiagnosticsBanner i18n', () => {
  it('localizes diagnostic chrome while preserving raw runtime payloads', async () => {
    await i18n.changeLanguage('en-US');
    const diagnostics: RuntimeDiagnostics = {
      runtime: 'codex',
      timestamp: '2026-06-28T00:00:00.000Z',
      status: {
        auth: { error: '原始 auth 错误' },
        apps: 'ok',
        mcpServers: 'ok',
        features: 'unsupported',
      },
      auth: {
        authMethod: null,
        requiresLogin: true,
      },
      apps: [
        {
          id: 'artifact-tool',
          isEnabled: true,
          isAccessible: false,
          needsAuth: true,
        },
      ],
      mcpServers: [
        {
          name: '用户MCP',
          toolCount: 1,
          resourceCount: 0,
          state: 'failed',
          authStatus: 'oauth-required',
        },
      ],
      features: [
        {
          name: 'artifact',
          enabled: false,
          defaultEnabled: true,
        },
      ],
      effectiveEnv: {
        cwd: '/tmp/用户工作区',
        proxy: {
          http: 'http://127.0.0.1:7890',
          https: 'http://127.0.0.1:7890',
          no: 'localhost,127.0.0.1',
        },
        proxyPolicy: 'terminal',
        myagentsProxyInjected: false,
        hasOpenaiApiKey: false,
        hasAnthropicApiKey: true,
        hasCodexHome: true,
      },
    };

    render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    const headline = screen.getByRole('button', { name: /Sign in to Codex to continue/ });
    expect(headline).toBeInTheDocument();

    await userEvent.click(headline);

    expect(screen.getByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('Auth [Failed: 原始 auth 错误]')).toBeInTheDocument();
    expect(screen.queryByText('认证')).not.toBeInTheDocument();
    expectTextContaining('auth query failed: 原始 auth 错误');
    expectTextContaining('inaccessible ', 'artifact-tool');
    expectTextContaining('用户MCP', 'state=failed');
    expectTextContaining('cwd: /tmp/用户工作区');
    expectTextContaining('Diagnostic snapshot: 2026-06-28T00:00:00.000Z. CLI sync info:');
  });
});
