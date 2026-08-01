/**
 * Chat Completions 响应 → StandardResponse
 */

import type { StandardResponse, StandardResponseContent, StandardToolCall, StandardStopReason } from '../../protocol/standard-response.js';
import { createStandardResponse } from '../../protocol/standard-response.js';
import { makeId } from '../../utils/id.js';

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string | object };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function finishReasonToStop(finish: string | undefined): StandardStopReason {
  switch (finish) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'stop_sequence';
    default: return 'end_turn';
  }
}

export function parseChatResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as ChatCompletionResponse;
  const choice = resp.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const finish = choice.finish_reason;
  const usage = resp.usage ?? {};

  const content: StandardResponseContent[] = [];

  if (message.reasoning_content) {
    content.push({ type: 'thinking', text: message.reasoning_content });
  }
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  const toolCalls: StandardToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc.function ?? {};
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      toolCalls.push({
        id: tc.id || makeId('call'),
        name: fn.name || '',
        arguments: args,
      });
    }
  }

  return createStandardResponse({
    id: request.id,
    model: resp.model || request.model,
    content,
    toolCalls,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
      reasoningOutputTokens: usage.completion_tokens_details?.reasoning_tokens,
    },
    stopReason: finishReasonToStop(finish),
    raw,
  });
}
