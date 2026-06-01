// Unit tests for widget library detection + inline rewriting (pure functions).
// These lock the contract that a known CDN library <script src> is recognised
// and swapped for an inline <script> carrying the bundled source, so it runs
// under the sandbox's inherited 'unsafe-inline' CSP with no network — fixing the
// Windows/WebView2 blank-chart bug — while unknown libs and SVG/text widgets are
// left untouched.
import { describe, it, expect } from 'vitest';

import { detectWidgetLibraries, inlineWidgetLibraries } from './widgetLibraries';

describe('detectWidgetLibraries', () => {
  it('detects Chart.js from the cdnjs umd url (what the contract recommends)', () => {
    const code =
      '<canvas id="c"></canvas>\n' +
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>\n' +
      '<script>new Chart(c, {})</script>';
    expect(detectWidgetLibraries(code).map((l) => l.name)).toEqual(['chart.js']);
  });

  it('detects Chart.js from the jsdelivr npm url', () => {
    expect(
      detectWidgetLibraries('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>')
        .map((l) => l.name),
    ).toEqual(['chart.js']);
  });

  it('does NOT match an unrelated *chart.js filename (no false positive)', () => {
    expect(detectWidgetLibraries('<script src="https://example.com/barchart.js"></script>')).toEqual([]);
  });

  it('returns nothing for SVG / text-only widgets (zero overhead path)', () => {
    expect(detectWidgetLibraries('<svg><rect width="10" height="10"/></svg>')).toEqual([]);
  });

  it('dedupes when a widget references the library more than once', () => {
    const code =
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>' +
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>';
    expect(detectWidgetLibraries(code)).toHaveLength(1);
  });
});

describe('inlineWidgetLibraries', () => {
  const CHART_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';

  it('replaces the external CDN script with an inline bundled script', () => {
    const code = `<canvas></canvas>\n<script src="${CHART_SRC}"></script>\n<script>new Chart()</script>`;
    const out = inlineWidgetLibraries(code, new Map([['chart.js', 'window.Chart=function(){};']]));
    expect(out).not.toContain(CHART_SRC); // external src removed → no CDN/CSP dependency
    expect(out).toContain('data-inlined-lib="chart.js"');
    expect(out).toContain('window.Chart=function(){};'); // bundled source injected
    expect(out).toContain('new Chart()'); // widget's own inline script preserved
  });

  it('escapes </script> in the source so it cannot break out of the inline tag', () => {
    const out = inlineWidgetLibraries(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
      new Map([['chart.js', 'var x="</script>";']]),
    );
    expect(out).toContain('<\\/script>'); // escaped form present
    expect(out).not.toContain('"</script>";'); // raw closer from source is gone
  });

  it('escapes </script even with a trailing space (HTML ends a script on </script + ws/>/EOF)', () => {
    const out = inlineWidgetLibraries(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
      new Map([['chart.js', 'a="</script >";']]),
    );
    expect(out).not.toContain('"</script >"'); // the with-space closer is broken …
    expect(out).toContain('<\\/script >'); // … into the escaped prefix form
  });

  it('leaves an unknown library untouched (falls back to CDN + visible error)', () => {
    const code = '<script src="https://cdn.jsdelivr.net/npm/some-random-lib.js"></script>';
    expect(inlineWidgetLibraries(code, new Map())).toBe(code);
  });

  it('leaves the code unchanged when no source was loaded for the matched lib', () => {
    const code = `<script src="${CHART_SRC}"></script>`;
    expect(inlineWidgetLibraries(code, new Map())).toBe(code);
  });
});
