/**
 * Claude + Chat 类型 API 工具调用集成测试
 *
 * 验证场景:
 * Claude 客户端发送 /v1/messages 请求 → vv-switch 使用 chat 类型供应商上游
 * → 上游返回 OpenAI Chat Completions SSE 格式（含 tool_calls）
 * → vv-switch 输出正确的 Claude SSE 格式（stop_reason: tool_use）
 *
 * Bug 回归测试:
 * parseChatStream 在处理 finish_reason: 'tool_calls' 时,
 * 先发送 TOOL_CALL_END 再 clear activeTools,
 * 导致最终 stopReason 总是 'end_turn' 而非 'tool_use'。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatStream } from '../src/providers/openai-compatible/stream.js';
import { serializeClaudeStream } from '../src/adapters/claude/stream.js';
import { buildChatRequest } from '../src/providers/openai-compatible/request.js';
import { createStandardRequest } from '../src/protocol/standard-request.js';
import type { StreamEvent } from '../src/protocol/stream-events.js';

/**
 * 构造模拟的 OpenAI Chat Completions SSE 响应
 * 包含文本 + 工具调用 + finish_reason: 'tool_calls'
 */
function buildMockSSEChunks(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
}): string {
  const chunks: string[] = [];

  // 起始 chunk
  chunks.push(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1234567890,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    }],
  }));

  // 文本内容
  if (opts.text) {
    // 分两次发送文本
    const mid = Math.ceil(opts.text.length / 2);
    chunks.push(JSON.stringify({
      choices: [{ delta: { content: opts.text.slice(0, mid) }, finish_reason: null }],
    }));
    chunks.push(JSON.stringify({
      choices: [{ delta: { content: opts.text.slice(mid) }, finish_reason: null }],
    }));
  }

  // 工具调用
  if (opts.toolCalls && opts.toolCalls.length > 0) {
    for (let i = 0; i < opts.toolCalls.length; i++) {
      const tc = opts.toolCalls[i];
      // TOOL_CALL_START (含 id 和 name)
      chunks.push(JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      }));

      // TOOL_CALL_DELTA (参数分段)
      const argMid = Math.ceil(tc.arguments.length / 2);
      if (argMid > 0) {
        chunks.push(JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                function: { arguments: tc.arguments.slice(0, argMid) },
              }],
            },
            finish_reason: null,
          }],
        }));
        chunks.push(JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                function: { arguments: tc.arguments.slice(argMid) },
              }],
            },
            finish_reason: null,
          }],
        }));
      }
    }
  }

  // 结束 chunk (finish_reason)
  chunks.push(JSON.stringify({
    choices: [{
      delta: {},
      finish_reason: opts.finishReason ?? (opts.toolCalls?.length ? 'tool_calls' : 'stop'),
    }],
  }));

  // usage chunk
  chunks.push(JSON.stringify({
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }));

  // 转为 SSE 格式
  return chunks.map(c => `data: ${c}`).join('\n') + '\n';
}

/**
 * 创建模拟 Response 对象
 */
function mockResponse(sseBody: string): Response {
  const encoder = new TextEncoder();
  const uint8 = encoder.encode(sseBody);

  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(uint8);
        controller.close();
      },
    }),
  } as unknown as Response;
}

/**
 * 收集 AsyncGenerator 产出的所有事件
 */
async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of gen) {
    result.push(item);
  }
  return result;
}

