/**
 * OpenAI Adapter tests — /v1/chat/completions
 *
 * 覆盖该端点的三段核心协议转换逻辑：
 *   - parseOpenAIRequest:    客户端 body → StandardRequest
 *   - serializeOpenAIResponse: StandardResponse → chat.completion 响应体（非流式）
 *   - serializeOpenAIStream:  StreamEvent 流 → chat.completion.chunk SSE 字符串流
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAIRequest } from '../../src/adapters/openai/parse.js';
import { serializeOpenAIResponse } from '../../src/adapters/openai/serialize.js';
import { serializeOpenAIStream } from '../../src/adapters/openai/stream.js';
import { createStandardResponse } from '../../src/protocol/standard-response.js';
import type { AdapterContext } from '../../src/types/adapter.js';
import type { StreamEvent } from '../../src/protocol/stream-events.js';

const ctx = (extra: Partial<AdapterContext> = {}): AdapterContext => ({
  id: 'chatcmpl-test',
  defaultModel: 'default-model',
  ...extra,
});

/** 消费一个 SSE 字符串流并把每个 `data:` payload 解析成对象（跳过 [DONE]） */
async function collectSse(stream: AsyncIterable<string>): Promise<{ raw: string[]; json: any[]; done: boolean }> {
  const raw: string[] = [];
  const json: any[] = [];
  let done = false;
  for await (const s of stream) {
    raw.push(s);
    const line = s.replace(/^data: /, '').trim();
    if (line === '[DONE]') { done = true; continue; }
    json.push(JSON.parse(line));
  }
  return { raw, json, done };
}

async function* fromEvents(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('adapters/openai parseRequest', () => {
  it('parses a simple string-content chat request', () => {
    const req = parseOpenAIRequest(
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
      ctx(),
    );
    assert.equal(req.id, 'chatcmpl-test');
    assert.equal(req.agent, 'openai');
    // 代理使用配置的默认模型，忽略客户端 model
    assert.equal(req.model, 'default-model');
    assert.equal(req.stream, false);
    assert.equal(req.messages.length, 1);
    assert.deepEqual(req.messages[0], { role: 'user', content: 'hi' });
    assert.deepEqual(req.capabilitiesRequired, ['chat']);
    assert.equal(req.metadata.endpoint, '/v1/chat/completions');
    assert.equal(req.metadata.caller, 'openai');
  });

  it('falls back to body.model when no defaultModel', () => {
    const req = parseOpenAIRequest(
      { model: 'gpt-4o', messages: [] },
      { id: 'x' },
    );
    assert.equal(req.model, 'gpt-4o');
  });

  it('maps stream/temperature/top_p/max_tokens/reasoning_effort parameters', () => {
    const req = parseOpenAIRequest(
      {
        messages: [{ role: 'user', content: 'q' }],
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 256,
        reasoning_effort: 'high',
      },
      ctx(),
    );
    assert.equal(req.stream, true);
    assert.equal(req.parameters.temperature, 0.7);
    assert.equal(req.parameters.topP, 0.9);
    assert.equal(req.parameters.maxTokens, 256);
    assert.equal(req.parameters.reasoningEffort, 'high');
  });

  it('prefers max_completion_tokens over max_tokens', () => {
    const req = parseOpenAIRequest(
      { messages: [], max_tokens: 100, max_completion_tokens: 500 },
      ctx(),
    );
    assert.equal(req.parameters.maxTokens, 500);
  });

  it('parses multimodal content parts (text + image_url)', () => {
    const req = parseOpenAIRequest(
      {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'https://x/i.png' } },
          ],
        }],
      },
      ctx(),
    );
    const parts = req.messages[0].content;
    assert.ok(Array.isArray(parts));
    assert.deepEqual(parts, [
      { type: 'text', text: 'describe this' },
      { type: 'image', url: 'https://x/i.png' },
    ]);
  });

  it('parses tools and marks tool_call capability', () => {
    const req = parseOpenAIRequest(
      {
        messages: [{ role: 'user', content: 'go' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        }],
      },
      ctx(),
    );
    assert.equal(req.tools.length, 1);
    assert.equal(req.tools[0].name, 'get_weather');
    assert.equal(req.tools[0].description, 'Get weather');
    assert.deepEqual(req.capabilitiesRequired, ['chat', 'tool_call']);
  });

  it('parses assistant message with tool_calls (arguments as JSON string)', () => {
    const req = parseOpenAIRequest(
      {
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"cats"}' },
          }],
        }],
      },
      ctx(),
    );
    const parts = req.messages[0].content as any[];
    assert.equal(req.messages[0].role, 'assistant');
    const toolUse = parts.find((p) => p.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.id, 'call_1');
    assert.equal(toolUse.name, 'search');
    assert.deepEqual(toolUse.input, { q: 'cats' });
  });

  it('parses tool result message', () => {
    const req = parseOpenAIRequest(
      {
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: '72F sunny' }],
      },
      ctx(),
    );
    assert.equal(req.messages[0].role, 'tool');
    assert.deepEqual(req.messages[0].content, [
      { type: 'tool_result', toolUseId: 'call_1', output: '72F sunny' },
    ]);
  });

  it('parses tool_choice variants', () => {
    assert.equal(parseOpenAIRequest({ messages: [], tool_choice: 'auto' }, ctx()).toolChoice, 'auto');
    assert.equal(parseOpenAIRequest({ messages: [], tool_choice: 'required' }, ctx()).toolChoice, 'required');
    assert.equal(parseOpenAIRequest({ messages: [], tool_choice: 'none' }, ctx()).toolChoice, 'none');
    assert.deepEqual(
      parseOpenAIRequest(
        { messages: [], tool_choice: { type: 'function', function: { name: 'f' } } },
        ctx(),
      ).toolChoice,
      { type: 'tool', name: 'f' },
    );
    assert.equal(parseOpenAIRequest({ messages: [] }, ctx()).toolChoice, undefined);
  });

  it('passes rawHeaders through metadata', () => {
    const req = parseOpenAIRequest(
      { messages: [] },
      ctx({ headers: { authorization: 'Bearer xyz' } }),
    );
    assert.deepEqual(req.metadata.rawHeaders, { authorization: 'Bearer xyz' });
  });

  it('handles empty/missing body gracefully', () => {
    const req = parseOpenAIRequest(undefined, ctx());
    assert.equal(req.messages.length, 0);
    assert.equal(req.tools.length, 0);
    assert.equal(req.model, 'default-model');
  });
});

