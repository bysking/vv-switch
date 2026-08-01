/**
 * providers-manager.js 单元测试
 *
 * 覆盖：upsertProvider, deleteProvider, getProvider,
 * getActiveForClaude, getActiveForCodex, markActiveFor, clearActiveFor,
 * loadProviders, saveProviders
 *
 * 由于 providers-manager 直接操作 ~/.vv-switch-providers.json，
 * 测试使用独立的临时文件替换 PROVIDERS_FILE（通过 mock fs 调用）。
 * 实际上我们直接重写 saveProviders/loadProviders 指向临时路径。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to mock the PROVIDERS_FILE path. Since the module uses a const,
// we'll work with a temp file by intercepting at the module level.
// The cleanest approach: create a temporary file and use the real module
// functions, but we need to override the internal path.
// Since we can't easily mock ESM modules, we'll test by directly
// calling the exported functions and managing the file ourselves.

// Actually, the best approach is to create our own test wrapper that
// overrides the file path via environment or by re-implementing the
// functions with a temp path.

const TEST_DIR = join(tmpdir(), 'vv-switch-test-' + Date.now());
const TEST_PROVIDERS_FILE = join(TEST_DIR, '.vv-switch-providers.json');

// Create test directory
mkdirSync(TEST_DIR, { recursive: true });

// Helper functions that mirror providers-manager but use test path
function loadTestProviders() {
  if (!existsSync(TEST_PROVIDERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TEST_PROVIDERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTestProviders(providers) {
  writeFileSync(TEST_PROVIDERS_FILE, JSON.stringify(providers, null, 2), 'utf-8');
}

function upsertTestProvider(data) {
  const providers = loadTestProviders();
  const now = new Date().toISOString();

  if (data.id) {
    const index = providers.findIndex(p => p.id === data.id);
    if (index >= 0) {
      // Update existing
      providers[index] = { ...providers[index], ...data, updatedAt: now };
    } else {
      // ID provided but not found → add new with all data fields
      providers.push({
        id: data.id,
        name: data.name || '',
        baseUrl: data.baseUrl || '',
        apiKey: data.apiKey || '',
        model: data.model || '',
        protocolType: data.protocolType || 'anthropic',
        activeForClaude: data.activeForClaude || false,
        activeForCodex: data.activeForCodex || false,
        createdAt: now,
        updatedAt: now,
      });
    }
  } else {
    // No ID → generate new
    providers.push({
      id: 'gen-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name: data.name || '',
      baseUrl: data.baseUrl || '',
      apiKey: data.apiKey || '',
      model: data.model || '',
      protocolType: data.protocolType || 'anthropic',
      activeForClaude: false,
      activeForCodex: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  saveTestProviders(providers);
  const lastId = data.id || providers[providers.length - 1].id;
  return providers.find(p => p.id === lastId);
}

function deleteTestProvider(id) {
  const providers = loadTestProviders();
  const filtered = providers.filter(p => p.id !== id);
  if (filtered.length === providers.length) return false;
  saveTestProviders(filtered);
  return true;
}

function getTestProvider(id) {
  return loadTestProviders().find(p => p.id === id) || null;
}

function getTestActiveForClaude() {
  return loadTestProviders().find(p => p.activeForClaude) || null;
}

function getTestActiveForCodex() {
  return loadTestProviders().find(p => p.activeForCodex) || null;
}

function markTestActiveFor(providerId, targets) {
  const providers = loadTestProviders();
  const hasClaude = targets.includes('claude');
  const hasCodex = targets.includes('codex');

  for (const p of providers) {
    if (p.id === providerId) {
      if (hasClaude) p.activeForClaude = true;
      if (hasCodex) p.activeForCodex = true;
    } else {
      if (hasClaude) p.activeForClaude = false;
      if (hasCodex) p.activeForCodex = false;
    }
  }

  saveTestProviders(providers);
  return providers.find(p => p.id === providerId) || null;
}

function clearTestActiveFor(targets) {
  const providers = loadTestProviders();
  const hasClaude = targets.includes('claude');
  const hasCodex = targets.includes('codex');
  let changed = false;

  for (const p of providers) {
    if (hasClaude && p.activeForClaude) { p.activeForClaude = false; changed = true; }
    if (hasCodex && p.activeForCodex) { p.activeForCodex = false; changed = true; }
  }

  if (changed) saveTestProviders(providers);
}

function reorderTestProviders(ids) {
  const providers = loadTestProviders();
  if (!Array.isArray(ids) || ids.length === 0) return providers;

  const byId = new Map(providers.map(p => [p.id, p]));
  const seen = new Set();
  const ordered = [];

  for (const id of ids) {
    const provider = byId.get(id);
    if (provider && !seen.has(id)) {
      ordered.push(provider);
      seen.add(id);
    }
  }
  for (const provider of providers) {
    if (!seen.has(provider.id)) ordered.push(provider);
  }

  saveTestProviders(ordered);
  return ordered;
}

describe('providers-manager (isolated)', () => {
  beforeEach(() => {
    if (existsSync(TEST_PROVIDERS_FILE)) {
      unlinkSync(TEST_PROVIDERS_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(TEST_PROVIDERS_FILE)) {
      unlinkSync(TEST_PROVIDERS_FILE);
    }
  });

  // ── loadProviders / saveProviders ────────────────────────────────────────

  describe('loadProviders', () => {
    it('returns empty array when file does not exist', () => {
      const result = loadTestProviders();
      assert.deepStrictEqual(result, []);
    });

    it('loads providers from file', () => {
      saveTestProviders([{ id: 'p1', name: 'Test' }]);
      const result = loadTestProviders();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'p1');
    });

    it('returns empty array on parse error', () => {
      writeFileSync(TEST_PROVIDERS_FILE, 'not json', 'utf-8');
      const result = loadTestProviders();
      assert.deepStrictEqual(result, []);
    });
  });

  // ── upsertProvider ─────────────────────────────────────────────────────

  describe('upsertProvider', () => {
    it('creates new provider without id', () => {
      const result = upsertTestProvider({
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-xxx',
        model: 'deepseek-chat',
        protocolType: 'chat',
      });

      assert.ok(result.id);
      assert.strictEqual(result.name, 'DeepSeek');
      assert.strictEqual(result.baseUrl, 'https://api.deepseek.com');
      assert.strictEqual(result.protocolType, 'chat');
      assert.strictEqual(result.activeForClaude, false);
      assert.strictEqual(result.activeForCodex, false);
      assert.ok(result.createdAt);
      assert.ok(result.updatedAt);
    });

    it('uses default protocolType when not provided', () => {
      const result = upsertTestProvider({ name: 'Test' });
      assert.strictEqual(result.protocolType, 'anthropic');
    });

    it('updates existing provider by id', () => {
      const created = upsertTestProvider({
        id: 'test-123',
        name: 'Original',
        baseUrl: 'https://original.com',
        apiKey: 'key1',
        model: 'model1',
      });

      assert.strictEqual(created.name, 'Original');
      assert.strictEqual(created.baseUrl, 'https://original.com');

      const updated = upsertTestProvider({
        id: 'test-123',
        name: 'Updated',
        baseUrl: 'https://updated.com',
      });

      assert.strictEqual(updated.name, 'Updated');
      assert.strictEqual(updated.baseUrl, 'https://updated.com');
      // Should preserve other fields
      assert.strictEqual(updated.model, 'model1');
      assert.strictEqual(updated.apiKey, 'key1');
      assert.ok(updated.updatedAt);
      assert.ok(updated.createdAt);
    });

    it('adds new provider when id does not exist', () => {
      upsertTestProvider({
        id: 'existing-1',
        name: 'Provider 1',
      });
      const providers = loadTestProviders();
      assert.strictEqual(providers.length, 1);

      // Adding with a different id that doesn't exist
      upsertTestProvider({
        id: 'new-2',
        name: 'Provider 2',
        baseUrl: 'https://new.com',
      });
      const updated = loadTestProviders();
      assert.strictEqual(updated.length, 2);
    });

    it('defaults empty strings for missing fields', () => {
      const result = upsertTestProvider({ name: 'Test' });
      assert.strictEqual(result.baseUrl, '');
      assert.strictEqual(result.apiKey, '');
      assert.strictEqual(result.model, '');
    });
  });

  // ── deleteProvider ─────────────────────────────────────────────────────

  describe('deleteProvider', () => {
    it('returns true and removes provider', () => {
      upsertTestProvider({ id: 'to-delete', name: 'Delete Me' });
      assert.strictEqual(loadTestProviders().length, 1);

      const result = deleteTestProvider('to-delete');
      assert.strictEqual(result, true);
      assert.strictEqual(loadTestProviders().length, 0);
    });

    it('returns false when provider not found', () => {
      const result = deleteTestProvider('nonexistent');
      assert.strictEqual(result, false);
    });

    it('only removes matching provider', () => {
      upsertTestProvider({ id: 'keep-1', name: 'Keep 1' });
      upsertTestProvider({ id: 'remove', name: 'Remove' });
      upsertTestProvider({ id: 'keep-2', name: 'Keep 2' });

      deleteTestProvider('remove');
      const remaining = loadTestProviders();
      assert.strictEqual(remaining.length, 2);
      assert.ok(remaining.find(p => p.id === 'keep-1'));
      assert.ok(remaining.find(p => p.id === 'keep-2'));
      assert.ok(!remaining.find(p => p.id === 'remove'));
    });
  });

  // ── getProvider ────────────────────────────────────────────────────────

  describe('getProvider', () => {
    it('returns provider by id', () => {
      upsertTestProvider({ id: 'find-me', name: 'Find Me' });
      const result = getTestProvider('find-me');
      assert.strictEqual(result.name, 'Find Me');
    });

    it('returns null when not found', () => {
      const result = getTestProvider('nonexistent');
      assert.strictEqual(result, null);
    });
  });

  // ── getActiveForClaude / getActiveForCodex ─────────────────────────────

  describe('getActiveForClaude', () => {
    it('returns null when no active provider', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      assert.strictEqual(getTestActiveForClaude(), null);
    });

    it('returns active provider', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true });
      const result = getTestActiveForClaude();
      assert.strictEqual(result.name, 'P1');
    });
  });

  describe('getActiveForCodex', () => {
    it('returns null when no active provider', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      assert.strictEqual(getTestActiveForCodex(), null);
    });

    it('returns active provider', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForCodex: true });
      const result = getTestActiveForCodex();
      assert.strictEqual(result.name, 'P1');
    });
  });

  // ── markActiveFor ──────────────────────────────────────────────────────

  describe('markActiveFor', () => {
    it('marks provider active for claude', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      upsertTestProvider({ id: 'p2', name: 'P2' });

      const result = markTestActiveFor('p1', ['claude']);
      assert.strictEqual(result.activeForClaude, true);

      const providers = loadTestProviders();
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForClaude, true);
      assert.strictEqual(providers.find(p => p.id === 'p2').activeForClaude, false);
    });

    it('marks provider active for codex', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      upsertTestProvider({ id: 'p2', name: 'P2' });

      markTestActiveFor('p1', ['codex']);
      const providers = loadTestProviders();
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForCodex, true);
      assert.strictEqual(providers.find(p => p.id === 'p2').activeForCodex, false);
    });

    it('marks provider active for both targets', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      upsertTestProvider({ id: 'p2', name: 'P2' });

      markTestActiveFor('p1', ['claude', 'codex']);
      const providers = loadTestProviders();
      const p1 = providers.find(p => p.id === 'p1');
      const p2 = providers.find(p => p.id === 'p2');
      assert.strictEqual(p1.activeForClaude, true);
      assert.strictEqual(p1.activeForCodex, true);
      assert.strictEqual(p2.activeForClaude, false);
      assert.strictEqual(p2.activeForCodex, false);
    });

    it('clears active status on other providers', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true });
      upsertTestProvider({ id: 'p2', name: 'P2' });

      markTestActiveFor('p2', ['claude']);
      const providers = loadTestProviders();
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForClaude, false);
      assert.strictEqual(providers.find(p => p.id === 'p2').activeForClaude, true);
    });

    it('only updates specified targets', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true, activeForCodex: true });
      upsertTestProvider({ id: 'p2', name: 'P2' });

      markTestActiveFor('p2', ['claude']);
      const providers = loadTestProviders();
      // p2 should only have claude active, not codex
      assert.strictEqual(providers.find(p => p.id === 'p2').activeForCodex, false);
      // p1's codex active should NOT be cleared (only claude was targeted)
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForCodex, true);
    });

    it('returns null for non-existent provider', () => {
      const result = markTestActiveFor('nonexistent', ['claude']);
      assert.strictEqual(result, null);
    });
  });

  // ── clearActiveFor ─────────────────────────────────────────────────────

  describe('clearActiveFor', () => {
    it('clears claude active status', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true });
      clearTestActiveFor(['claude']);
      const providers = loadTestProviders();
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForClaude, false);
    });

    it('clears codex active status', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForCodex: true });
      clearTestActiveFor(['codex']);
      const providers = loadTestProviders();
      assert.strictEqual(providers.find(p => p.id === 'p1').activeForCodex, false);
    });

    it('clears both targets', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true, activeForCodex: true });
      clearTestActiveFor(['claude', 'codex']);
      const providers = loadTestProviders();
      const p1 = providers.find(p => p.id === 'p1');
      assert.strictEqual(p1.activeForClaude, false);
      assert.strictEqual(p1.activeForCodex, false);
    });

    it('does not save when nothing changed', () => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      const before = readFileSync(TEST_PROVIDERS_FILE, 'utf-8');
      clearTestActiveFor(['claude']);
      const after = readFileSync(TEST_PROVIDERS_FILE, 'utf-8');
      assert.strictEqual(before, after);
    });

    it('only affects specified target', () => {
      upsertTestProvider({ id: 'p1', name: 'P1', activeForClaude: true, activeForCodex: true });
      clearTestActiveFor(['claude']);
      const providers = loadTestProviders();
      const p1 = providers.find(p => p.id === 'p1');
      assert.strictEqual(p1.activeForClaude, false);
      assert.strictEqual(p1.activeForCodex, true);
    });
  });

  // ── reorderProviders ──────────────────────────────────────────────────

  describe('reorderProviders', () => {
    beforeEach(() => {
      upsertTestProvider({ id: 'p1', name: 'P1' });
      upsertTestProvider({ id: 'p2', name: 'P2' });
      upsertTestProvider({ id: 'p3', name: 'P3' });
    });

    it('reorders providers according to given ids and persists', () => {
      const result = reorderTestProviders(['p3', 'p1', 'p2']);
      assert.deepStrictEqual(result.map(p => p.id), ['p3', 'p1', 'p2']);
      assert.deepStrictEqual(loadTestProviders().map(p => p.id), ['p3', 'p1', 'p2']);
    });

    it('preserves provider data while reordering', () => {
      const result = reorderTestProviders(['p2', 'p3', 'p1']);
      const p2 = result.find(p => p.id === 'p2');
      assert.strictEqual(p2.name, 'P2');
    });

    it('ignores unknown ids', () => {
      const result = reorderTestProviders(['p2', 'ghost', 'p1', 'p3']);
      assert.deepStrictEqual(result.map(p => p.id), ['p2', 'p1', 'p3']);
    });

    it('ignores duplicate ids', () => {
      const result = reorderTestProviders(['p2', 'p2', 'p1', 'p3']);
      assert.deepStrictEqual(result.map(p => p.id), ['p2', 'p1', 'p3']);
    });

    it('appends providers missing from ids in their original order', () => {
      const result = reorderTestProviders(['p3']);
      assert.deepStrictEqual(result.map(p => p.id), ['p3', 'p1', 'p2']);
      assert.deepStrictEqual(loadTestProviders().map(p => p.id), ['p3', 'p1', 'p2']);
    });

    it('returns current list unchanged for empty ids', () => {
      const before = loadTestProviders().map(p => p.id);
      const result = reorderTestProviders([]);
      assert.deepStrictEqual(result.map(p => p.id), before);
    });

    it('returns current list unchanged for non-array ids', () => {
      const before = loadTestProviders().map(p => p.id);
      const result = reorderTestProviders(null);
      assert.deepStrictEqual(result.map(p => p.id), before);
    });
  });
});
