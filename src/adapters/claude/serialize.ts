/**
 * StandardResponse → Anthropic Messages 响应体
 */

import type {
  StandardResponse,
  StandardStopDetails,
} from '../../protocol/standard-response.js';
import type { AdapterContext } from '../../types/adapter.js';
import { toAnthropicStopReason } from '../shared/stop-reason.js';
import { safeParseJson } from '../shared/util.js';

export interface AnthropicResponseBody {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: string;
  stop_sequence: null;
  stop_details?: StandardStopDetails | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function serializeClaudeResponse(
  response: StandardResponse,
  _context: AdapterContext,
): AnthropicResponseBody {
  const content: Array<Record<string, unknown>> = [];

  // thinking blocks 必须放在最前面(Anthropic 约定),并保留 signature
  for (const part of response.content) {
    if (part.type === 'thinking') {
      const block: Record<string, unknown> = { type: 'thinking', thinking: part.text };
      if (part.signature) block.signature = part.signature;
      content.push(block);
    } else if (part.type === 'redacted_thinking') {
      content.push({ type: 'redacted_thinking', data: part.data });
    }
  }

  // 然后是 text
  for (const part of response.content) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text });
    }
  }

  // tool_use blocks
  for (const tc of response.toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: safeParseJson(tc.arguments),
    });
  }

  const usage: AnthropicResponseBody['usage'] = {
    input_tokens: response.usage.inputTokens,
    output_tokens: response.usage.outputTokens,
  };
  if (response.usage.cacheCreationInputTokens != null) {
    usage.cache_creation_input_tokens = response.usage.cacheCreationInputTokens;
  }
  if (response.usage.cacheReadInputTokens != null) {
    usage.cache_read_input_tokens = response.usage.cacheReadInputTokens;
  } else if (response.usage.cachedInputTokens != null) {
    // OpenAI-compatible 上游 → Claude 客户端:cached_tokens 等同于 cache_read_input_tokens
    usage.cache_read_input_tokens = response.usage.cachedInputTokens;
  }

  const body: AnthropicResponseBody = {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: toAnthropicStopReason(response.stopReason),
    stop_sequence: null,
    usage,
  };

  // 仅在 refusal 时输出 stop_details(SKILL.md line 455)
  if (response.stopReason === 'refusal' && response.stopDetails) {
    body.stop_details = response.stopDetails;
  }

  return body;
}