describe('adapters/openai serializeResponse', () => {
  it('serializes a plain text response', () => {
    const resp = createStandardResponse({
      id: 'chatcmpl-1',
      model: 'm',
      content: [{ type: 'text', text: 'Hello world' }],
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
    const body = serializeOpenAIResponse(resp, ctx());
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.id, 'chatcmpl-1');
    assert.equal(body.model, 'm');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'Hello world');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('includes reasoning_content for thinking blocks', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [
        { type: 'thinking', text: 'let me think' },
        { type: 'text', text: 'answer' },
      ],
    });
    const body = serializeOpenAIResponse(resp, ctx());
    assert.equal(body.choices[0].message.reasoning_content, 'let me think');
    assert.equal(body.choices[0].message.content, 'answer');
  });

  it('serializes tool calls and sets finish_reason=tool_calls', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [],
      toolCalls: [{ id: 'call_1', name: 'search', arguments: '{"q":"x"}' }],
      stopReason: 'tool_use',
    });
    const body = serializeOpenAIResponse(resp, ctx());
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    const tc = body.choices[0].message.tool_calls;
    assert.ok(tc);
    assert.equal(tc[0].id, 'call_1');
    assert.equal(tc[0].type, 'function');
    assert.equal(tc[0].function.name, 'search');
    assert.equal(tc[0].function.arguments, '{"q":"x"}');
  });

  it('maps max_tokens stop reason to length', () => {
    const resp = createStandardResponse({
      id: 'r', model: 'm',
      content: [{ type: 'text', text: 'cut' }],
      stopReason: 'max_tokens',
    });
    const body = serializeOpenAIResponse(resp, ctx());
    assert.equal(body.choices[0].finish_reason, 'length');
  });

  it('maps pause_turn/refusal to stop (chat 协议无对应枚举)', () => {
    for (const r of ['pause_turn', 'refusal'] as const) {
      const resp = createStandardResponse({
        id: 'r', model: 'm',
        content: [{ type: 'text', text: 'x' }],
        stopReason: r,
      });
      assert.equal(serializeOpenAIResponse(resp, ctx()).choices[0].finish_reason, 'stop');
    }
  });

  it('uses null content when there is no text', () => {
    const resp = createStandardResponse({ id: 'r', model: 'm', content: [] });
    const body = serializeOpenAIResponse(resp, ctx());
    assert.equal(body.choices[0].message.content, null);
  });
});

