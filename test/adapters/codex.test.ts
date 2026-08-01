/**
 * Codex (Responses API) 适配器测试
 *
 * 覆盖核心修复：出口必须按 stopReason 上报 response.status。
 * 截断(max_tokens) 必须报 status:'incomplete' + incomplete_details.reason='max_output_tokens'，
 * 否则 Codex 会把“半截输出”误判为助手主动结束，导致 agent 循环中断、需用户手动“继续”。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeCodexStream } from '../../src/adapters/codex/stream.js';
import { serializeCodexResponse } from '../../src/adapters/codex/serialize.js';
import { createStandardResponse } from '../../src/protocol/standard-response.js';
import type { StreamEvent } from '../../src/protocol/stream-events.js';
import type { AdapterContext } from '../../src/types/adapter.js';

const ctx: AdapterContext = { id: 'resp_test', defaultModel: 'm' };

async function collectSse(stream: AsyncIterable<string>): Promise<any[]> {
  const out: any[] = [];
  for await (const s of stream) {
    const line = s.replace(/^data: /, '').trim();
    if (line === '[DONE]') continue;
    out.push(JSON.parse(line));
  }
  return out;
}

async function* fromEvents(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('adapters/codex serializeStream — response.status 映射', () => {
  it('end_turn → status completed,无 incomplete_details', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'done' },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.ok(completed, '应产出 response.completed 事件');
    assert.equal(completed.response.status, 'completed');
    assert.equal(completed.response.incomplete_details, undefined);
  });

  it('max_tokens → status incomplete + incomplete_details.reason=max_output_tokens', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: '被截断的半截输出' },
      { type: 'END', stopReason: 'max_tokens' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.ok(completed);
    assert.equal(completed.response.status, 'incomplete');
    assert.deepEqual(completed.response.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('tool_use → status completed(Codex 应继续执行工具,而非中断)', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOOL_CALL_START', id: 'call_1', name: 'bash', index: 0 },
      { type: 'TOOL_CALL_DELTA', id: 'call_1', index: 0, argumentsDelta: '{}' },
      { type: 'TOOL_CALL_END', id: 'call_1', index: 0, arguments: '{}' },
      { type: 'END', stopReason: 'tool_use' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.ok(completed);
    assert.equal(completed.response.status, 'completed');
    assert.equal(completed.response.incomplete_details, undefined);
    // 工具调用应作为 function_call 出现在 output
    const fnCall = completed.response.output.find((o: any) => o.type === 'function_call');
    assert.ok(fnCall, '工具调用应出现在 response.output');
  });

  it('END stopReason=pause_turn → status completed', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'x' },
      { type: 'END', stopReason: 'pause_turn' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.equal(completed.response.status, 'completed');
  });

  it('END stopReason=error → status failed(防御性;正常错误走 ERROR 事件)', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'x' },
      { type: 'END', stopReason: 'error' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.equal(completed.response.status, 'failed');
  });
});

describe('adapters/codex serializeResponse — 非流式 status 映射', () => {
  it('max_tokens → status incomplete + incomplete_details', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'cut' }],
      stopReason: 'max_tokens',
    });
    const body = serializeCodexResponse(resp, ctx);
    assert.equal(body.status, 'incomplete');
    assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('end_turn → status completed,无 incomplete_details', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
    });
    const body = serializeCodexResponse(resp, ctx);
    assert.equal(body.status, 'completed');
    assert.equal(body.incomplete_details, undefined);
  });

  it('pause_turn/refusal → status completed(Responses 协议无对应 incomplete_reason)', () => {
    for (const r of ['pause_turn', 'refusal'] as const) {
      const resp = createStandardResponse({
        id: 'r', model: 'm',
        content: [{ type: 'text', text: 'x' }],
        stopReason: r,
      });
      const body = serializeCodexResponse(resp, ctx);
      assert.equal(body.status, 'completed');
      assert.equal(body.incomplete_details, undefined);
    }
  });
});
