/**
 * 默认 Capability 探测器
 *
 * 一般情况下 Provider 在自己的 discover() 中提供默认能力图，
 * 这里仅用作 fallback。
 */

import { createCapabilityMap, CAPABILITY_STATUS } from './registry.js';
import type { CapabilityMap } from '../types/gateway.js';
import type { Provider, ProviderDiscoveryResult, ProviderConfig } from '../types/provider.js';

export function defaultCapabilitiesForProvider(providerType: string): CapabilityMap {
  switch (providerType) {
    case 'anthropic':
      return createCapabilityMap({
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.NATIVE,
        reasoning: CAPABILITY_STATUS.NATIVE,
        thinking: CAPABILITY_STATUS.NATIVE,
        json_schema: CAPABILITY_STATUS.PROXY,
        stream: CAPABILITY_STATUS.NATIVE,
        vision: CAPABILITY_STATUS.NATIVE,
        prompt_cache: CAPABILITY_STATUS.NATIVE,
      });
    case 'ollama':
      return createCapabilityMap({
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        thinking: CAPABILITY_STATUS.NATIVE,
      });
    case 'openai':
      return createCapabilityMap({
        chat: CAPABILITY_STATUS.NATIVE,
        responses: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.NATIVE,
        reasoning: CAPABILITY_STATUS.NATIVE,
        json_schema: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        vision: CAPABILITY_STATUS.NATIVE,
        image: CAPABILITY_STATUS.NATIVE,
        audio: CAPABILITY_STATUS.NATIVE,
        prompt_cache: CAPABILITY_STATUS.PROXY,
      });
    case 'openai-compatible':
    default:
      return createCapabilityMap({
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.PROXY,
        reasoning: CAPABILITY_STATUS.PROXY,
        thinking: CAPABILITY_STATUS.PROXY,
        json_schema: CAPABILITY_STATUS.PROXY,
        stream: CAPABILITY_STATUS.NATIVE,
        vision: CAPABILITY_STATUS.PROXY,
        image: CAPABILITY_STATUS.PROXY,
      });
  }
}

export async function detectCapabilities(
  provider: Provider | null,
  config: ProviderConfig,
): Promise<ProviderDiscoveryResult> {
  if (provider?.discover) {
    return provider.discover(config);
  }
  return {
    provider: provider?.id || 'unknown',
    capabilities: defaultCapabilitiesForProvider(provider?.id || 'openai-compatible'),
    models: [],
  };
}
