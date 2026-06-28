// Behavior test for the "恢复对话" pill (Issue #309). The pill is opt-in
// session restore surfaced in the title bar only after a non-clean exit. We
// mock the Tauri-heavy deps (effects bail when isTauri() is false) and assert
// the pill's visibility gate + click wiring.
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isTauri: vi.fn(() => false),
}));

vi.mock('@/api/tauriClient', () => ({ isTauri: () => mocks.isTauri() }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        close: vi.fn(),
        isFullscreen: vi.fn().mockResolvedValue(false),
        isMaximized: vi.fn().mockResolvedValue(false),
        maximize: vi.fn(),
        minimize: vi.fn(),
        unmaximize: vi.fn(),
    }),
}));
vi.mock('./FeedbackPopover', () => ({ default: () => null }));

import { i18n } from '@/i18n';
import CustomTitleBar from './CustomTitleBar';

function renderBar(over: Partial<React.ComponentProps<typeof CustomTitleBar>> = {}) {
    const onRestoreSession = vi.fn();
    const onDismissRestore = vi.fn();
    const result = render(
        <CustomTitleBar
            onRestoreSession={onRestoreSession}
            onDismissRestore={onDismissRestore}
            {...over}
        >
            <div data-testid="tabbar" />
        </CustomTitleBar>,
    );
    return { ...result, onRestoreSession, onDismissRestore };
}

describe('CustomTitleBar — 恢复对话 pill (Issue #309)', () => {
    beforeEach(async () => {
        mocks.isTauri.mockReturnValue(false);
        await i18n.changeLanguage('zh-CN');
    });

    it('is hidden when restoreCount is 0 (clean quit → no nag)', () => {
        renderBar({ restoreCount: 0 });
        expect(screen.queryByText('恢复上次对话')).toBeNull();
    });

    it('shows the pill and the count badge when there are restorable tabs', () => {
        renderBar({ restoreCount: 3 });
        expect(screen.getByText('恢复上次对话')).toBeTruthy();
        expect(screen.getByText('3')).toBeTruthy();
    });

    it('omits the count badge for a single conversation', () => {
        renderBar({ restoreCount: 1 });
        expect(screen.getByText('恢复上次对话')).toBeTruthy();
        expect(screen.queryByText('1')).toBeNull();
    });

    it('restores on body click, dismisses on ✕ click', () => {
        const { onRestoreSession, onDismissRestore } = renderBar({ restoreCount: 2 });

        fireEvent.click(screen.getByText('恢复上次对话'));
        expect(onRestoreSession).toHaveBeenCalledTimes(1);
        expect(onDismissRestore).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTitle('忽略'));
        expect(onDismissRestore).toHaveBeenCalledTimes(1);
        expect(onRestoreSession).toHaveBeenCalledTimes(1);
    });

    it('keeps explicit draggable regions around and between titlebar actions', () => {
        const { container } = renderBar({ restoreCount: 0 });
        const tauriDragRegions = Array.from(container.querySelectorAll('[data-tauri-drag-region]'));
        const tabbarHost = screen.getByTestId('tabbar').parentElement;

        expect(tauriDragRegions.length).toBeGreaterThanOrEqual(4);
        expect(tauriDragRegions.some((node) => (node as HTMLElement).style.width === '30px')).toBe(true);
        expect(tauriDragRegions.some((node) => (node as HTMLElement).className.includes('w-1'))).toBe(true);
        expect(container.querySelector('[data-myagents-titlebar-drag-region]')).toBeNull();
        expect(tabbarHost?.className).toContain('flex-1');
    });

    it('renders titlebar action labels in English', async () => {
        mocks.isTauri.mockReturnValue(true);
        await i18n.changeLanguage('en-US');

        renderBar({ teamSpaceEnabled: true, onSettingsClick: vi.fn() });

        expect(screen.getByRole('button', { name: 'AI Helper' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Team' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
        expect(screen.queryByText('小助理')).not.toBeInTheDocument();
        expect(screen.queryByText('任务')).not.toBeInTheDocument();
        expect(screen.queryByText('设置')).not.toBeInTheDocument();
    });
});
