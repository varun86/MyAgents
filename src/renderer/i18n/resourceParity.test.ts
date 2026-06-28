import { describe, expect, it } from 'vitest';

import { resources } from './index';

function flattenResource(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, child]) => {
    Object.assign(acc, flattenResource(child, prefix ? `${prefix}.${key}` : key));
    return acc;
  }, {});
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(match => match[1] ?? '').sort();
}

describe('renderer i18n resource parity', () => {
  it.each(['chat', 'launcher', 'settings'] as const)('%s keeps zh-CN and en-US keys aligned', (namespace) => {
    const zh = flattenResource(resources['zh-CN'][namespace]);
    const en = flattenResource(resources['en-US'][namespace]);

    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh)) {
      expect(interpolationNames(en[key] ?? '')).toEqual(interpolationNames(zh[key] ?? ''));
    }
  });
});
