/**
 * OpenAI Responses API 响应 → StandardResponse
 */

import { createStandardResponse } from '../../protocol/standard-response.js';
import type {
  StandardResponse,
  StandardResponseContent,
  StandardToolCall,
  StandardStopDetails,
} from '../../protocol/standard-response.js';

interface ResponsesResponse {
  id?: string;
  model?: string;
  status?: string;
  error?: { code?: string; message?: string };
  incomplete_details?: { reason?: string };
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string; refusal?: string }>;
    summary?: Array<{ type: string; text?: string }>;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * 根据 Responses API 的 status + incomplete_details 推断 stopReason。
 *
 * 注意：incomplete_details.reason 的官方枚举值是 'max_output_tokens' | 'content_filter'，
 * 不是 Chat Completions 里的 'max_tokens'。
 */
function determineResponsesStopReason(
  status?: string,
  incompleteDetails?: { reason?: string },
  hasToolCalls?: boolean,
  hasRefusal?: boolean,
): StandardResponse['stopReason'] {
  if (status === 'failed') return 'error';
  if (hasRefusal) return 'refusal';
  if (status === 'incomplete' && incompleteDetails?.reason === 'max_output_tokens') return 'max_tokens';
  if (status === 'incomplete' && incompleteDetails?.reason === 'content_filter') return 'stop_sequence';
  if (hasToolCalls) return 'tool_use';
  return 'end_turn';
}

export function parseResponsesResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as ResponsesResponse;
  const content: StandardResponseContent[] = [];
  const toolCalls: StandardToolCall[] = [];
  let hasRefusal = false;
  let stopDetails: StandardStopDetails | null = null;

  // 文本输出：以 output_text 为权威来源（与官方 SDK addOutputText 对齐），
  // 避免遍历 output[].content 时出现重复/遗漏。
  if (typeof resp.output_text === 'string' && resp.output_text) {
    content.push({ type: 'text', text: resp.output_text });
  }

  for (const item of resp.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'refusal') {
          hasRefusal = true;
          stopDetails = {
            type: 'refusal',
            explanation: c.refusal,
          };
        }
      }
    } else if (item.type === 'reasoning') {
      // reasoning 是独立 output item，含 reasoning_text（正文）和 summary_text（摘要）。
      // 优先取 reasoning_text 作为 thinking 内容；没有则 fallback 到 summary。
      const reasoningParts: string[] = [];
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'reasoning_text' && c.text) {
            reasoningParts.push(c.text);
          }
        }
      }
      if (reasoningParts.length === 0 && Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (s.type === 'summary_text' && s.text) {
            reasoningParts.push(s.text);
          }
        }
      }
      const reasoningText = reasoningParts.join('\n');
      if (reasoningText) {
        content.push({ type: 'thinking', text: reasoningText });
      }
    } else if (item.type === 'function_call') {
      // call_id 是 function_call 的主键；id 是 item 在 output 列表中的 id，二者值通常相同但语义不同。
      toolCalls.push({
        id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: item.arguments || '{}',
      });
    }
  }

  const usage = resp.usage ?? {};
  const reason = determineResponsesStopReason(resp.status, resp.incomplete_details, toolCalls.length > 0, hasRefusal);

  // 上游显式报错且 HTTP 200 的罕见场景
  if (resp.error && reason !== 'error') {
    return createStandardResponse({
      id: resp.id || request.id,
      model: resp.model || request.model,
      content,
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        cachedInputTokens: usage.input_tokens_details?.cached_tokens,
        reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens,
      },
      stopReason: 'error',
      stopDetails: null,
      raw,
    });
  }

  return createStandardResponse({
    id: resp.id || request.id,
    model: resp.model || request.model,
    content,
    toolCalls,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cachedInputTokens: usage.input_tokens_details?.cached_tokens,
      reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens,
    },
    stopReason: reason,
    stopDetails,
    raw,
  });
}
