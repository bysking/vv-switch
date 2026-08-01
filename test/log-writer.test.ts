/**
 * log-writer.js 单元测试
 *
 * 覆盖：LogWriter constructor, write, writeSummary, shortenUrl,
 * getLogPath, getOutputDir, close
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log-writer.js';

const TEST_LOG_DIR = join(tmpdir(), 'vv-switch-log-test-' + Date.now());

describe('LogWriter', () => {
  beforeEach(() => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_LOG_DIR)) {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('creates output directory', () => {
      assert.ok(!existsSync(TEST_LOG_DIR));
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.close();
      assert.ok(existsSync(TEST_LOG_DIR));
    });

    it('generates index.html', () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.close();
      assert.ok(existsSync(join(TEST_LOG_DIR, 'index.html')));
    });

    it('generates data.js', () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.close();
      assert.ok(existsSync(join(TEST_LOG_DIR, 'data.js')));
    });

    it('creates JSONL log file', () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const logPath = writer.getLogPath();
      assert.ok(logPath.endsWith('.jsonl'));
      assert.ok(logPath.includes(TEST_LOG_DIR));
      writer.close();
    });

    it('works with existing directory', () => {
      mkdirSync(TEST_LOG_DIR, { recursive: true });
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.close();
      assert.ok(existsSync(TEST_LOG_DIR));
    });
  });

  describe('write', () => {
    it('writes JSON line to log file', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const entry = {
        timestamp: '2025-01-01 00:00:00',
        method: 'POST',
        endpoint: '/v1/responses',
        model: 'test-model',
      };
      await writer.write(entry);
      await writer.close();

      const content = readFileSync(writer.getLogPath(), 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.strictEqual(parsed.method, 'POST');
      assert.strictEqual(parsed.endpoint, '/v1/responses');
      assert.strictEqual(parsed.model, 'test-model');
    });

    it('writes multiple entries', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      await writer.write({ method: 'POST', endpoint: '/first' });
      await writer.write({ method: 'GET', endpoint: '/second' });
      await writer.close();

      const content = readFileSync(writer.getLogPath(), 'utf-8');
      const lines = content.trim().split('\n');
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(JSON.parse(lines[0]).endpoint, '/first');
      assert.strictEqual(JSON.parse(lines[1]).endpoint, '/second');
    });

    it('preserves all entry fields', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const entry = {
        timestamp: '2025-06-01 12:00:00',
        method: 'POST',
        endpoint: '/v1/messages',
        caller: 'claude',
        model: 'claude-sonnet-4-6',
        stream: true,
        protocolType: 'anthropic',
        inputType: 'object',
        responseStatus: 200,
        durationMs: 1234,
        responseText: 'Hello!',
        toolCalls: null,
        inputTokens: 100,
        outputTokens: 50,
      };
      await writer.write(entry);
      await writer.close();

      const content = readFileSync(writer.getLogPath(), 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.deepStrictEqual(parsed, entry);
    });
  });

  describe('writeSummary', () => {
    it('outputs summary to stderr', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.writeSummary({
        method: 'POST',
        endpoint: '/v1/responses',
        responseStatus: 200,
        durationMs: 500,
      });
      await writer.close();
      // Summary goes to stderr, no way to easily verify in test
      // Just ensure it doesn't throw
    });

    it('handles missing fields', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      writer.writeSummary({});
      await writer.close();
      // Should not throw
    });
  });

  describe('shortenUrl', () => {
    it('extracts pathname from valid URL', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const result = writer.shortenUrl('https://api.example.com/v1/chat/completions');
      await writer.close();
      assert.strictEqual(result, '/v1/chat/completions');
    });

    it('returns original for invalid URL', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const result = writer.shortenUrl('not-a-url');
      await writer.close();
      assert.strictEqual(result, 'not-a-url');
    });
  });

  describe('getLogPath', () => {
    it('returns log file path', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const path = writer.getLogPath();
      assert.ok(path.endsWith('.jsonl'));
      assert.ok(path.includes('vv-switch-'));
      await writer.close();
    });
  });

  describe('getOutputDir', () => {
    it('returns output directory', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const dir = writer.getOutputDir();
      assert.strictEqual(dir, TEST_LOG_DIR);
      await writer.close();
    });
  });

  describe('close', () => {
    it('returns a promise', () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      const result = writer.close();
      assert.ok(result instanceof Promise);
    });

    it('can be called twice without error', async () => {
      const writer = new LogWriter(TEST_LOG_DIR);
      await writer.close();
      await writer.close(); // Should not throw
    });
  });
});
