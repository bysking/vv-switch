/**
 * ollama provider: 工具调用解析测试
 *
 * 用例形状全部来自对真实 ollama 0.30.6 的实测抓包（minimax-m3:cloud / 本地模型），
 * 而非猜测。关键实测结论：
 *   - tool_calls 的 index 在 function 内部（function.index），顶层 tc.index 不存在
 *   - 多个 tool_call 可能同处一个 chunk，且 function.index 全为 0
 *   - arguments 可能是对象（完整值）或字符串（增量分片）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOllamaStream } from '../../src/providers/ollama/stream.js';
import { parseOllamaResponse } from '../../src/providers/ollama/response.js';
import { buildOllamaRequest } from '../../src/providers/ollama/request.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';
import type { StreamEvent } from '../../src/protocol/stream-events.js';

/** 把 NDJSON chunk 数组包成一个 Response，模拟 ollama /api/chat 流 */
function ndjsonResponse(chunks: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(JSON.stringify(ch) + '\n'));
      c.close();
    },
  });
  return new Response(body);
}

async function collect(chunks: unknown[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of parseOllamaStream(ndjsonResponse(chunks), { id: 'r', model: 'm' })) {
    events.push(ev);
  }
  return events;
}

type ToolEnd = { type: 'TOOL_CALL_END'; id: string; index: number; arguments: string };
const toolEnds = (evs: StreamEvent[]): ToolEnd[] =>
  evs.filter((e) => e.type === 'TOOL_CALL_END') as ToolEnd[];
const toolStarts = (evs: StreamEvent[]) =>
  evs.filter((e) => e.type === 'TOOL_CALL_START') as Array<{ type: string; id: string; name: string; index: number }>;

