// Behavior test for the "恢复对话" pill (Issue #309). The pill is opt-in
// session restore surfaced in the title bar only after a non-clean exit. We
// mock the Tauri-heavy deps (effects bail when isTauri() is false) and assert
// the pill's visibility gate + click wiring.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    ConfigActionsContext,
    ConfigDataContext,
    type ConfigActionsValue,
    type ConfigDataValue,
} from '@/config/ConfigProvider';
import { DEFAULT_CONFIG } from '@/config/types';

vi.mock('@/api/tauriClient', () => ({ isTauri: () => false }));
vi.mock('./FeedbackPopover', () => ({ default: () => null }));

import CustomTitleBar from './CustomTitleBar';

function renderBar(over: Partial<React.ComponentProps<typeof CustomTitleBar>> = {}) {
    const onRestoreSession = vi.fn();
    const onDismissRestore = vi.fn();
    const configData = {
        config: { ...DEFAULT_CONFIG, floatingBallDevGate: false, floatingBallEnabled: false },
        projects: [],
        providers: [],
        apiKeys: {},
        providerVerifyStatus: {},
        isLoading: false,
        error: null,
    } satisfies ConfigDataValue;
    const configActions = {
        updateConfig: async () => undefined,
    } as unknown as ConfigActionsValue;
    render(
        <ConfigDataContext.Provider value={configData}>
            <ConfigActionsContext.Provider value={configActions}>
                <CustomTitleBar
                    onRestoreSession={onRestoreSession}
                    onDismissRestore={onDismissRestore}
                    {...over}
                >
                    <div data-testid="tabbar" />
                </CustomTitleBar>
            </ConfigActionsContext.Provider>
        </ConfigDataContext.Provider>,
    );
    return { onRestoreSession, onDismissRestore };
}

describe('CustomTitleBar — 恢复对话 pill (Issue #309)', () => {
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
});
