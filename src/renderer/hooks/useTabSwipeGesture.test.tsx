import { cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tab } from '@/types/tab';
import {
  clearFrontendLogs,
  getOriginalConsole,
  initFrontendLogger,
  restoreFrontendLogger,
  subscribeFrontendLogs,
} from '@/utils/frontendLogger';
import { useTabSwipeGesture } from './useTabSwipeGesture';

const tabs: Tab[] = [
  {
    id: 'tab-a',
    agentDir: null,
    sessionId: null,
    view: 'launcher',
    title: 'A',
    sidecarConfigDisposition: 'push',
  },
  {
    id: 'tab-b',
    agentDir: null,
    sessionId: null,
    view: 'launcher',
    title: 'B',
    sidecarConfigDisposition: 'push',
  },
];

function Harness({ onSwitchTab = vi.fn() }: { onSwitchTab?: (tabId: string) => void }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  const activeTabIdRef = useRef<string | null>('tab-a');

  useTabSwipeGesture({
    contentRef,
    tabsRef,
    activeTabIdRef,
    onSwitchTab,
  });

  return (
    <div ref={contentRef} data-testid="tab-content">
      <div data-testid="pane-a" />
      <div
        data-testid="pane-b"
        className="pointer-events-none invisible"
        style={{ contentVisibility: 'hidden' }}
      />
    </div>
  );
}

function setContainerWidth(el: HTMLElement, width: number) {
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: width,
  });
}

function dispatchWheel(
  el: HTMLElement,
  init: WheelEventInit & { phase?: number; momentumPhase?: number },
) {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.phase !== undefined) {
    Object.defineProperty(event, 'phase', { configurable: true, value: init.phase });
  }
  if (init.momentumPhase !== undefined) {
    Object.defineProperty(event, 'momentumPhase', { configurable: true, value: init.momentumPhase });
  }
  el.dispatchEvent(event);
}

function phases(): string[] {
  return vi.mocked(console.debug).mock.calls
    .map(([line]) => String(line).match(/\bphase=([^ ]+)/)?.[1])
    .filter((phase): phase is string => Boolean(phase));
}

describe('useTabSwipeGesture Phase 0 trace', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreFrontendLogger();
    clearFrontendLogs();
    vi.restoreAllMocks();
  });

  it('emits unified-log perf phases for a horizontal swipe sample', () => {
    render(<Harness />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 120, deltaY: 2 });

    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_sample',
      'tab_swipe_direction_lock',
      'tab_swipe_begin',
      'tab_swipe_neighbor_prepare',
      'tab_swipe_update',
      'tab_swipe_idle_scheduled',
    ]));
  });

  it('logs zero-delta WebKit phase events before the existing early return', () => {
    const onSwitchTab = vi.fn();
    render(<Harness onSwitchTab={onSwitchTab} />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_sample',
      'tab_swipe_zero_delta_phase',
    ]));
    expect(phases()).not.toContain('tab_swipe_begin');
    expect(onSwitchTab).not.toHaveBeenCalled();
  });

  it('routes trace lines through the frontend logger unified-log store', () => {
    vi.restoreAllMocks();
    clearFrontendLogs();
    const messages: string[] = [];
    const unsubscribe = subscribeFrontendLogs((entry) => {
      messages.push(entry.message);
    });
    const originalConsole = getOriginalConsole();
    const originalLog = originalConsole.log;
    const originalDebug = originalConsole.debug;
    originalConsole.log = vi.fn();
    originalConsole.debug = vi.fn();
    initFrontendLogger();

    try {
      render(<Harness />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      dispatchWheel(content, { deltaX: 120, deltaY: 2 });

      expect(messages.some((message) => message.includes('[perf] trace=renderer phase=tab_swipe_begin'))).toBe(true);
      expect(messages.some((message) => message.includes('[perf] trace=renderer phase=tab_swipe_update'))).toBe(true);
    } finally {
      cleanup();
      originalConsole.log = originalLog;
      originalConsole.debug = originalDebug;
      unsubscribe();
    }
  });
});
