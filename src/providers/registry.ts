/**
 * Provider 注册表
 */

import type { Provider } from '../types/provider.js';

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): Provider {
  if (!provider?.id) throw new Error('Provider must have an id');
  providers.set(provider.id, provider);
  return provider;
}

export function getProviderPlugin(id: string): Provider | null {
  return providers.get(id) || null;
}

export function listProviderPlugins(): string[] {
  return [...providers.keys()];
}

export function clearProviderPlugins(): void {
  providers.clear();
}
