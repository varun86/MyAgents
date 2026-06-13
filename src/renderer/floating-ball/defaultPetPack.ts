import minoSpritesheetUrl from '@/assets/floating-pets/mino/spritesheet.webp';

import { CODEX_PET_ATLAS, type PetPack } from './petAtlas';

export const MINO_DEFAULT_PET_PACK: PetPack = {
    id: 'mino-default',
    displayName: 'Mino',
    description: '内置宠物 · 默认',
    source: 'builtin',
    spritesheetUrl: minoSpritesheetUrl,
    atlas: CODEX_PET_ATLAS,
};

export const MINO_MONO_PET_PACK: PetPack = {
    ...MINO_DEFAULT_PET_PACK,
    id: 'mino-mono',
    displayName: 'Mino Mono',
    description: '低饱和 · 更安静',
    spriteFilter: 'saturate(0.62) contrast(1.04) brightness(0.98) drop-shadow(0 2px 2px color-mix(in srgb, var(--ink) 18%, transparent))',
};

export const MINO_FOCUS_PET_PACK: PetPack = {
    ...MINO_DEFAULT_PET_PACK,
    id: 'mino-focus',
    displayName: 'Mino Focus',
    description: '轻提亮 · 更聚焦',
    spriteFilter: 'saturate(0.92) contrast(1.08) brightness(1.04) drop-shadow(0 2px 2px color-mix(in srgb, var(--accent) 16%, transparent))',
};

export const BUILTIN_PET_PACKS = [
    MINO_DEFAULT_PET_PACK,
    MINO_MONO_PET_PACK,
    MINO_FOCUS_PET_PACK,
] as const;
