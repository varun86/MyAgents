export type OpenClawConfigSnapshot = {
  channels: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

const CONFIG_GLOBAL_KEY = '__MYAGENTS_OPENCLAW_CONFIG__';

type ConfigGlobal = typeof globalThis & {
  [CONFIG_GLOBAL_KEY]?: OpenClawConfigSnapshot;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cloneConfig<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function inferOpenClawChannelKey(entryModule: string): string {
  let channelKey = entryModule.replace(/^@[^/]+\//, '');
  if (/lark|feishu/i.test(entryModule)) {
    channelKey = 'feishu';
  } else if (/qqbot|qq/i.test(entryModule)) {
    channelKey = 'qqbot';
  } else if (/dingtalk/i.test(entryModule)) {
    channelKey = 'dingtalk';
  } else if (/telegram/i.test(entryModule)) {
    channelKey = 'telegram';
  }
  return channelKey;
}

export function normalizeOpenClawConfig(value: unknown): OpenClawConfigSnapshot {
  const root = asRecord(value);
  const rawChannels = asRecord(root.channels);
  const channels: Record<string, Record<string, unknown>> = {};
  for (const [key, channelValue] of Object.entries(rawChannels)) {
    channels[key] = asRecord(channelValue);
  }
  return { ...root, channels };
}

export function buildOpenClawConfig(args: {
  entryModule: string;
  pluginConfig: Record<string, unknown>;
}): { channelKey: string; config: OpenClawConfigSnapshot } {
  const channelKey = inferOpenClawChannelKey(args.entryModule);
  const channelConfig = {
    enabled: true,
    ...args.pluginConfig,
    dmPolicy: 'open',
    groupPolicy: 'open',
  };
  return {
    channelKey,
    config: {
      channels: {
        [channelKey]: channelConfig,
      },
    },
  };
}

export function addOpenClawChannelAlias(
  config: OpenClawConfigSnapshot,
  alias: string | undefined,
  sourceKey: string,
): OpenClawConfigSnapshot {
  if (!alias || alias === sourceKey) return config;
  const source = config.channels[sourceKey];
  if (!source) return config;
  return {
    ...config,
    channels: {
      ...config.channels,
      [alias]: source,
    },
  };
}

export function setOpenClawConfigSnapshot(config: unknown): OpenClawConfigSnapshot {
  const normalized = normalizeOpenClawConfig(config);
  (globalThis as ConfigGlobal)[CONFIG_GLOBAL_KEY] = normalized;
  return normalized;
}

export function getOpenClawConfigSnapshot(): OpenClawConfigSnapshot {
  const snapshot = (globalThis as ConfigGlobal)[CONFIG_GLOBAL_KEY];
  return cloneConfig(snapshot ?? { channels: {} });
}
