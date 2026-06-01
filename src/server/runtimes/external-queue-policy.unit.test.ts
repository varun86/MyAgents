import { describe, it, expect } from 'vitest';
import { shouldQueueExternalSend, canDrainExternalQueue } from './external-queue-policy';

describe('shouldQueueExternalSend (defer mid-turn sends into the queue)', () => {
  it('running → defer (a turn is in flight; Codex would otherwise start a 2nd turn)', () => {
    expect(shouldQueueExternalSend('running', 0)).toBe(true);
  });
  it('idle + empty queue → send immediately', () => {
    expect(shouldQueueExternalSend('idle', 0)).toBe(false);
  });
  it('idle + non-empty queue → defer (preserve FIFO behind the pending item)', () => {
    expect(shouldQueueExternalSend('idle', 1)).toBe(true);
  });
  it('error + empty → send immediately (start fresh)', () => {
    expect(shouldQueueExternalSend('error', 0)).toBe(false);
  });
});

describe('canDrainExternalQueue (turn-end drain eligibility)', () => {
  it('idle + queued → drain one', () => {
    expect(canDrainExternalQueue('idle', 1)).toBe(true);
  });
  it('running + queued → NOT yet (wait for turn end)', () => {
    expect(canDrainExternalQueue('running', 2)).toBe(false);
  });
  it('idle + empty → nothing to do', () => {
    expect(canDrainExternalQueue('idle', 0)).toBe(false);
  });
  it('error + queued → not drained on the error idle path here', () => {
    expect(canDrainExternalQueue('error', 1)).toBe(false);
  });
});
