// Regression test: a thinking block must NOT auto-expand while streaming.
//
// Previously a live (streaming) thinking block auto-expanded and then auto-
// collapsed on completion — the expand→collapse made the page jump during
// streaming. We deliberately removed that: thinking blocks are now collapsed by
// default and only open on user click (like tool blocks), while the collapsed
// header still shows the live "思考中…" indicator. This test guards against the
// auto-expand reappearing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import ProcessRow from './ProcessRow';
import type { ContentBlock } from '@/types/chat';

afterEach(() => cleanup());

const REASONING = 'secret reasoning detail';

function thinkingBlock(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return { type: 'thinking', thinking: REASONING, isComplete: false, ...overrides } as ContentBlock;
}

describe('ProcessRow thinking block expand behaviour', () => {
  it('does NOT auto-expand a live (streaming) thinking block', () => {
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming />);
    // Collapsed: the reasoning body is unmounted …
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
    // … but the live "thinking" indicator is still shown.
    expect(screen.getByText(/思考中/)).toBeTruthy();
  });

  it('expands only when the user clicks the row', () => {
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming />);
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
    fireEvent.click(screen.getByRole('button')); // the header is the only button while collapsed
    expect(screen.getByText(new RegExp(REASONING, 'i'))).toBeTruthy();
  });

  it('signals onUserExpand when opened, but not when collapsing', () => {
    const onUserExpand = vi.fn();
    render(<ProcessRow block={thinkingBlock()} index={0} totalBlocks={1} isStreaming onUserExpand={onUserExpand} />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // open
    expect(onUserExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(btn); // collapse — must NOT re-signal
    expect(onUserExpand).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed thinking block collapsed by default', () => {
    render(
      <ProcessRow
        block={thinkingBlock({ isComplete: true, thinkingDurationMs: 3000 })}
        index={0}
        totalBlocks={1}
        isStreaming={false}
      />,
    );
    expect(screen.queryByText(new RegExp(REASONING, 'i'))).toBeNull();
  });
});
