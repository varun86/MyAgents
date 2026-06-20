import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, relative } from 'path';
import { randomUUID } from 'crypto';

import { USER_IMAGE_ATTACHMENT_MAX_BYTES } from '../../shared/fileTypes';
import { getAttachmentPath, saveAttachment } from '../SessionStore';
import type { ImagePayload, ResolvedImagePayload } from './types';
import { isAttachmentRefImagePayload, isInlineImagePayload } from './types';

export interface UserImageMessageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  relativePath: string;
  isImage: true;
}

export function messageAttachmentsFromImagePayloads(
  sessionId: string,
  images: ImagePayload[] | undefined,
): UserImageMessageAttachment[] {
  if (!images || images.length === 0) return [];
  const attachments: UserImageMessageAttachment[] = [];
  for (const img of images) {
    if (isAttachmentRefImagePayload(img)) {
      validateAttachmentRelativePath(img.relativePath, sessionId);
      attachments.push({
        id: img.id || randomUUID(),
        name: img.name,
        size: img.sizeBytes ?? 0,
        mimeType: img.mimeType,
        relativePath: img.relativePath,
        isImage: true,
      });
      continue;
    }
    if (!isInlineImagePayload(img)) continue;
    const size = assertInlineImageSize(img.name, img.data);
    const attachmentId = randomUUID();
    const relativePath = saveAttachment(sessionId, attachmentId, img.name, img.data, img.mimeType);
    attachments.push({
      id: attachmentId,
      name: img.name,
      size,
      mimeType: img.mimeType,
      relativePath,
      isImage: true,
    });
  }
  return attachments;
}

export function resolveImagePayloads(
  sessionId: string,
  images: ImagePayload[] | undefined,
): ResolvedImagePayload[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((img) => resolveImagePayload(sessionId, img));
}

export function resolveImagePayload(sessionId: string, img: ImagePayload): ResolvedImagePayload {
  if (isInlineImagePayload(img)) {
    const sizeBytes = assertInlineImageSize(img.name, img.data);
    return {
      kind: 'inline_base64',
      name: img.name,
      mimeType: img.mimeType,
      data: img.data,
      sizeBytes,
    };
  }

  if (!isAttachmentRefImagePayload(img)) {
    throw new Error('Invalid image payload');
  }

  validateAttachmentRelativePath(img.relativePath, sessionId);
  const root = getAttachmentPath('');
  const absolute = getAttachmentPath(img.relativePath);
  const leafMeta = lstatSync(absolute);
  if (leafMeta.isSymbolicLink()) {
    throw new Error(`Image attachment "${img.name}" is a symlink`);
  }
  if (!leafMeta.isFile()) {
    throw new Error(`Image attachment "${img.name}" is not a regular file`);
  }
  const rootCanonical = realpathSync(root);
  const canonical = realpathSync(absolute);
  const relFromRoot = relative(rootCanonical, canonical);
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    throw new Error(`Image attachment "${img.name}" escapes attachment storage`);
  }

  const fd = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fileMeta = fstatSync(fd);
    if (!fileMeta.isFile()) {
      throw new Error(`Image attachment "${img.name}" is not a regular file`);
    }
    if (fileMeta.size > USER_IMAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error(`图片 "${img.name}" 超过 10MB，无法作为图片附件发送`);
    }
    return {
      kind: 'inline_base64',
      name: img.name,
      mimeType: img.mimeType,
      data: readFileSync(fd).toString('base64'),
      sizeBytes: fileMeta.size,
    };
  } finally {
    closeSync(fd);
  }
}

function assertInlineImageSize(name: string, base64Data: string): number {
  const size = Buffer.from(base64Data, 'base64').length;
  if (size > USER_IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error(`图片 "${name}" 超过 10MB，无法作为图片附件发送`);
  }
  return size;
}

function validateAttachmentRelativePath(relativePath: string, expectedSessionId: string): void {
  const segments = relativePath.split('/');
  if (
    segments.length !== 2 ||
    segments.some((segment) =>
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('..') ||
      segment.includes('\\') ||
      Array.from(segment).some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    )
  ) {
    throw new Error('Invalid image attachment reference');
  }
  if (segments[0] !== expectedSessionId) {
    throw new Error('Image attachment does not belong to this session');
  }
}
