/**
 * Protocol 辅助函数 - 用于 provider/adapter 层归一化字段
 */

import type { StandardSystemBlock } from './standard-request.js';

/**
 * 将结构化的 system 字段扁平化为字符串
 * 适用于不支持 cache_control 的上游(OpenAI Chat / Responses / Ollama 等)
 */
export function systemToString(
  system: string | StandardSystemBlock[] | null | undefined,
): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).filter(Boolean).join('\n');
}

/**
 * 将结构化的 system 字段转换为字符串或 null(方便可选字段赋值)
 */
export function systemToStringOrNull(
  system: string | StandardSystemBlock[] | null | undefined,
): string | null {
  const s = systemToString(system);
  return s.length > 0 ? s : null;
}
