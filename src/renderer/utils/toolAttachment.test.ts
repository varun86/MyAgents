import { describe, expect, it } from 'vitest';

import { resolveTauriToolAttachmentUrl } from './toolAttachment';

describe('resolveTauriToolAttachmentUrl', () => {
  it('maps sidecar tool attachment API paths to the desktop custom scheme', () => {
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image.png'),
    ).toBe('myagents://tool-attachment/session-a/turn-b/image.png');
  });

  it('preserves encoded path segments', () => {
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image%20one.png'),
    ).toBe('myagents://tool-attachment/session-a/turn-b/image%20one.png');
  });

  it('does not rewrite unrelated attachment paths', () => {
    expect(resolveTauriToolAttachmentUrl('/api/attachment/session/file.png')).toBeNull();
    expect(resolveTauriToolAttachmentUrl('/generated/tool-attachments/s/t/file.png')).toBeNull();
  });
});
