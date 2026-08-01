/**
 * 供应商持久化管理
 *
 * 管理 ~/.vv-switch-providers.json 文件的读写。
 *
 * 供应商标记：
 *   activeForClaude: boolean — 是否已应用到 Claude Code
 *   activeForCodex:  boolean — 是否已应用到 OpenAI Codex
 *
 * 允许不同供应商分别应用于 Claude 和 Codex。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const PROVIDERS_FILE = join(homedir(), '.vv-switch-providers.json');

/**
 * 从文件加载供应商列表，文件不存在时返回空数组。
 */
export function loadProviders() {
  if (!existsSync(PROVIDERS_FILE)) return [];
  try {
    const content = readFileSync(PROVIDERS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * 将供应商列表写入文件。
 */
export function saveProviders(providers) {
  const dir = homedir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2), 'utf-8');
}

/**
 * 添加或更新供应商。有 id 则更新，无 id 则新建。
 */
export function upsertProvider(data) {
  const providers = loadProviders();
  const now = new Date().toISOString();

  if (data.id) {
    const index = providers.findIndex(p => p.id === data.id);
    if (index >= 0) {
      providers[index] = { ...providers[index], ...data, updatedAt: now };
    } else {
      providers.push({
        id: data.id,
        name: data.name || '',
        baseUrl: data.baseUrl || '',
        apiKey: data.apiKey || '',
        model: data.model || '',
        protocolType: data.protocolType || 'anthropic',
        modelCapabilities: data.modelCapabilities || { thinking: true, vision: false, audio: false, video: false, functionCalling: true, contextWindow: 1048576, maxOutputTokens: 0, promptCache: false },
        modelOptions: Array.isArray(data.modelOptions) ? data.modelOptions : ['deepseek-v4-flash', 'deepseek-v4-pro'],
        activeForClaude: false,
        activeForCodex: false,
        createdAt: now,
        updatedAt: now,
      });
  }
  } else {
    providers.push({
      id: randomUUID(),
      name: data.name || '',
      baseUrl: data.baseUrl || '',
      apiKey: data.apiKey || '',
      model: data.model || '',
      protocolType: data.protocolType || 'anthropic',
      modelCapabilities: data.modelCapabilities || { thinking: true, vision: false, audio: false, video: false, functionCalling: true, contextWindow: 1048576, maxOutputTokens: 0, promptCache: false },
      modelOptions: Array.isArray(data.modelOptions) ? data.modelOptions : ['deepseek-v4-flash', 'deepseek-v4-pro'],
      activeForClaude: false,
      activeForCodex: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveProviders(providers);
  return providers.find(p => p.id === (data.id || providers[providers.length - 1].id));
}

/**
 * 按给定 id 数组顺序重排供应商列表并持久化（拖拽排序）。
 *
 * 容错处理：
 *   - 忽略不存在或重复的 id；
 *   - 文件中存在但未出现在 ids 里的供应商，按原顺序追加到末尾，
 *     避免并发/脏数据导致供应商丢失。
 *
 * 返回重排后的供应商数组。
 */
export function reorderProviders(ids: string[]) {
  const providers = loadProviders() as any[];
  if (!Array.isArray(ids) || ids.length === 0) return providers;

  const byId = new Map(providers.map(p => [p.id, p]));
  const seen = new Set<string>();
  const ordered: any[] = [];

  for (const id of ids) {
    const provider = byId.get(id);
    if (provider && !seen.has(id)) {
      ordered.push(provider);
      seen.add(id);
    }
  }
  // 未出现在 ids 中的供应商按原顺序追加到末尾
  for (const provider of providers) {
    if (!seen.has(provider.id)) ordered.push(provider);
  }

  saveProviders(ordered);
  return ordered;
}

/**
 * 删除供应商。
 */
export function deleteProvider(id: any) {
  const providers = loadProviders() as any[];
  const filtered = providers.filter(p => p.id !== id);
  if (filtered.length === providers.length) return false;
  saveProviders(filtered);
  return true;
}

/**
 * 获取单个供应商。
 */
export function getProvider(id) {
  return loadProviders().find(p => p.id === id) || null;
}

/**
 * 获取当前应用于 Claude 的供应商。
 */
export function getActiveForClaude() {
  return loadProviders().find(p => p.activeForClaude) || null;
}

/**
 * 获取当前应用于 Codex 的供应商。
 */
export function getActiveForCodex() {
  return loadProviders().find(p => p.activeForCodex) || null;
}

/**
 * 获取当前应用于 OpenAI Chat Completions 端点（/v1/chat/completions，如 VS Code Copilot）的供应商。
 */
export function getActiveForOpenai() {
  return loadProviders().find(p => p.activeForOpenai) || null;
}

/**
 * 将指定供应商应用到指定目标（claude / codex / openai）。
 * 应用时会清除其他供应商在对应目标上的活跃状态。
 */
export function markActiveFor(providerId, targets) {
  const providers = loadProviders();
  const hasClaude = targets.includes('claude');
  const hasCodex = targets.includes('codex');
  const hasOpenai = targets.includes('openai');

  for (const p of providers) {
    if (p.id === providerId) {
      // 只更新本次涉及的 target，不改变另一个 target 的状态
      if (hasClaude) p.activeForClaude = true;
      if (hasCodex) p.activeForCodex = true;
      if (hasOpenai) p.activeForOpenai = true;
    } else {
      // 取消其他供应商在对应目标上的活跃状态
      if (hasClaude) p.activeForClaude = false;
      if (hasCodex) p.activeForCodex = false;
      if (hasOpenai) p.activeForOpenai = false;
    }
  }

  saveProviders(providers);
  return providers.find(p => p.id === providerId) || null;
}

/**
 * 清除所有供应商在指定目标上的活跃状态。
 */
export function clearActiveFor(targets) {
  const providers = loadProviders();
  const hasClaude = targets.includes('claude');
  const hasCodex = targets.includes('codex');
  const hasOpenai = targets.includes('openai');
  let changed = false;

  for (const p of providers) {
    if (hasClaude && p.activeForClaude) { p.activeForClaude = false; changed = true; }
    if (hasCodex && p.activeForCodex) { p.activeForCodex = false; changed = true; }
    if (hasOpenai && p.activeForOpenai) { p.activeForOpenai = false; changed = true; }
  }

  if (changed) saveProviders(providers);
}
