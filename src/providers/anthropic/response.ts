/**
 * Anthropic Messages 响应 → StandardResponse
 */

import { createStandardResponse } from '../../protocol/standard-response.js';
import type {
  StandardResponse,
  StandardResponseContent,
  StandardToolCall,
  StandardStopReason,
  StandardStopDetails,
} from '../../protocol/standard-response.js';

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    thinking?: string;
    signature?: string;
    data?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
  stop_details?: {
    type?: string;
    category?: string | null;
    explanation?: string;
  } | null;
}

function anthropicStopToStandard(stop: string | undefined): StandardStopReason {
  switch (stop) {
    case 'end_turn': return 'end_turn';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    case 'tool_use': return 'tool_use';
    case 'pause_turn': return 'pause_turn';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

export function parseAnthropicResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as AnthropicResponse;
  const content: StandardResponseContent[] = [];
  const toolCalls: StandardToolCall[] = [];

  for (const block of resp.content ?? []) {
    if (block.type === 'text' && block.text) {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      // thinking block 可能为空字符串(display: 'omitted'),但仍需保留占位以传回 signature
      const text = block.thinking ?? block.text ?? '';
      const item: StandardResponseContent = { type: 'thinking', text };
      if (block.signature) item.signature = block.signature;
      content.push(item);
    } else if (block.type === 'redacted_thinking' && block.data) {
      content.push({ type: 'redacted_thinking', data: block.data });
    } else if (block.type === 'tool_use') {
      const args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {});
      toolCalls.push({ id: block.id || '', name: block.name || '', arguments: args });
    }
  }

  const usage = resp.usage ?? {};
  const stopReason = anthropicStopToStandard(resp.stop_reason);

  let stopDetails: StandardStopDetails | null = null;
  if (stopReason === 'refusal' && resp.stop_details && resp.stop_details.type === 'refusal') {
    stopDetails = {
      type: 'refusal',
      category: resp.stop_details.category ?? null,
      explanation: resp.stop_details.explanation,
    };
  }

  return createStandardResponse({
    id: resp.id || request.id,
    model: resp.model || request.model,
    content,
    toolCalls,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    },
    stopReason,
    stopDetails,
    raw,
  });
}