describe('parseChatStream - tool_calls stopReason', () => {
  it('finish_reason=tool_calls → END 事件 stopReason 应为 tool_use', async () => {
    const sse = buildMockSSEChunks({
      text: '让我帮你查一下',
      toolCalls: [
        { id: 'call_abc123', name: 'get_weather', arguments: '{"city":"北京"}' },
      ],
      finishReason: 'tool_calls',
    });

    const response = mockResponse(sse);
    const events = await collectEvents(parseChatStream(response, { id: 'msg_test', model: 'test-model' }));

    // 验证事件类型
    const eventTypes = events.map(e => e.type);
    assert.ok(eventTypes.includes('START'), '应包含 START 事件');
    assert.ok(eventTypes.includes('TOKEN'), '应包含 TOKEN 事件');
    assert.ok(eventTypes.includes('TOOL_CALL_START'), '应包含 TOOL_CALL_START 事件');
    assert.ok(eventTypes.includes('TOOL_CALL_DELTA'), '应包含 TOOL_CALL_DELTA 事件');
    assert.ok(eventTypes.includes('TOOL_CALL_END'), '应包含 TOOL_CALL_END 事件');
    assert.ok(eventTypes.includes('END'), '应包含 END 事件');

    // 关键断言：END 事件的 stopReason 应为 tool_use
    const endEvent = events.find(e => e.type === 'END') as StreamEvent & { stopReason?: string };
    assert.equal(endEvent?.stopReason, 'tool_use',
      'END 事件 stopReason 应为 tool_use (不是 end_turn)');
  });

  it('finish_reason=stop → END 事件 stopReason 应为 end_turn', async () => {
    const sse = buildMockSSEChunks({
      text: '你好，我是AI助手',
      finishReason: 'stop',
    });

    const response = mockResponse(sse);
    const events = await collectEvents(parseChatStream(response, { id: 'msg_test', model: 'test-model' }));

    const endEvent = events.find(e => e.type === 'END') as StreamEvent & { stopReason?: string };
    assert.equal(endEvent?.stopReason, 'end_turn',
      'END 事件 stopReason 应为 end_turn');
  });

  it('多个工具调用 → 所有工具都有 TOOL_CALL_END,且最终 stopReason=tool_use', async () => {
    const sse = buildMockSSEChunks({
      toolCalls: [
        { id: 'call_1', name: 'bash', arguments: '{"command":"date"}' },
        { id: 'call_2', name: 'read_file', arguments: '{"path":"/tmp/test"}' },
      ],
      finishReason: 'tool_calls',
    });

    const response = mockResponse(sse);
    const events = await collectEvents(parseChatStream(response, { id: 'msg_test', model: 'test-model' }));

    const toolCallEnds = events.filter(e => e.type === 'TOOL_CALL_END');
    assert.equal(toolCallEnds.length, 2, '应有 2 个 TOOL_CALL_END 事件');

    const endEvent = events.find(e => e.type === 'END') as StreamEvent & { stopReason?: string };
    assert.equal(endEvent?.stopReason, 'tool_use');
  });

  it('finish_reason=length → END 事件 stopReason 应为 max_tokens(截断必须透传)', async () => {
    const sse = buildMockSSEChunks({
      text: '这是一段被截断的输出',
      finishReason: 'length',
    });
    const response = mockResponse(sse);
    const events = await collectEvents(parseChatStream(response, { id: 'msg_test', model: 'test-model' }));
    const endEvent = events.find(e => e.type === 'END') as StreamEvent & { stopReason?: string };
    assert.equal(endEvent?.stopReason, 'max_tokens',
      '上游 finish_reason=length 必须透传为 max_tokens,否则出口无法上报截断');
  });

  it('finish_reason=content_filter → END 事件 stopReason 应为 stop_sequence', async () => {
    const sse = buildMockSSEChunks({ text: 'x', finishReason: 'content_filter' });
    const response = mockResponse(sse);
    const events = await collectEvents(parseChatStream(response, { id: 'msg_test', model: 'test-model' }));
    const endEvent = events.find(e => e.type === 'END') as StreamEvent & { stopReason?: string };
    assert.equal(endEvent?.stopReason, 'stop_sequence');
  });
});

describe('serializeClaudeStream - tool_use stop_reason 不被覆盖', () => {
  it('TOOL_CALL_END 设置的 tool_use 不被后续 END(end_turn) 覆盖', async () => {
    // 模拟 StreamEvent 序列：TOOL_CALL_END 先设置 tool_use,END 事件带来 end_turn
    const events: StreamEvent[] = [
      { type: 'START', id: 'msg_test', model: 'test-model' },
      { type: 'TOOL_CALL_START', id: 'call_1', name: 'bash', index: 0 },
      { type: 'TOOL_CALL_DELTA', id: 'call_1', index: 0, argumentsDelta: '{"command":"date"}' },
      { type: 'TOOL_CALL_END', id: 'call_1', index: 0, arguments: '{"command":"date"}' },
      { type: 'USAGE', inputTokens: 100, outputTokens: 50 },
      { type: 'END', stopReason: 'end_turn' },  // 这个 end_turn 不应该覆盖 tool_use
    ];

    async function* eventSource() {
      for (const e of events) yield e;
    }

    const output = await collectEvents(serializeClaudeStream(
      eventSource(),
      { id: 'msg_test', defaultModel: 'test-model' },
    ));

    // 将所有输出拼接为完整 SSE 字符串
    const fullSSE = output.join('');

    // 查找 message_delta 事件中的 stop_reason
    const messageDeltaMatch = fullSSE.match(/event: message_delta\ndata: (.+?)\n/);
    assert.ok(messageDeltaMatch, '应包含 message_delta 事件');

    const messageDelta = JSON.parse(messageDeltaMatch![1]);
    assert.equal(messageDelta.delta?.stop_reason, 'tool_use',
      'message_delta 的 stop_reason 应为 tool_use,而非 end_turn');
  });

  it('纯文本响应 → stop_reason 为 end_turn', async () => {
    const events: StreamEvent[] = [
      { type: 'START', id: 'msg_test', model: 'test-model' },
      { type: 'TOKEN', text: '你好' },
      { type: 'USAGE', inputTokens: 10, outputTokens: 5 },
      { type: 'END', stopReason: 'end_turn' },
    ];

    async function* eventSource() {
      for (const e of events) yield e;
    }

    const output = await collectEvents(serializeClaudeStream(
      eventSource(),
      { id: 'msg_test', defaultModel: 'test-model' },
    ));

    const fullSSE = output.join('');
    const messageDeltaMatch = fullSSE.match(/event: message_delta\ndata: (.+?)\n/);
    assert.ok(messageDeltaMatch);

    const messageDelta = JSON.parse(messageDeltaMatch![1]);
    assert.equal(messageDelta.delta?.stop_reason, 'end_turn');
  });
});

