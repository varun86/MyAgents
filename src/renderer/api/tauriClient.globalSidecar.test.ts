import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

vi.mock('@/utils/browserMock', () => ({
    isTauriEnvironment: () => true,
}));

async function loadClient() {
    vi.resetModules();
    return import('./tauriClient');
}

describe('tauriClient global sidecar readiness', () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
    });

    it('uses Rust sidecar state instead of a same-webview ready promise', async () => {
        mocks.invoke.mockResolvedValue('http://127.0.0.1:31415');
        const { getGlobalServerUrlWithWait } = await loadClient();

        await expect(getGlobalServerUrlWithWait()).resolves.toBe('http://127.0.0.1:31415');

        expect(mocks.invoke).toHaveBeenCalledWith('cmd_get_global_server_url');
    });

    it('polls Rust until the global sidecar becomes available', async () => {
        let attempts = 0;
        mocks.invoke.mockImplementation(async (cmd: string) => {
            if (cmd !== 'cmd_get_global_server_url') return undefined;
            attempts++;
            if (attempts < 3) throw new Error('No running sidecar for tab __global__');
            return 'http://127.0.0.1:31416';
        });
        const { getGlobalServerUrlWithWait } = await loadClient();

        await expect(getGlobalServerUrlWithWait()).resolves.toBe('http://127.0.0.1:31416');
        expect(attempts).toBe(3);
    });

    it('times out with the last Rust-side failure in the error message', async () => {
        mocks.invoke.mockRejectedValue(new Error('No running sidecar for tab __global__'));
        const { waitForGlobalSidecar } = await loadClient();

        await expect(waitForGlobalSidecar(20)).rejects.toThrow(
            /Global sidecar startup timeout after 20ms .*No running sidecar for tab __global__/,
        );
    });
});
