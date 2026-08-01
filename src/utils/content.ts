/**
 * 内容块辅助：在 Anthropic / Responses / Chat 三种 content block 表达之间互转
 */

import { toSafeString } from './string.js';

export interface ChatContentImageUrl {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export type ChatContentPart = string | ChatContentImageUrl;

/**
 * 将 Responses API content block 转换为 Chat Completions content part
 */
export function responsesContentBlockToChatPart(c: unknown): ChatContentPart | null {
  if (typeof c !== 'object' || c === null) return null;
  const block = c as Record<string, unknown>;
  const cType = (block.type as string) || '';

  if (cType === 'input_text') {
    return toSafeString(block.text);
  }

  if (cType === 'input_image') {
    if (typeof block.image_url === 'string') {
      return { type: 'image_url', image_url: { url: block.image_url } };
    }
    if (typeof block.file_id === 'string') {
      return { type: 'image_url', image_url: { url: block.file_id, detail: 'auto' } };
    }
    if (block.source && typeof block.source === 'object') {
      const src = block.source as Record<string, unknown>;
      const mediaType = (src.media_type as string) || 'image/png';
      const data = (src.data as string) || '';
      if (data) {
        return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
      }
    }
    return '[image]';
  }

  return toSafeString(block.text);
}

/**
 * 将 Anthropic content block 转换为字符串
 */
export function anthropicContentToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text') {
          parts.push(toSafeString(b.text));
        } else if (b.type === 'image') {
          parts.push('[image]');
        } else if (b.type !== 'thinking') {
          // skip thinking, fall back to text for others
          parts.push(toSafeString(b.text));
        }
      }
    }
    return parts.join('\n');
  }
  return String(content);
}
