import { describe, expect, it } from 'vitest';

import {
  canResumeAcrossProviderBoundary,
  getProviderHistoryIdentity,
  normalizeProviderBaseUrl,
} from './providerHistory';

describe('provider resume boundary', () => {
  it('treats Anthropic subscription and official API as one signed-history family', () => {
    expect(getProviderHistoryIdentity(undefined)).toBe('anthropic');
    expect(getProviderHistoryIdentity({ baseUrl: 'https://api.anthropic.com/' })).toBe('anthropic');

    expect(canResumeAcrossProviderBoundary(undefined, { baseUrl: 'https://api.anthropic.com' })).toBe(true);
  });

  it('allows resume within the same third-party provider identity even when credentials rotate', () => {
    const first = { baseUrl: 'https://api.deepseek.com/anthropic/', apiProtocol: 'anthropic' as const };
    const second = { baseUrl: 'https://api.deepseek.com/anthropic', apiProtocol: 'anthropic' as const };

    expect(canResumeAcrossProviderBoundary(first, second)).toBe(true);
  });

  it('blocks resume across third-party provider boundaries', () => {
    expect(canResumeAcrossProviderBoundary(
      { baseUrl: 'https://api.moonshot.cn/anthropic' },
      { baseUrl: 'https://api.deepseek.com/anthropic' },
    )).toBe(false);
  });

  it('blocks resume when the same endpoint changes protocol family', () => {
    expect(canResumeAcrossProviderBoundary(
      { baseUrl: 'https://api.example.com/v1', apiProtocol: 'anthropic' },
      { baseUrl: 'https://api.example.com/v1', apiProtocol: 'openai' },
    )).toBe(false);
  });

  it('normalizes trailing slashes without guessing path semantics', () => {
    expect(normalizeProviderBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
    expect(normalizeProviderBaseUrl('not a url///')).toBe('not a url');
  });
});