describe('ollama/stream 工具调用解析', () => {
  it('实测形状：同一 chunk 内 3 个 tool_call、function.index 全为 0 → 保留 3 个独立调用', async () => {
    const events = await collect([
      { message: { role: 'assistant', content: '' }, done: false },
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a1', function: { index: 0, name: 'shell', arguments: { command: ['pwd'] } } },
            { id: 'call_b2', function: { index: 0, name: 'shell', arguments: { command: ['ls', '-la'] } } },
            { id: 'call_c3', function: { index: 0, name: 'shell', arguments: { command: ['whoami'] } } },
          ],
        },
        done: false,
      },
      { message: { content: '' }, done: true, done_reason: 'tool_calls', prompt_eval_count: 485, eval_count: 122 },
    ]);

    const ends = toolEnds(events);
    assert.equal(ends.length, 3, '三个 tool_call 不能被折叠成一个');
    assert.deepEqual(ends.map((e) => e.id), ['call_a1', 'call_b2', 'call_c3']);
    // 对外 index 必须唯一，否则 Codex 侧 outputIndex 会互相覆盖
    assert.deepEqual(ends.map((e) => e.index), [0, 1, 2]);
    assert.deepEqual(
      ends.map((e) => JSON.parse(e.arguments).command),
      [['pwd'], ['ls', '-la'], ['whoami']],
    );
  });

  it('每个工具的 arguments 都是可解析的合法 JSON（不被互相拼接污染）', async () => {
    const events = await collect([
      {
        message: {
          tool_calls: [
            { id: 'c1', function: { index: 0, name: 'read_file', arguments: { path: '/a.txt' } } },
            { id: 'c2', function: { index: 0, name: 'read_file', arguments: { path: '/b.txt' } } },
          ],
        },
        done: false,
      },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);

    for (const end of toolEnds(events)) {
      assert.doesNotThrow(() => JSON.parse(end.arguments), `坏 JSON: ${end.arguments}`);
    }
    assert.deepEqual(toolEnds(events).map((e) => JSON.parse(e.arguments).path), ['/a.txt', '/b.txt']);
  });

  it('字符串型 arguments 分片跨 chunk 增量拼接（续传 chunk 无 id，靠 index 归属）', async () => {
    const events = await collect([
      { message: { tool_calls: [{ id: 'call_x', function: { index: 0, name: 'shell', arguments: '{"comm' } }] }, done: false },
      { message: { tool_calls: [{ function: { index: 0, arguments: 'and":["pwd"]}' } }] }, done: false },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);

    const ends = toolEnds(events);
    assert.equal(ends.length, 1, '增量分片不能被误判成第二个工具');
    assert.equal(ends[0].id, 'call_x');
    assert.deepEqual(JSON.parse(ends[0].arguments), { command: ['pwd'] });
  });

  it('本地模型不返回 id 时自动补 id，且不同 index 视为不同工具', async () => {
    const events = await collect([
      { message: { tool_calls: [{ function: { index: 0, name: 'shell', arguments: { command: ['pwd'] } } }] }, done: false },
      { message: { tool_calls: [{ function: { index: 1, name: 'shell', arguments: { command: ['ls'] } } }] }, done: false },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);

    const ends = toolEnds(events);
    assert.equal(ends.length, 2);
    for (const e of ends) assert.match(e.id, /^call_/, 'id 必须补全，空 id 会让 tool_result 无法关联');
    assert.notEqual(ends[0].id, ends[1].id, '补的 id 必须互不相同');
  });

  it('顶层 tc.index 形式（OpenAI 风格）仍然兼容', async () => {
    const events = await collect([
      { message: { tool_calls: [{ id: 'c1', index: 0, function: { name: 'shell', arguments: '{"a":1}' } }] }, done: false },
      { message: { tool_calls: [{ id: 'c2', index: 1, function: { name: 'shell', arguments: '{"b":2}' } }] }, done: false },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);
    const ends = toolEnds(events);
    assert.equal(ends.length, 2);
    assert.deepEqual(ends.map((e) => JSON.parse(e.arguments)), [{ a: 1 }, { b: 2 }]);
  });

  it('工具名在后续 chunk 补全时不丢失', async () => {
    const events = await collect([
      { message: { tool_calls: [{ id: 'c1', function: { index: 0, arguments: '{"x":' } }] }, done: false },
      { message: { tool_calls: [{ function: { index: 0, name: 'shell', arguments: '1}' } }] }, done: false },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);
    assert.equal(toolStarts(events).length, 1);
    assert.equal(toolEnds(events)[0].id, 'c1');
    // name 通过 TOOL_CALL_END 前的补全生效（START 时可能还是空）
    assert.deepEqual(JSON.parse(toolEnds(events)[0].arguments), { x: 1 });
  });

  it('message.thinking 转成 THINKING 事件（此前被整体丢弃）', async () => {
    const events = await collect([
      { message: { content: '', thinking: '让我想想...' }, done: false },
      { message: { content: '答案' }, done: true, done_reason: 'stop' },
    ]);
    const thinking = events.find((e) => e.type === 'THINKING') as { type: string; text: string } | undefined;
    assert.ok(thinking, 'thinking 内容不能被丢弃');
    assert.equal(thinking.text, '让我想想...');
  });

  it('done_reason=length → max_tokens（否则 Codex 把截断当成正常结束）', async () => {
    const events = await collect([{ message: { content: 'hi' }, done: true, done_reason: 'length' }]);
    const end = events.at(-1) as { type: string; stopReason: string };
    assert.equal(end.stopReason, 'max_tokens');
  });

  it('无工具调用的正常结束 → end_turn；有工具调用 → tool_use', async () => {
    const plain = await collect([{ message: { content: 'hi' }, done: true, done_reason: 'stop' }]);
    assert.equal((plain.at(-1) as { stopReason: string }).stopReason, 'end_turn');

    const withTool = await collect([
      { message: { tool_calls: [{ id: 'c1', function: { index: 0, name: 'shell', arguments: {} } }] }, done: false },
      { message: {}, done: true, done_reason: 'tool_calls' },
    ]);
    assert.equal((withTool.at(-1) as { stopReason: string }).stopReason, 'tool_use');
  });

  it('上游 error chunk → ERROR + END(error)', async () => {
    const events = await collect([{ error: 'model not found' }]);
    assert.equal(events[1].type, 'ERROR');
    assert.equal((events.at(-1) as { stopReason: string }).stopReason, 'error');
  });
});

describe('ollama/response 非流式工具调用', () => {
  it('缺 id 时补全 id（空 id 会导致下一轮 tool_result 无法匹配）', () => {
    const resp = parseOllamaResponse(
      {
        model: 'm',
        message: {
          tool_calls: [
            { function: { name: 'shell', arguments: { command: ['pwd'] } } },
            { function: { name: 'shell', arguments: { command: ['ls'] } } },
          ],
        },
        done_reason: 'tool_calls',
      },
      { id: 'x', model: 'm' },
    );

    assert.equal(resp.toolCalls.length, 2);
    for (const tc of resp.toolCalls) assert.match(tc.id, /^call_/);
    assert.notEqual(resp.toolCalls[0].id, resp.toolCalls[1].id);
    assert.equal(resp.stopReason, 'tool_use');
  });

  it('arguments 缺失时给 {} 而非 undefined 字符串', () => {
    const resp = parseOllamaResponse(
      { message: { tool_calls: [{ id: 'c1', function: { name: 'noop' } }] } },
      { id: 'x', model: 'm' },
    );
    assert.equal(resp.toolCalls[0].arguments, '{}');
    assert.doesNotThrow(() => JSON.parse(resp.toolCalls[0].arguments));
  });

  it('对象 arguments 序列化、字符串 arguments 原样透传', () => {
    const resp = parseOllamaResponse(
      {
        message: {
          tool_calls: [
            { id: 'c1', function: { name: 'a', arguments: { k: 'v' } } },
            { id: 'c2', function: { name: 'b', arguments: '{"k":"v2"}' } },
          ],
        },
      },
      { id: 'x', model: 'm' },
    );
    assert.deepEqual(JSON.parse(resp.toolCalls[0].arguments), { k: 'v' });
    assert.deepEqual(JSON.parse(resp.toolCalls[1].arguments), { k: 'v2' });
  });

  it('done_reason=length → max_tokens', () => {
    const resp = parseOllamaResponse(
      { message: { content: 'partial' }, done_reason: 'length' },
      { id: 'x', model: 'm' },
    );
    assert.equal(resp.stopReason, 'max_tokens');
  });

  it('message.thinking 保留为 thinking content', () => {
    const resp = parseOllamaResponse(
      { message: { content: '答案', thinking: '推理过程' } },
      { id: 'x', model: 'm' },
    );
    assert.ok(resp.content.some((c) => c.type === 'thinking'));
  });
});

describe('ollama/request think 字段', () => {
  const base = (thinking: unknown) =>
    buildOllamaRequest(
      createStandardRequest({
        id: 'r',
        agent: 'codex',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        parameters: { thinking: thinking as never },
      }),
      'm',
    );

  it('thinking={type:"disabled"} 不能翻译成 think:true', () => {
    assert.notEqual(base({ type: 'disabled' }).think, true);
  });

  it('thinking={type:"enabled"} → think:true', () => {
    assert.equal(base({ type: 'enabled' }).think, true);
  });

  it('thinking=true → think:true；未指定则不带 think 字段', () => {
    assert.equal(base(true).think, true);
    assert.equal(base(undefined).think, undefined);
  });
});
