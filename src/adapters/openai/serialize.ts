/**
 * StandardResponse → OpenAI Chat Completions 响应体（非流式）
 */

import type { StandardResponse } from '../../protocol/standard-response.js';
import type { AdapterContext } from '../../types/adapter.js';
import { toChatFinishReason } from '../shared/stop-reason.js';

export interface ChatCompletionResponseBody {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function serializeOpenAIResponse(
  response: StandardResponse,
  _context: AdapterContext,
): ChatCompletionResponseBody {
  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  const reasoning = response.content
    .filter((c) => c.type === 'thinking')
    .map((c) => c.text)
    .join('');

  const toolCalls = response.toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));

  const message: ChatCompletionResponseBody['choices'][number]['message'] = {
    role: 'assistant',
    content: text || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toChatFinishReason(response.stopReason, toolCalls.length > 0),
    }],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
    },
  };
}
