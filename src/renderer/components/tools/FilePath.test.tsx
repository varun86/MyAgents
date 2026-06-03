import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPaths: vi.fn(),
  openImagePreview: vi.fn(),
  openWithDefault: vi.fn(),
  openInFinder: vi.fn(),
  readPreview: vi.fn(),
  onInsertReference: vi.fn(),
}));

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: mocks.openImagePreview }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    checkPaths: mocks.checkPaths,
    openWithDefault: mocks.openWithDefault,
    openInFinder: mocks.openInFinder,
    readPreview: mocks.readPreview,
    readFileAsBlobUrl: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';

import { FilePath } from './utils';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';
const FILE_PATH = `${WORKSPACE}/src/renderer/components/tools/utils.tsx`;
const DIR_PATH = `${WORKSPACE}/src/renderer/components/tools`;
const MISSING_PATH = `${WORKSPACE}/src/renderer/components/tools/gone.ts`;

function renderFilePath(path: string) {
  render(
    <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
      <FilePath path={path} />
    </FileActionProvider>,
  );
}

describe('FilePath tool chip — clickable file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openWithDefault.mockResolvedValue(undefined);
    mocks.openInFinder.mockResolvedValue(undefined);
  });

  it('renders a real file as an interactive chip and opens the action menu on click', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [FILE_PATH]: { exists: true, type: 'file' } } });
    renderFilePath(FILE_PATH);

    // First paint is a plain chip; becomes interactive after the batched existence check resolves.
    const chip = await waitFor(() => {
      const el = screen.getByText(FILE_PATH);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(chip.getAttribute('title')).toBe(`文件: ${FILE_PATH}`);

    fireEvent.click(chip);

    // File menu surfaces the same actions as inline paths in AI text.
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();
    expect(screen.getByText('打开')).toBeInTheDocument();
    expect(screen.getByText('打开所在文件夹')).toBeInTheDocument();

    fireEvent.click(screen.getByText('引用'));
    expect(mocks.onInsertReference).toHaveBeenCalledWith([FILE_PATH]);
  });

  it('keeps a non-existent path as a plain chip with no menu', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [MISSING_PATH]: { exists: false, type: 'file' } } });
    renderFilePath(MISSING_PATH);

    // Wait for the existence check to flush, then assert it stayed plain.
    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalled());
    const chip = screen.getByText(MISSING_PATH);
    expect(chip).not.toHaveClass('cursor-pointer');

    fireEvent.click(chip);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
    expect(screen.queryByText('打开')).not.toBeInTheDocument();
  });

  it('omits 预览 for directories and labels them as folders', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [DIR_PATH]: { exists: true, type: 'dir' } } });
    renderFilePath(DIR_PATH);

    const chip = await waitFor(() => {
      const el = screen.getByText(DIR_PATH);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(chip.getAttribute('title')).toBe(`文件夹: ${DIR_PATH}`);

    fireEvent.click(chip);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();
    expect(screen.getByText('打开所在文件夹')).toBeInTheDocument();
  });
});