describe('adapters/openai serializeStream', () => {
  it('emits role chunk, content deltas, finish and usage then [DONE]', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'stream-model' },
      { type: 'TOKEN', text: 'Hello' },
      { type: 'TOKEN', text: ' world' },
      { type: 'USAGE', inputTokens: 4, outputTokens: 2 },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const { json, done } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));

    assert.ok(done, 'stream must terminate with [DONE]');
    // 每个 chunk 都是 chat.completion.chunk
    assert.ok(json.every((c) => c.object === 'chat.completion.chunk'));
    // 首个 chunk 带 role
    assert.deepEqual(json[0].choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(json[0].model, 'stream-model');
    // content 增量
    const text = json.map((c) => c.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'Hello world');
    // finish_reason
    const finish = json.find((c) => c.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    // usage chunk（choices 为空数组）
    const usageChunk = json.find((c) => c.usage);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    assert.deepEqual(usageChunk.choices, []);
  });

  it('emits reasoning_content for THINKING events', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'THINKING', text: 'hmm' },
      { type: 'END', stopReason: 'end_turn' },
    ];
    const { json } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));
    const reasoning = json.find((c) => c.choices[0]?.delta?.reasoning_content);
    assert.equal(reasoning.choices[0].delta.reasoning_content, 'hmm');
  });

  it('serializes tool call start/delta and sets finish_reason=tool_calls', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOOL_CALL_START', id: 'call_1', name: 'search', index: 0 },
      { type: 'TOOL_CALL_DELTA', id: 'call_1', index: 0, argumentsDelta: '{"q":' },
      { type: 'TOOL_CALL_DELTA', id: 'call_1', index: 0, argumentsDelta: '"x"}' },
      { type: 'TOOL_CALL_END', id: 'call_1', index: 0, arguments: '{"q":"x"}' },
      { type: 'END', stopReason: 'tool_use' },
    ];
    const { json } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));

    const startChunk = json.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id === 'call_1');
    assert.ok(startChunk);
    assert.equal(startChunk.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(startChunk.choices[0].delta.tool_calls[0].type, 'function');
    assert.equal(startChunk.choices[0].delta.tool_calls[0].function.name, 'search');

    // 参数增量拼接
    const args = json
      .map((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments || '')
      .join('');
    assert.equal(args, '{"q":"x"}');

    const finish = json.find((c) => c.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  });

  it('maps multiple tool calls to sequential chat indexes', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOOL_CALL_START', id: 'a', name: 'f1', index: 5 },
      { type: 'TOOL_CALL_START', id: 'b', name: 'f2', index: 9 },
      { type: 'TOOL_CALL_DELTA', id: 'b', index: 9, argumentsDelta: '{}' },
      { type: 'END', stopReason: 'tool_use' },
    ];
    const { json } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));
    const starts = json.filter((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id);
    assert.equal(starts[0].choices[0].delta.tool_calls[0].index, 0);
    assert.equal(starts[1].choices[0].delta.tool_calls[0].index, 1);
    // 第二个工具的 delta 应映射到 chat index 1
    const delta = json.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{}');
    assert.equal(delta.choices[0].delta.tool_calls[0].index, 1);
  });

  it('emits an error chunk then [DONE] on ERROR event', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'ERROR', message: 'boom', code: 'upstream_error' },
      { type: 'END', stopReason: 'error' },
    ];
    const { json, done } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));
    assert.ok(done);
    const errChunk = json.find((c) => c.error);
    assert.ok(errChunk);
    assert.equal(errChunk.error.message, 'boom');
    assert.equal(errChunk.error.code, 'upstream_error');
    // ERROR 之后立即结束,不再产生 END 的 finish chunk
    assert.equal(json[json.length - 1], errChunk);
  });

  it('falls back to a stop finish when stream ends without END', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'r', model: 'm' },
      { type: 'TOKEN', text: 'partial' },
    ];
    const { json, done } = await collectSse(serializeOpenAIStream(fromEvents(events), ctx()));
    assert.ok(done);
    const finish = json.find((c) => c.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'stop');
  });
});
