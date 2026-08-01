/**
 * Agent Adapter 注册表
 */

import type { AgentAdapter } from '../types/adapter.js';

const adapters = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): AgentAdapter {
  if (!adapter?.id) throw new Error('Adapter must have an id');
  adapters.set(adapter.id, adapter);
  return adapter;
}

export function getAdapter(id: string): AgentAdapter | null {
  return adapters.get(id) || null;
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

export function clearAdapters(): void {
  adapters.clear();
}
