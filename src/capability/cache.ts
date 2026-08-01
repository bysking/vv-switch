/**
 * Discovery 结果缓存（内存 + 本地文件）
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderDiscoveryResult } from '../types/provider.js';

const DEFAULT_CACHE_FILE = join(homedir(), '.vv-switch-capability-cache.json');
const memoryCache = new Map<string, ProviderDiscoveryResult>();

export interface CacheKeyInput {
  providerType?: string;
  protocolType?: string;
  baseUrl?: string;
  model?: string;
}

export function discoveryCacheKey(providerConfig: CacheKeyInput = {}): string {
  return [
    providerConfig.providerType || providerConfig.protocolType || 'unknown',
    providerConfig.baseUrl || '',
    providerConfig.model || '',
  ].join('|');
}

export function getCachedDiscovery(key: string, cacheFile: string = DEFAULT_CACHE_FILE): ProviderDiscoveryResult | null {
  if (memoryCache.has(key)) return memoryCache.get(key)!;
  if (!existsSync(cacheFile)) return null;
  try {
    const data = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, ProviderDiscoveryResult>;
    const value = data[key] || null;
    if (value) memoryCache.set(key, value);
    return value;
  } catch {
    return null;
  }
}

export function setCachedDiscovery(
  key: string,
  value: ProviderDiscoveryResult,
  cacheFile: string = DEFAULT_CACHE_FILE,
): ProviderDiscoveryResult {
  memoryCache.set(key, value);
  let data: Record<string, ProviderDiscoveryResult> = {};
  if (existsSync(cacheFile)) {
    try {
      data = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Record<string, ProviderDiscoveryResult>;
    } catch { data = {}; }
  }
  data[key] = value;
  try {
    writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* ignore */ }
  return value;
}

export function clearMemoryDiscoveryCache(): void {
  memoryCache.clear();
}

/**
 * 清空全部 discovery 缓存（内存 + 文件）。
 *
 * 用于进程启动时强制重新探测上游能力：provider 代码声明的能力可能随版本更新
 * （例如新增 thinking/image 字段），而文件缓存会掩盖这一变化，导致
 * ensureCapabilities 仍按旧能力图判定为不支持。每次启动清一次，首个请求
 * 触发重新 discover 并写回最新能力图。
 */
export function clearDiscoveryCache(cacheFile: string = DEFAULT_CACHE_FILE): void {
  memoryCache.clear();
  try {
    if (existsSync(cacheFile)) {
      unlinkSync(cacheFile);
    }
  } catch { /* ignore */ }
}
