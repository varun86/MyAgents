import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ChatBootOverlay from './ChatBootOverlay';

describe('ChatBootOverlay', () => {
  it('uses the same elevated paper background as the loaded chat page', () => {
    render(<ChatBootOverlay />);

    const overlay = screen.getByText('AI 启动中').closest('div')?.parentElement;

    expect(overlay).toHaveClass('bg-[var(--paper-elevated)]/80');
    expect(overlay).not.toHaveClass('bg-[var(--paper)]/80');
  });
});
