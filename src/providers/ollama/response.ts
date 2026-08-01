/**
 * Ollama 响应 → StandardResponse
 */

import { createStandardResponse } from '../../protocol/standard-response.js';
import type { StandardResponse, StandardResponseContent, StandardToolCall } from '../../protocol/standard-response.js';

interface OllamaResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export function parseOllamaResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as OllamaResponse;
  const message = resp.message ?? {};
  const content: StandardResponseContent[] = [];
  const toolCalls: StandardToolCall[] = [];

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  for (const tc of message.tool_calls ?? []) {
    const fn = tc.function ?? {};
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    toolCalls.push({
      id: tc.id ?? '',
      name: fn.name ?? '',
      arguments: args,
    });
  }

  return createStandardResponse({
    id: request.id,
    model: resp.model || request.model,
    content,
    toolCalls,
    usage: {
      inputTokens: resp.prompt_eval_count ?? 0,
      outputTokens: resp.eval_count ?? 0,
      totalTokens: (resp.prompt_eval_count ?? 0) + (resp.eval_count ?? 0),
    },
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    raw,
  });
}
