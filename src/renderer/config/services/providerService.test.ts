import { describe, expect, it } from 'vitest';

import {
    CODEX_SUBSCRIPTION_PROVIDER_ID,
    DEFAULT_CONFIG,
    MANAGED_CODEX_PROVIDER,
    applyProviderEnablementAndOrder,
    type Provider,
} from '../types';
import {
    getFirstAvailableProvider,
    isProviderAvailable,
    resolveBuiltinSelection,
} from './providerService';

const makeProvider = (id: string, primaryModel = `${id}-model`): Provider => ({
    id,
    name: id,
    vendor: 'Test',
    cloudProvider: 'Test',
    type: 'api',
    primaryModel,
    isBuiltin: false,
    authType: 'api_key',
    config: { baseUrl: `https://${id}.example/v1` },
    models: [{ model: primaryModel, modelName: `${id} Model`, modelSeries: 'test' }],
});

describe('provider availability with enablement', () => {
    it('treats disabled providers as unavailable even when they have credentials', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta')],
            { disabledProviderIds: ['alpha'] },
        );
        const alpha = providers.find(provider => provider.id === 'alpha');

        expect(alpha).toBeDefined();
        expect(isProviderAvailable(alpha!, { alpha: 'configured-key' }, {})).toBe(false);
    });

    it('first available provider follows user ordering and skips disabled providers', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta'), makeProvider('gamma')],
            {
                providerOrder: ['gamma', 'alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );

        expect(getFirstAvailableProvider(providers, {
            alpha: 'alpha-key',
            beta: 'beta-key',
            gamma: 'gamma-key',
        }, {})?.id).toBe('gamma');
    });

    it('builtin selection falls through from a disabled default provider', () => {
        const providers = applyProviderEnablementAndOrder(
            [makeProvider('alpha'), makeProvider('beta', 'beta-primary')],
            {
                providerOrder: ['alpha', 'beta'],
                disabledProviderIds: ['alpha'],
            },
        );
        const selection = resolveBuiltinSelection(
            {},
            { ...DEFAULT_CONFIG, defaultProviderId: 'alpha' },
            providers,
            {
                alpha: 'alpha-key',
                beta: 'beta-key',
            },
            {},
        );

        expect(selection?.provider.id).toBe('beta');
        expect(selection?.model).toBe('beta-primary');
    });

    it('requires runtime-backed providers to be explicitly marked ready by catalogue readiness', () => {
        expect(isProviderAvailable(
            MANAGED_CODEX_PROVIDER,
            {},
            { [CODEX_SUBSCRIPTION_PROVIDER_ID]: { status: 'valid', verifiedAt: '2026-06-26T00:00:00.000Z' } },
        )).toBe(false);

        expect(isProviderAvailable(
            { ...MANAGED_CODEX_PROVIDER, enabled: true },
            {},
            { [CODEX_SUBSCRIPTION_PROVIDER_ID]: { status: 'valid', verifiedAt: '2026-06-26T00:00:00.000Z' } },
        )).toBe(true);
    });
});
