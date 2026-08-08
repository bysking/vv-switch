/**
 * Ollama 响应 → StandardResponse
 */

import { createStandardResponse } from '../../protocol/standard-response.js';
import type { StandardResponse, StandardResponseContent, StandardToolCall, StandardStopReason } from '../../protocol/standard-response.js';
import { makeId } from '../../utils/id.js';

interface OllamaResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

/**
 * Ollama done_reason → StandardStopReason。
 * 'length'(截断) 必须映射为 max_tokens，否则 Codex 会把半截输出当成正常结束。
 */
function mapDoneReason(reason: string | undefined): StandardStopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

export function parseOllamaResponse(
  raw: unknown,
  request: { id: string; model: string },
): StandardResponse {
  const resp = (raw || {}) as OllamaResponse;
  const message = resp.message ?? {};
  const content: StandardResponseContent[] = [];
  const toolCalls: StandardToolCall[] = [];

  // Ollama 把思考内容放在 message.thinking（think:true 时），此前被整体丢弃
  if (message.thinking) {
    content.push({ type: 'thinking', text: message.thinking });
  }

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  for (const tc of message.tool_calls ?? []) {
    const fn = tc.function ?? {};
    // arguments 必须始终是 JSON 字符串：对象要序列化，字符串原样透传。
    // 缺 arguments 时给 '{}' 而不是 'undefined'/空串，避免下游 JSON.parse 失败。
    let args: string;
    if (typeof fn.arguments === 'string') {
      args = fn.arguments;
    } else if (fn.arguments != null) {
      args = JSON.stringify(fn.arguments);
    } else {
      args = '{}';
    }
    toolCalls.push({
      // 本地模型常不返回 id，但 Codex/Claude 都靠 call_id 关联 tool_result，
      // 空 id 会让下一轮工具结果无法匹配 → 必须补一个稳定 id
      id: tc.id || makeId('call'),
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
    stopReason: toolCalls.length > 0 ? 'tool_use' : mapDoneReason(resp.done_reason),
    raw,
  });
}
