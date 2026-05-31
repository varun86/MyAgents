// Characterization test for the widget sandbox's failure handling.
//
// Bug context: DeepSeek V4 Pro (and other weaker / non-Claude models) routinely
// emit a widget whose inline JS is malformed — e.g. a Chart config missing one
// closing brace. The parse/runtime error is thrown INSIDE the sandboxed iframe,
// invisible to the parent console and the app's unified log, so the user just
// sees a blank box with no clue why (real incident: session 936489e3, the
// 国运曲线 line chart). The sandbox must therefore (1) catch such failures so one
// bad script doesn't abort the rest of the widget, (2) show a visible inline
// notice instead of a silent blank, and (3) forward the error to the parent so
// it lands in the main console / logs. These assertions lock that contract in.
import { describe, expect, it } from 'vitest';

import { buildSandboxHtml } from './widgetSandboxHtml';

const html = buildSandboxHtml(':root{--widget-text:#222}');

describe('widget sandbox failure handling', () => {
  it('captures script errors via a global error listener', () => {
    expect(html).toContain("addEventListener('error'");
  });

  it('forwards the failure to the parent as widget:error', () => {
    expect(html).toContain("type: 'widget:error'");
  });

  it('renders a visible inline notice (not a silent blank)', () => {
    expect(html).toContain('data-widget-error');
    expect(html).toContain('这个组件的脚本没能运行');
  });

  it('wraps inline-script execution in try/catch so one bad script does not abort the chain', () => {
    // The inline-script branch of runScripts must guard replaceChild — WebKit
    // throws a malformed inline script's SyntaxError synchronously there.
    expect(html).toMatch(/try\s*{[\s\S]*replaceChild[\s\S]*catch/);
  });
});
