/**
 * Ollama 流式响应 → StreamEvent 序列
 *
 * Ollama 流式返回 NDJSON（每行一个 JSON）
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import { makeId } from '../../utils/id.js';

interface OllamaStreamChunk {
  message?: {
    content?: string;
    tool_calls?: Array<{
      id?: string;
      index?: number;
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string | Record<string, unknown>;
}

interface ActiveTool {
  id: string;
  name: string;
  index: number;
  args: string;
}

export async function* parseOllamaStream(
  response: Response,
  context: { id: string; model: string },
): AsyncGenerator<StreamEvent> {
  yield { type: 'START', id: context.id, model: context.model };

  if (!response.body) {
    yield { type: 'END', stopReason: 'end_turn' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalInput = 0;
  let totalOutput = 0;
  const activeTools = new Map<number, ActiveTool>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let chunk: OllamaStreamChunk;
        try { chunk = JSON.parse(line) as OllamaStreamChunk; } catch { continue; }

        if (chunk.error) {
          const errMsg = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error);
          yield { type: 'ERROR', message: errMsg.slice(0, 500), status: 502 };
          yield { type: 'END', stopReason: 'error' };
          try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
          return;
        }

        const message = chunk.message ?? {};

        if (message.content) {
          yield { type: 'TOKEN', text: message.content };
        }

        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            const tcIndex = tc.index ?? activeTools.size;
            const fn = tc.function ?? {};
            const argsDelta = typeof fn.arguments === 'string'
              ? fn.arguments
              : (fn.arguments ? JSON.stringify(fn.arguments) : '');

            if (!activeTools.has(tcIndex)) {
              const callId = tc.id || makeId('call');
              activeTools.set(tcIndex, { id: callId, name: fn.name || '', index: tcIndex, args: argsDelta });
              yield { type: 'TOOL_CALL_START', id: callId, name: fn.name || '', index: tcIndex };
              if (argsDelta) {
                yield { type: 'TOOL_CALL_DELTA', id: callId, index: tcIndex, argumentsDelta: argsDelta };
              }
            } else if (argsDelta) {
              const active = activeTools.get(tcIndex)!;
              active.args += argsDelta;
              yield { type: 'TOOL_CALL_DELTA', id: active.id, index: tcIndex, argumentsDelta: argsDelta };
            }
          }
        }

        if (chunk.done) {
          totalInput = chunk.prompt_eval_count ?? totalInput;
          totalOutput = chunk.eval_count ?? totalOutput;
        }
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  for (const [, active] of activeTools) {
    yield { type: 'TOOL_CALL_END', id: active.id, index: active.index, arguments: active.args };
  }

  if (totalInput || totalOutput) {
    yield { type: 'USAGE', inputTokens: totalInput, outputTokens: totalOutput };
  }
  yield { type: 'END', stopReason: activeTools.size > 0 ? 'tool_use' : 'end_turn' };
}
