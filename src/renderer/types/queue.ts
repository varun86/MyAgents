/** Lightweight image info for queued messages (no File blob to avoid memory leaks) */
export interface QueuedImageInfo {
  id: string;
  name: string;
  preview: string; // data URL for preview display
  mimeType?: string;
  sizeBytes?: number;
  source?: 'inline_base64' | 'attachment_ref';
  relativePath?: string;
}

export interface QueuedMessageInfo {
  queueId: string;
  text: string;                // Original text, for cancel → restore to input
  images?: QueuedImageInfo[];  // Lightweight image info for display and restore
  timestamp: number;
  deliveryMode?: 'realtime' | 'turn';
  /**
   * True when this queue item has already been yielded to the SDK CLI
   * subprocess and is waiting to be drained into AI's context. It is still
   * conditionally cancellable: cancel uses SDK cancel_async_message and
   * succeeds only before the SDK dequeues it. The play (▷ force-execute)
   * button interrupts the current turn so AI processes the queued message
   * right away instead of after the next tool break.
   */
  isInFlight?: boolean;
}
