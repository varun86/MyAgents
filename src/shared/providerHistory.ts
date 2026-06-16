export type ProviderHistoryEnv = {
  baseUrl?: string;
  apiProtocol?: 'anthropic' | 'openai';
};

export function normalizeProviderBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

export function getProviderHistoryIdentity(providerEnv?: ProviderHistoryEnv): string {
  const normalizedBaseUrl = normalizeProviderBaseUrl(providerEnv?.baseUrl);
  if (!providerEnv || !normalizedBaseUrl || normalizedBaseUrl === 'https://api.anthropic.com') {
    return 'anthropic';
  }
  return `third-party:${providerEnv.apiProtocol ?? 'anthropic'}:${normalizedBaseUrl}`;
}

export function canResumeAcrossProviderBoundary(
  currentProviderEnv?: ProviderHistoryEnv,
  nextProviderEnv?: ProviderHistoryEnv,
): boolean {
  return getProviderHistoryIdentity(currentProviderEnv) === getProviderHistoryIdentity(nextProviderEnv);
}
