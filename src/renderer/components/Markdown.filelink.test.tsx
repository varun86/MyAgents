import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openImagePreview: vi.fn(),
  readPreview: vi.fn(),
  readFileAsBlobUrl: vi.fn(),
}));

vi.mock('@/utils/openExternal', async () => {
  const actual = await vi.importActual<typeof import('@/utils/openExternal')>('@/utils/openExternal');
  return {
    ...actual,
    openExternal: mocks.openExternal,
  };
});

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: mocks.openImagePreview }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    readPreview: mocks.readPreview,
    readFileAsBlobUrl: mocks.readFileAsBlobUrl,
    checkPaths: vi.fn(),
    openWithDefault: vi.fn(),
    openInFinder: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';

import Markdown from './Markdown';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';

function renderMarkdown(markdown: string, onFilePreviewExternal = vi.fn()) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      onFilePreviewExternal={onFilePreviewExternal}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
  return { onFilePreviewExternal };
}

describe('Markdown local file links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPreview.mockResolvedValue({
      name: 'Message.tsx',
      content: 'export default function Message() {}',
      size: 36,
    });
  });

  it('opens workspace absolute path links in the MyAgents file preview instead of the system default app', async () => {
    const { onFilePreviewExternal } = renderMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx)`,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Message.tsx',
        path: 'src/renderer/components/Message.tsx',
        content: 'export default function Message() {}',
      }));
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('preserves line suffixes from clickable file links', async () => {
    const { onFilePreviewExternal } = renderMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx:42)`,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        path: 'src/renderer/components/Message.tsx',
        initialLineNumber: 42,
      }));
    });
  });

  it('falls back to openExternal for absolute links outside the active workspace', () => {
    renderMarkdown('[Other.ts](/Users/zhihu/Other/Other.ts)');

    fireEvent.click(screen.getByRole('link', { name: 'Other.ts' }));

    expect(mocks.openExternal).toHaveBeenCalledWith('/Users/zhihu/Other/Other.ts');
    expect(mocks.readPreview).not.toHaveBeenCalled();
  });
});
