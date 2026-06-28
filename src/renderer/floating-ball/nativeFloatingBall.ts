import { invoke } from '@tauri-apps/api/core';

import { i18n } from '@/i18n';
import { isTauriEnvironment } from '@/utils/browserMock';

interface FbCapabilities {
    supported: boolean;
    active: boolean;
}

export function describeNativeFloatingBallError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export async function setNativeFloatingBallEnabled(
    enabled: boolean,
    messages?: { unsupported?: string },
): Promise<void> {
    if (!isTauriEnvironment()) return;

    if (enabled) {
        const capabilities = await invoke<FbCapabilities>('cmd_fb_capabilities');
        if (!capabilities.supported) {
            throw new Error(messages?.unsupported ?? String(i18n.t('floatingBallPet.toasts.unsupportedSystem', { ns: 'settings' })));
        }
        await invoke('cmd_fb_enable');
        return;
    }

    await invoke('cmd_fb_disable');
}
