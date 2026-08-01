/**
 * Capability 注册表与工具函数
 */

import { CAPABILITY_STATUS } from '../types/gateway.js';
import type { CapabilityMap, CapabilityStatus } from '../types/gateway.js';

export { CAPABILITY_STATUS };
export type { CapabilityMap, CapabilityStatus };

export const CAPABILITY_KEYS: Array<keyof CapabilityMap> = [
  'chat',
  'responses',
  'vision',
  'image',
  'audio',
  'tool_call',
  'parallel_tool',
  'reasoning',
  'thinking',
  'json_schema',
  'stream',
  'mcp',
  'computer_use',
  'batch',
  'cache',
  'prompt_cache',
];

export function createCapabilityMap(overrides: Partial<CapabilityMap> = {}): CapabilityMap {
  const result = {} as CapabilityMap;
  for (const key of CAPABILITY_KEYS) {
    result[key] = CAPABILITY_STATUS.UNSUPPORTED;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (CAPABILITY_KEYS.includes(key as keyof CapabilityMap)) {
      result[key as keyof CapabilityMap] = normalizeCapabilityStatus(value);
    }
  }
  return result;
}

export function normalizeCapabilityStatus(value: unknown): CapabilityStatus {
  if (typeof value === 'string' && (Object.values(CAPABILITY_STATUS) as string[]).includes(value)) {
    return value as CapabilityStatus;
  }
  if (value === true) return CAPABILITY_STATUS.NATIVE;
  return CAPABILITY_STATUS.UNSUPPORTED;
}

export function supportsCapability(
  capabilities: Partial<CapabilityMap> | undefined,
  key: keyof CapabilityMap,
): boolean {
  const status = normalizeCapabilityStatus(capabilities?.[key]);
  return status !== CAPABILITY_STATUS.UNSUPPORTED;
}
