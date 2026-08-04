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
import { parseCodexRequest } from '../../src/adapters/codex/parse.js';
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

  it('max_tokens → 发送 response.incomplete 事件 + status=incomplete + incomplete_details', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: '被截断的半截输出' },
      { type: 'END', stopReason: 'max_tokens' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    // 截断时终态事件类型应为 response.incomplete，而非 response.completed
    const completed = json.find((c) => c.type === 'response.completed');
    assert.equal(completed, undefined, '截断时不应出现 response.completed');
    const incomplete = json.find((c) => c.type === 'response.incomplete');
    assert.ok(incomplete, '截断时应发送 response.incomplete 事件');
    assert.equal(incomplete.response.status, 'incomplete');
    assert.deepEqual(incomplete.response.incomplete_details, { reason: 'max_output_tokens' });
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

  it('响应体包含 store: false 字段', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
    });
    const body = serializeCodexResponse(resp, ctx);
    assert.equal(body.store, false);
  });

  it('reasoning.effort 从 context 透传', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
    });
    const ctxHigh = { ...ctx, reasoningEffort: 'high' };
    const body = serializeCodexResponse(resp, ctxHigh);
    assert.equal(body.reasoning?.effort, 'high');
  });

  it('reasoning.effort 默认 medium（context 中无值时）', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
    });
    const body = serializeCodexResponse(resp, ctx);
    assert.equal(body.reasoning?.effort, 'medium');
  });
});

describe('adapters/codex serializeStream — 协议字段完善', () => {
  it('所有流式事件都带递增的 sequence_number', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'hello' },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    assert.ok(json.length > 0, '应产出事件');
    for (let i = 0; i < json.length; i++) {
      const ev = json[i];
      if (ev.type === '[DONE]') continue;
      assert.equal(typeof ev.sequence_number, 'number', `事件 #${i} (${ev.type}) 应有 sequence_number`);
      assert.equal(ev.sequence_number, i + 1, `sequence_number 应从 1 递增`);
    }
  });

  it('流式终态响应包含 store: false', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'ok' },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.ok(completed);
    assert.equal(completed.response.store, false);
  });

  it('流式 reasoning.effort 从 context 透传', async () => {
    const ctxHigh = { ...ctx, reasoningEffort: 'high' };
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'ok' },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctxHigh));
    const completed = json.find((c) => c.type === 'response.completed');
    assert.ok(completed);
    assert.equal(completed.response.reasoning.effort, 'high');
  });

  it('流式 ERROR 路径发送 response.failed + store: false', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'ERROR', message: 'boom', code: 'test_err' },
    ];
    const json = await collectSse(serializeCodexStream(fromEvents(events), ctx));
    const failed = json.find((c) => c.type === 'response.failed');
    assert.ok(failed, '错误时应发送 response.failed 事件');
    assert.equal(failed.response.status, 'failed');
    assert.equal(failed.response.store, false);
  });
});

describe('adapters/codex parseRequest — 输入解析', () => {
  it('reasoning 类型 input item 归入上一条 assistant 消息的 thinking block', () => {
    const body = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          type: 'reasoning',
          content: [{ type: 'output_text', text: 'I should think about this' }],
        },
        { type: 'message', role: 'user', content: 'next' },
      ],
    };
    const req = parseCodexRequest(body, ctx);
    // 第二条 assistant 消息应包含 text + thinking 两部分
    const assistantMsg = req.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, '应有 assistant 消息');
    assert.ok(Array.isArray(assistantMsg.content), 'assistant content 应为数组');
    const parts = assistantMsg.content as Array<{ type: string; text?: string }>;
    const thinkingPart = parts.find((p) => p.type === 'thinking');
    assert.ok(thinkingPart, '应包含 thinking block');
    assert.equal(thinkingPart.text, 'I should think about this');
    const textPart = parts.find((p) => p.type === 'text');
    assert.ok(textPart, '应包含 text block');
    assert.equal(textPart.text, 'hello');
  });

  it('reasoning input item 无上一条 assistant 消息时被安全忽略', () => {
    const body = {
      model: 'm',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'output_text', text: 'orphan reasoning' }],
        },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    };
    const req = parseCodexRequest(body, ctx);
    // 不应报错，且 reasoning 内容不混入 user 消息
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
  });

  it('reasoning.effort 从请求体解析到 parameters', () => {
    const body = {
      model: 'm',
      input: 'hi',
      reasoning: { effort: 'high' },
    };
    const req = parseCodexRequest(body, ctx);
    assert.equal(req.parameters.reasoningEffort, 'high');
    assert.deepEqual(req.parameters.thinking, { type: 'enabled' });
  });
});
