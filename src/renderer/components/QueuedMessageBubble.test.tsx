import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import QueuedMessagesPanel from './QueuedMessageBubble';

describe('QueuedMessagesPanel', () => {
  it('keeps the cancel button available for the in-flight head item', async () => {
    const onCancel = vi.fn();
    const onForceExecute = vi.fn();

    render(
      <QueuedMessagesPanel
        messages={[{
          queueId: 'q-1',
          text: '检查一下排队消息',
          timestamp: Date.now(),
          isInFlight: true,
        }]}
        onCancel={onCancel}
        onForceExecute={onForceExecute}
      />,
    );

    await userEvent.click(screen.getByTitle('撤回发送'));
    expect(onCancel).toHaveBeenCalledWith('q-1');
  });
});
