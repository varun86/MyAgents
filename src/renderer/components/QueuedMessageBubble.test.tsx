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

  it('does not render delivery-state tags next to queued messages', () => {
    render(
      <QueuedMessagesPanel
        messages={[
          {
            queueId: 'q-2',
            text: '第二条消息',
            timestamp: Date.now(),
            deliveryMode: 'turn',
          },
          {
            queueId: 'q-3',
            text: '第三条消息',
            timestamp: Date.now(),
            isInFlight: true,
            deliveryMode: 'realtime',
          },
        ]}
        onCancel={vi.fn()}
        onForceExecute={vi.fn()}
      />,
    );

    expect(screen.getByText('第二条消息')).toBeInTheDocument();
    expect(screen.getByText('第三条消息')).toBeInTheDocument();
    expect(screen.queryByText('下一轮')).not.toBeInTheDocument();
    expect(screen.queryByText('已发送')).not.toBeInTheDocument();
    expect(screen.queryByText('排队')).not.toBeInTheDocument();
  });
});
