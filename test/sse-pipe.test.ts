/**
 * pipeSseToResponse 测试
 *
 * 核心回归:客户端(codex/claude)中断或断开后,代理必须停止消费上游并触发上游迭代器收尾,
 * 不能出现“客户端已停、代理还在跑/一直刷日志”的情况。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pipeSseToResponse } from '../src/http/sse.js';

/** 假的 Express Response:可写、可触发 close、可 end */
function fakeRes(): any {
  const ee = new EventEmitter() as any;
  ee.writableEnded = false;
  ee.destroyed = false;
  ee.written = [] as string[];
  ee.write = (s: string) => { ee.written.push(s); return true; };
  ee.end = () => { ee.writableEnded = true; };
  return ee;
}

describe('http/sse pipeSseToResponse', () => {
  it('客户端断开后停止消费上游,且上游 generator 被收尾(finally 执行)', async () => {
    const res = fakeRes();
    let pulled = 0;
    let finalized = false;

    async function* upstream(): AsyncGenerator<string> {
      try {
        for (let i = 0; i < 100; i++) {
          pulled++;
          yield `data: chunk-${i}\n\n`;
          // 第一个 chunk 写出后模拟客户端断开
          if (i === 0) res.emit('close');
        }
      } finally {
        finalized = true;
      }
    }

    const status = await pipeSseToResponse(upstream(), res);
    assert.equal(status, 200);
    // 不应把 100 个 chunk 全部消费完(客户端在第 1 个后就断了)
    assert.ok(pulled < 100, `客户端断开后应停止消费,实际 pulled=${pulled}`);
    // 上游 generator 的 finally 应执行(对应 provider 的 reader.cancel())
    assert.equal(finalized, true, '上游 generator 的 finally 应执行以中止拉取');
  });

  it('正常流:完整消费并 end 响应', async () => {
    const res = fakeRes();
    async function* upstream(): AsyncGenerator<string> {
      yield 'data: a\n\n';
      yield 'data: b\n\n';
    }
    const status = await pipeSseToResponse(upstream(), res);
    assert.equal(status, 200);
    assert.deepEqual(res.written, ['data: a\n\n', 'data: b\n\n']);
    assert.equal(res.writableEnded, true);
  });

  it('命中 errorPattern → 推断上游状态 500', async () => {
    const res = fakeRes();
    async function* upstream(): AsyncGenerator<string> {
      yield 'data: {"type":"response.failed"}\n\n';
    }
    const status = await pipeSseToResponse(upstream(), res);
    assert.equal(status, 500);
  });
});
