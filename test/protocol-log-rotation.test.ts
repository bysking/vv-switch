import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createProtocolTrace } from '../src/protocol-log/protocol-logger.js';

describe('protocol-logger - 日志轮转', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vv-switch-protocol-log-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function createMockTrace(dir: string, filePrefix: string) {
    // 构造文件名: YYYYMMDD-HHMMSS-mmm-caller-id.jsonl
    const filename = `${filePrefix}-claude-abc123.jsonl`;
    fs.writeFileSync(path.join(dir, filename), '');
    return filename;
  }

  function createTraceAndWrite(dir: string, traceId: string) {
    const trace = createProtocolTrace({
      outputDir: dir,
      traceId,
      caller: 'claude',
      agent: 'claude',
      model: 'test',
      stream: false,
      captureBody: true,
    });
    // 触发一次写入,确保文件实际创建(ProtocolLogger 使用 appendFileSync,首次写入才创建文件)
    trace.logger.ingress({ endpoint: '/v1/messages', body: { test: true } });
    return trace;
  }

  it('日志不超过 5 条时不删除', () => {
    // 创建 3 个旧文件
    for (let i = 0; i < 3; i++) {
      createMockTrace(tmpDir, `20260101-00000${i}-000`);
    }

    // 创建新 trace + 写入(会触发轮转+文件创建)
    createTraceAndWrite(tmpDir, 'msg_test_new');

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
    // 3 旧 + 1 新 = 4 条,全部保留
    assert.strictEqual(files.length, 4);
  });

  it('超过 5 条时删除最旧的,保留最近 5 条', () => {
    // 创建 8 个旧文件(按时间戳命名,模拟先后顺序)
    for (let i = 0; i < 8; i++) {
      const ts = `20260101-00000${i}-000`;
      createMockTrace(tmpDir, ts);
    }

    // 创建新 trace + 写入 — 第 9 条,触发轮转
    createTraceAndWrite(tmpDir, 'msg_newest');

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort();

    assert.strictEqual(files.length, 5, `应保留 5 条日志,实际 ${files.length}: ${files.join(', ')}`);

    // 最新的 5 条应该是: 004, 005, 006, 007, 新创建的
    // 被删除的应该是: 000, 001, 002, 003
    const hasOld000 = files.some(f => f.includes('20260101-000000-000'));
    const hasOld003 = files.some(f => f.includes('20260101-000003-000'));
    const hasOld004 = files.some(f => f.includes('20260101-000004-000'));
    const hasOld007 = files.some(f => f.includes('20260101-000007-000'));
    // 新文件名含时间戳且不是 20260101 开头(旧文件统一前缀)
    const hasNew = files.some(f => !f.startsWith('20260101'));

    assert.strictEqual(hasOld000, false, '最旧的 000 应被删除');
    assert.strictEqual(hasOld003, false, '旧的 003 应被删除');
    assert.strictEqual(hasOld004, true, '004 应保留');
    assert.strictEqual(hasOld007, true, '007 应保留');
    assert.strictEqual(hasNew, true, '新创建的应保留');
  });

  it('目录不存在时不报错', () => {
    const nonExistentDir = path.join(tmpDir, 'nonexistent');

    // 不应抛出异常
    let error: Error | null = null;
    try {
      createProtocolTrace({
        outputDir: nonExistentDir,
        traceId: 'msg_test',
        caller: 'claude',
        agent: 'claude',
        model: 'test',
        stream: false,
        captureBody: true,
      });
    } catch (e) {
      error = e as Error;
    }
    assert.strictEqual(error, null, '目录不存在时不应报错');
  });
});
