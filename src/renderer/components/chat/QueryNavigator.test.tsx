import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QueryNavigator from './QueryNavigator';
import type { Message } from '../../types/chat';

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

class MutationObserverMock {
  observe() {}
  disconnect() {}
}

function userMessage(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    content,
    timestamp: new Date('2026-05-26T00:00:00Z'),
  };
}

describe('QueryNavigator', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    vi.stubGlobal('MutationObserver', MutationObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the rail clear of the native message scrollbar gutter', () => {
    const scrollContainerRef = { current: document.createElement('div') };

    const { container } = render(
      <QueryNavigator
        historyMessages={[
          userMessage('u1', 'First question'),
          userMessage('u2', 'Second question'),
          userMessage('u3', 'Third question'),
        ]}
        streamingMessage={null}
        scrollContainerRef={scrollContainerRef}
        pauseAutoScroll={vi.fn()}
      />,
    );

    expect(container.firstElementChild).toHaveClass('right-4');
    expect(container.firstElementChild).not.toHaveClass('right-0');
  });
});
