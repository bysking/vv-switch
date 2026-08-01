/**
 * 通过配置选择 Provider
 */

import type { Provider, ProviderConfig } from '../types/provider.js';
import { getProviderPlugin } from '../providers/registry.js';

export function providerTypeFromConfig(config: ProviderConfig): string {
  if (config.providerType) return config.providerType;
  switch (config.protocolType || 'chat') {
    case 'anthropic': return 'anthropic';
    case 'ollama': return 'ollama';
    case 'responses': return 'openai';
    case 'chat':
    default: return 'openai-compatible';
  }
}

export function getProviderForConfig(config: ProviderConfig): Provider | null {
  const providerType = providerTypeFromConfig(config);
  return getProviderPlugin(providerType);
}
