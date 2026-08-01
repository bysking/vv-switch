/**
 * OpenAI Responses API 响应 → StandardResponse
 */

import { createStandardResponse } from '../../protocol/standard-response.js';
import type { StandardResponse, StandardResponseContent, StandardToolCall } from '../../protocol/standard-response.js';

interface ResponsesResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** 根据 Responses API 的 status + incomplete_details 推断 stopReason */
function determineResponsesStopReason(
  status?: string,
  incompleteDetails?: { reason?: string },
  hasToolCalls?: boolean,
): string {
  if (status === 'incomplete' && incompleteDetails?.reason === 'max_tokens') return 'max_tokens';
  if (hasToolCalls) return 'tool_use';
  if (status === 'incomplete' && incompleteDetails?.reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}

export function parseResponsesResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as ResponsesResponse;
  const content: StandardResponseContent[] = [];
  const toolCalls: StandardToolCall[] = [];

  if (typeof resp.output_text === 'string' && resp.output_text) {
    content.push({ type: 'text', text: resp.output_text });
  }

  for (const item of resp.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) {
          if (!content.some((b) => b.type === 'text' && b.text === c.text)) {
            content.push({ type: 'text', text: c.text });
          }
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: item.arguments || '{}',
      });
    }
  }

  const usage = resp.usage ?? {};
  return createStandardResponse({
    id: resp.id || request.id,
    model: resp.model || request.model,
    content,
    toolCalls,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
    stopReason: determineResponsesStopReason(resp.status, resp.incomplete_details, toolCalls.length > 0),
    raw,
  });
}
