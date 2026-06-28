export const IMAGE_UNDERSTANDING_TOOL_ID = 'image-understanding' as const;

export type OfficialToolId = typeof IMAGE_UNDERSTANDING_TOOL_ID;

export interface ImageUnderstandingToolSettings {
  providerId?: string;
  model?: string;
}

export interface OfficialToolSettings {
  imageUnderstanding?: ImageUnderstandingToolSettings;
}

export interface OfficialToolDefinition {
  id: OfficialToolId;
  name: string;
  description: string;
  badge: 'CLI';
  cliGroup: 'vision';
  requiresConfig: boolean;
}

export const OFFICIAL_TOOLS: readonly OfficialToolDefinition[] = [
  {
    id: IMAGE_UNDERSTANDING_TOOL_ID,
    name: '图片理解',
    description: '使用已配置的多模态模型分析图片，帮助文本主模型看懂截图、照片和图表。',
    badge: 'CLI',
    cliGroup: 'vision',
    requiresConfig: true,
  },
] as const;

const OFFICIAL_TOOL_ID_SET = new Set<string>(OFFICIAL_TOOLS.map(tool => tool.id));

export function isOfficialToolId(value: unknown): value is OfficialToolId {
  return typeof value === 'string' && OFFICIAL_TOOL_ID_SET.has(value);
}

export function normalizeOfficialToolIds(value: unknown): OfficialToolId[] {
  if (!Array.isArray(value)) return [];
  const ids: OfficialToolId[] = [];
  const seen = new Set<OfficialToolId>();
  for (const item of value) {
    if (!isOfficialToolId(item) || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function isImageUnderstandingToolConfigured(
  settings: OfficialToolSettings | undefined,
): boolean {
  const providerId = settings?.imageUnderstanding?.providerId?.trim();
  const model = settings?.imageUnderstanding?.model?.trim();
  return Boolean(providerId && model);
}
