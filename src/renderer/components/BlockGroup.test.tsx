// Regression test for fold-suppression on user expand.
//
// A group of 6+ process blocks auto-folds the middle ones behind a 「展开全部」
// bar (and UNMOUNTS them — "collapse = unmount"). If the user has deliberately
// expanded a row, the fold must NOT kick in for that turn — otherwise it would
// unmount the row they opened and silently drop its expanded state. Expanding
// any row pins the group open (same effect as clicking 「展开全部」).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import BlockGroup from './BlockGroup';
import type { ContentBlock } from '@/types/chat';

afterEach(() => cleanup());

function thinking(i: number): ContentBlock {
  return { type: 'thinking', thinking: `REASON_${i}`, isComplete: true, thinkingDurationMs: 1000 } as ContentBlock;
}

describe('BlockGroup fold suppression', () => {
  it('folds 6 blocks, then suppresses the fold once a row is expanded', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => thinking(i));
    render(<BlockGroup blocks={blocks} isStreaming={false} />);

    // Folded: the 「展开全部」 bar's grid is open (1fr). Its nearest `.grid`
    // ancestor is the styled fold-bar container (the middle-zone grid is not
    // rendered while folded, so this is unambiguous).
    const foldBtn = screen.getByText('展开全部');
    const grid = foldBtn.closest('.grid') as HTMLElement;
    expect(grid.style.gridTemplateRows).toBe('1fr');

    // Expand the first (always-visible head) row.
    fireEvent.click(screen.getAllByRole('button')[0]);

    // Fold is now suppressed (grid collapsed) and the opened row's reasoning shows.
    expect(grid.style.gridTemplateRows).toBe('0fr');
    expect(screen.getByText(/REASON_0/)).toBeTruthy();
  });
});
