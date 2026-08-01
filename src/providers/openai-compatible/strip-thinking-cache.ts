/**
 * openai-compatible provider 运行时 thinking 学习缓存
 *
 * 首次请求带 thinking 参数时，若上游返回 5xx（如火山 chat 端点对 thinking
 * 返回 500 InternalServiceError），剥离 thinking 重试成功后，记忆「该上游需
 * 剥离 thinking」，后续请求首次即剥离，不再触发 5xx。
 *
 * 进程内内存，工具（provider 进程）存活期间复用，重启重新学习。
 * 不持久化：5xx 可能是临时故障，重启后重新探测，避免误学固化。
 */

import type { ProviderConfig } from '../../types/provider.js';

const learned = new Map<string, boolean>();

function cacheKey(config: ProviderConfig): string {
  return ['openai-compatible', config.baseUrl || '', config.model || ''].join('|');
}

/** 是否已学习到该上游需剥离 thinking */
export function getLearnedStripThinking(config: ProviderConfig): boolean {
  return learned.get(cacheKey(config)) === true;
}

/** 记忆该上游需剥离 thinking（剥离重试成功后调用） */
export function markStripThinking(config: ProviderConfig): void {
  learned.set(cacheKey(config), true);
}

/** 测试 / 重置用：清空学习缓存 */
export function clearLearnedStripThinking(): void {
  learned.clear();
}
