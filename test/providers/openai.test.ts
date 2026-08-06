/**
 * OpenAI Responses Provider 单元测试
 *
 * 覆盖策略A:previous_response_id 透传等 Responses API 特有字段
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequest } from '../../src/providers/openai/request.js';
import { parseResponsesResponse } from '../../src/providers/openai/response.js';
import { createStandardRequest } from '../../src/protocol/standard-request.js';

describe('providers/openai buildResponsesRequest — previous_response_id 透传', () => {
  it('metadata.previousResponseId 有值时，透传到 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        previousResponseId: 'resp_abc123',
      },
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, 'resp_abc123');
  });

  it('metadata.previousResponseId 为空时，不包含 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, undefined);
  });

  it('metadata.previousResponseId 为空字符串时，不包含 previous_response_id 字段', () => {
    const req = createStandardRequest({
      id: 'r',
      agent: 'codex',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: {
        previousResponseId: '',
      },
    });
    const upstreamReq = buildResponsesRequest(req);
    assert.equal(upstreamReq.previous_response_id, undefined);
  });
});

describe('providers/openai parseResponsesResponse — stopReason 映射', () => {
  const baseResp = {
    id: 'resp_1',
    model: 'gpt-4o',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    output_text: 'hi',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const ctx = { id: 'req_1', model: 'gpt-4o' };

  it('status=completed 且无工具 → end_turn', () => {
    const r = parseResponsesResponse({ ...baseResp, status: 'completed' }, ctx);
    assert.equal(r.stopReason, 'end_turn');
  });

  it('status=incomplete + reason=max_output_tokens → max_tokens（官方枚举值）', () => {
    const r = parseResponsesResponse(
      { ...baseResp, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      ctx,
    );
    assert.equal(r.stopReason, 'max_tokens');
  });

  it('status=incomplete + reason=content_filter → stop_sequence', () => {
    const r = parseResponsesResponse(
      { ...baseResp, status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
      ctx,
    );
    assert.equal(r.stopReason, 'stop_sequence');
  });

  it('status=failed → error', () => {
    const r = parseResponsesResponse({ ...baseResp, status: 'failed' }, ctx);
    assert.equal(r.stopReason, 'error');
  });

  it('有 function_call → tool_use', () => {
    const r = parseResponsesResponse(
      {
        ...baseResp,
        status: 'completed',
        output: [
          ...baseResp.output,
          { type: 'function_call', call_id: 'call_1', name: 'foo', arguments: '{}' },
        ],
      },
      ctx,
    );
    assert.equal(r.stopReason, 'tool_use');
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].id, 'call_1');
    assert.equal(r.toolCalls[0].name, 'foo');
  });
});

describe('providers/openai parseResponsesResponse — usage details', () => {
  const ctx = { id: 'req_1', model: 'gpt-4o' };

  it('透传 input_tokens_details.cached_tokens → cachedInputTokens', () => {
    const r = parseResponsesResponse(
      {
        id: 'r', model: 'm', status: 'completed',
        output_text: 'hi',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: {
          input_tokens: 100, output_tokens: 50, total_tokens: 150,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
          output_tokens_details: { reasoning_tokens: 30 },
        },
      },
      ctx,
    );
    assert.equal(r.usage.cachedInputTokens, 80);
    assert.equal(r.usage.reasoningOutputTokens, 30);
    assert.equal(r.usage.inputTokens, 100);
    assert.equal(r.usage.outputTokens, 50);
    assert.equal(r.usage.totalTokens, 150);
  });

  it('无 details 时字段为 undefined（非 0）', () => {
    const r = parseResponsesResponse(
      {
        id: 'r', model: 'm', status: 'completed',
        output_text: 'hi',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    assert.equal(r.usage.cachedInputTokens, undefined);
    assert.equal(r.usage.reasoningOutputTokens, undefined);
  });
});

describe('providers/openai parseResponsesResponse — reasoning item', () => {
  const ctx = { id: 'req_1', model: 'o3' };

  it('type=reasoning 的 content.reasoning_text → thinking 内容', () => {
    const r = parseResponsesResponse(
      {
        id: 'r', model: 'o3', status: 'completed',
        output_text: 'answer',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
          {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'think step 1' }, { type: 'reasoning_text', text: 'think step 2' }],
            summary: [{ type: 'summary_text', text: 'summary' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    const thinking = r.content.find((c) => c.type === 'thinking');
    assert.ok(thinking, 'should have thinking content');
    assert.equal(thinking.type, 'thinking');
    // 优先取 reasoning_text，不取 summary
    assert.ok(thinking.text.includes('think step 1'));
    assert.ok(thinking.text.includes('think step 2'));
  });

  it('reasoning 只有 summary 没有 content 时，fallback 到 summary_text', () => {
    const r = parseResponsesResponse(
      {
        id: 'r', model: 'o3', status: 'completed',
        output_text: 'answer',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'sum1' }, { type: 'summary_text', text: 'sum2' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    const thinking = r.content.find((c) => c.type === 'thinking');
    assert.ok(thinking);
    assert.ok(thinking.text.includes('sum1'));
    assert.ok(thinking.text.includes('sum2'));
  });
});

describe('providers/openai parseResponsesResponse — refusal', () => {
  const ctx = { id: 'req_1', model: 'gpt-4o' };

  it('message content 含 type=refusal → stopReason=refusal + stopDetails', () => {
    const r = parseResponsesResponse(
      {
        id: 'r', model: 'm', status: 'completed',
        output_text: '',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
      ctx,
    );
    assert.equal(r.stopReason, 'refusal');
    assert.ok(r.stopDetails, 'stopDetails should be set');
    assert.equal(r.stopDetails?.type, 'refusal');
    assert.equal(r.stopDetails?.explanation, 'I cannot help with that.');
  });
});
