/**
 * StandardResponse → OpenAI Responses API 响应体
 */

import type { StandardResponse } from '../../protocol/standard-response.js';
import type { AdapterContext } from '../../types/adapter.js';
import { makeId } from '../../utils/id.js';
import { toResponsesTerminal } from '../shared/stop-reason.js';

export interface ResponsesResponseBody {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete' | 'failed';
  model: string;
  output: Array<Record<string, unknown>>;
  usage: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens: number };
    total_tokens: number;
  };
  parallel_tool_calls: boolean;
  previous_response_id: null;
  reasoning?: { effort: string; summary: string };
  text: { format: { type: 'text' } };
  tools: Array<unknown>;
  truncation: 'disabled';
  store: false;
  incomplete_details?: { reason: string };
}

export function serializeCodexResponse(
  response: StandardResponse,
  context: AdapterContext,
): ResponsesResponseBody {
  const output: Array<Record<string, unknown>> = [];

  // 文本输出（含 thinking）
  const text = response.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (text || response.content.length > 0) {
    output.push({
      id: makeId('msg'),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text,
        annotations: [],
      }],
    });
  }

  // 工具调用
  for (const tc of response.toolCalls) {
    output.push({
      id: tc.id,
      type: 'function_call',
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: 'completed',
    });
  }

  // 推理内容
  const reasoningParts = response.content
    .filter((c) => c.type === 'thinking')
    .map((c) => c.text)
    .filter(Boolean);

  // 从 context 中提取 reasoning effort（如果有），默认 medium
  const ctxEffort = (context as Record<string, unknown>).reasoningEffort;
  const reasoningEffort = typeof ctxEffort === 'string' && ctxEffort ? ctxEffort : 'medium';

  // 终态按 stopReason 映射(截断→incomplete,错误→failed),单一权威来源在 shared/stop-reason
  const terminal = toResponsesTerminal(response.stopReason);

  const body: ResponsesResponseBody = {
    id: response.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: terminal.status,
    model: response.model,
    output,
    usage: {
      input_tokens: response.usage.inputTokens,
      input_tokens_details: {
        // Anthropic 上游 → Codex 客户端时,cache_read_input_tokens 等同于 cached_tokens
        cached_tokens: response.usage.cachedInputTokens ?? response.usage.cacheReadInputTokens ?? 0,
      },
      output_tokens: response.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: response.usage.reasoningOutputTokens ?? 0 },
      total_tokens: response.usage.totalTokens,
    },
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: reasoningEffort, summary: reasoningParts.join('\n') || 'auto' },
    text: { format: { type: 'text' } },
    tools: [],
    truncation: 'disabled',
    store: false,
  };
  if (terminal.incomplete_details) {
    body.incomplete_details = terminal.incomplete_details;
  }
  return body;
}
