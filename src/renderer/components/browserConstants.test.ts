import { describe, it, expect } from 'vitest';
import { browserBoundsEqual, hasUsableBrowserBounds, toUsableBrowserBounds } from './browserConstants';

// Regression guard for issue #290: HTML preview webview was created with
// width 0 because the create effect read getBoundingClientRect() while the
// split panel's 300ms width transition was still in flight (container ~0px),
// which collapsed the OS webview and floated it over the chat area.
describe('hasUsableBrowserBounds', () => {
  it('rejects zero width (mid-transition / collapsed panel — issue #290)', () => {
    // The exact degenerate read from the bug log: pos=(1388,79) size=0x662.
    expect(hasUsableBrowserBounds(0, 662)).toBe(false);
  });

  it('rejects zero height', () => {
    expect(hasUsableBrowserBounds(640, 0)).toBe(false);
  });

  it('rejects the all-zero read from a display:none container', () => {
    // This is the (0,0,0,0) that previously got cached and restored on SHOW.
    expect(hasUsableBrowserBounds(0, 0)).toBe(false);
  });

  it('rejects negative dimensions', () => {
    expect(hasUsableBrowserBounds(-1, 600)).toBe(false);
    expect(hasUsableBrowserBounds(600, -1)).toBe(false);
  });

  it('rejects NaN / non-finite dimensions', () => {
    expect(hasUsableBrowserBounds(NaN, 600)).toBe(false);
    expect(hasUsableBrowserBounds(600, Infinity)).toBe(false);
  });

  it('accepts a fully laid-out panel', () => {
    expect(hasUsableBrowserBounds(694, 662)).toBe(true);
  });

  it('rejects tiny non-zero transition widths from the split panel', () => {
    // Windows WebView2 is an OS child view, not a React div. Creating it at
    // intermediate transition widths can seed native geometry with a sliver
    // before the real right panel exists.
    expect(hasUsableBrowserBounds(1.1, 662)).toBe(false);
    expect(hasUsableBrowserBounds(24, 662)).toBe(false);
    expect(hasUsableBrowserBounds(99.9, 662)).toBe(false);
  });

  it('accepts the minimum interactive panel size', () => {
    expect(hasUsableBrowserBounds(100, 100)).toBe(true);
  });
});

describe('browser bounds identity', () => {
  it('rejects non-finite origins even when size is usable', () => {
    expect(toUsableBrowserBounds({ x: NaN, y: 80, width: 688, height: 662 })).toBeNull();
    expect(toUsableBrowserBounds({ x: 699, y: Infinity, width: 688, height: 662 })).toBeNull();
  });

  it('treats position-only movement as a bounds change', () => {
    expect(browserBoundsEqual(
      { x: 699, y: 80, width: 688, height: 662 },
      { x: 1039, y: 80, width: 688, height: 662 },
    )).toBe(false);
  });

  it('allows sub-pixel measurement noise', () => {
    expect(browserBoundsEqual(
      { x: 699.42, y: 79.99, width: 688.66, height: 662.02 },
      { x: 699.7, y: 80.2, width: 688.3, height: 661.8 },
    )).toBe(true);
  });
});