describe('端到端: parseChatStream → serializeClaudeStream 工具调用流程', () => {
  it('完整工具调用流程: SSE 输入 → Claude SSE 输出', async () => {
    const sse = buildMockSSEChunks({
      text: '让我帮你执行命令',
      toolCalls: [
        { id: 'call_xyz', name: 'bash', arguments: '{"command":"echo hello"}' },
      ],
      finishReason: 'tool_calls',
    });

    // Step 1: parseChatStream 将上游 SSE 转为 StreamEvent
    const response = mockResponse(sse);
    const streamEvents = await collectEvents(
      parseChatStream(response, { id: 'msg_e2e', model: 'test-model' }),
    );

    // Step 2: serializeClaudeStream 将 StreamEvent 转为 Claude SSE
    async function* eventSource() {
      for (const e of streamEvents) yield e;
    }

    const claudeSSE = await collectEvents(serializeClaudeStream(
      eventSource(),
      { id: 'msg_e2e', defaultModel: 'test-model' },
    ));

    const fullOutput = claudeSSE.join('');

    // 验证包含关键事件
    assert.ok(fullOutput.includes('event: message_start'), '应包含 message_start');
    assert.ok(fullOutput.includes('event: content_block_start'), '应包含 content_block_start');
    assert.ok(fullOutput.includes('"type":"tool_use"'), '应包含 tool_use block');
    assert.ok(fullOutput.includes('"name":"bash"'), '应包含工具名 bash');
    assert.ok(fullOutput.includes('event: message_stop'), '应包含 message_stop');

    // 关键: stop_reason 应为 tool_use
    assert.ok(fullOutput.includes('"stop_reason":"tool_use"'),
      'message_delta 中 stop_reason 应为 tool_use');
  });
});

describe('百炼 chat 兼容: thinking adaptive → auto 映射', () => {
  // 回归测试: 百炼 chat API 的 thinking.type 只接受 ["enabled","disabled","auto"],
  // 透传 Anthropic 的 "adaptive" 会触发 400:
  //   'type' must be in ["enabled", "disabled", "auto"]

  it('Claude 发送 thinking.adaptive → 上游请求 thinking.type 为 auto', () => {
    // 模拟 Claude Code 客户端发送的 thinking 配置
    const stdReq = createStandardRequest({
      id: 'r1',
      agent: 'claude',
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    });

    const built = buildChatRequest(stdReq, 'qwen3.7-plus');

    // thinking 字段应存在且 type 为 auto(不是 adaptive)
    assert.ok(built.thinking, '应包含 thinking 字段');
    assert.equal((built.thinking as { type: string }).type, 'auto',
      'thinking.type 应为 auto,百炼不接受 adaptive');
    // display 字段应被丢弃(Anthropic 专有,百炼不认)
    assert.equal((built.thinking as { display?: string }).display, undefined,
      'display 应被丢弃');
  });

  it('Claude 发送 thinking.enabled → 上游请求 thinking.type 保持 enabled', () => {
    const stdReq = createStandardRequest({
      id: 'r1',
      agent: 'claude',
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        thinking: { type: 'enabled', budgetTokens: 10240 },
      },
    });

    const built = buildChatRequest(stdReq, 'qwen3.7-plus');
    assert.equal((built.thinking as { type: string }).type, 'enabled');
    assert.equal((built.thinking as { budget_tokens?: number }).budget_tokens, 10240);
  });

  it('Claude 发送 thinking.disabled → 上游请求不包含 thinking 字段', () => {
    const stdReq = createStandardRequest({
      id: 'r1',
      agent: 'claude',
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        thinking: { type: 'disabled' },
      },
    });

    const built = buildChatRequest(stdReq, 'qwen3.7-plus');
    assert.equal(built.thinking, undefined, 'disabled 时不应发送 thinking 字段');
  });

  it('请求体中不应出现 "adaptive" 字符串(序列化后)', () => {
    const stdReq = createStandardRequest({
      id: 'r1',
      agent: 'claude',
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    });

    const built = buildChatRequest(stdReq, 'qwen3.7-plus');
    const serialized = JSON.stringify(built);
    assert.ok(!serialized.includes('adaptive'),
      '序列化后的请求体不应包含 adaptive(百炼会 400)');
  });
});
