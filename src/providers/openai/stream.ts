/**
 * OpenAI Responses API SSE → StreamEvent 序列
 *
 * 响应事件类型：
 * - response.created / response.in_progress
 * - response.output_item.added/done
 * - response.output_text.delta
 * - response.function_call_arguments.delta/done
 * - response.reasoning_text.delta
 * - response.completed
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import { makeId } from '../../utils/id.js';

interface ResponsesStreamData {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

interface ActiveTool {
  id: string;
  name: string;
  index: number;
  args: string;
}

export async function* parseResponsesStream(
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
  let completedStatus: string | undefined;
  let completedIncompleteReason: string | undefined;
  const activeTools = new Map<string, ActiveTool>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        let data: ResponsesStreamData;
        try { data = JSON.parse(dataStr) as ResponsesStreamData; } catch { continue; }

        switch (data.type) {
          case 'response.output_text.delta':
            if (data.delta) yield { type: 'TOKEN', text: data.delta };
            break;
          case 'response.reasoning_text.delta':
            if (data.delta) yield { type: 'THINKING', text: data.delta };
            break;
          case 'response.output_item.added':
            if (data.item?.type === 'function_call' && data.item.id) {
              const toolId = data.item.id;
              activeTools.set(toolId, {
                id: toolId,
                name: data.item.name || '',
                index: data.output_index ?? activeTools.size,
                args: data.item.arguments || '',
              });
              yield {
                type: 'TOOL_CALL_START',
                id: toolId,
                name: data.item.name || '',
                index: data.output_index ?? 0,
              };
              if (data.item.arguments) {
                yield {
                  type: 'TOOL_CALL_DELTA',
                  id: toolId,
                  index: data.output_index ?? 0,
                  argumentsDelta: data.item.arguments,
                };
              }
            }
            break;
          case 'response.function_call_arguments.delta': {
            const toolId = data.item_id || '';
            const tool = activeTools.get(toolId);
            if (tool && data.delta) {
              tool.args += data.delta;
              yield { type: 'TOOL_CALL_DELTA', id: toolId, index: tool.index, argumentsDelta: data.delta };
            }
            break;
          }
          case 'response.function_call_arguments.done': {
            const toolId = data.item_id || '';
            const tool = activeTools.get(toolId);
            if (tool) {
              const finalArgs = data.arguments ?? tool.args;
              yield { type: 'TOOL_CALL_END', id: toolId, index: tool.index, arguments: finalArgs };
              activeTools.delete(toolId);
            }
            break;
          }
          case 'response.completed':
            if (data.response?.usage) {
              totalInput = data.response.usage.input_tokens ?? 0;
              totalOutput = data.response.usage.output_tokens ?? 0;
            }
            completedStatus = data.response?.status;
            completedIncompleteReason = data.response?.incomplete_details?.reason;
            break;
        }
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  for (const [, tool] of activeTools) {
    yield { type: 'TOOL_CALL_END', id: tool.id, index: tool.index, arguments: tool.args };
  }

  if (totalInput || totalOutput) {
    yield { type: 'USAGE', inputTokens: totalInput, outputTokens: totalOutput };
  }

  const streamStopReason = completedStatus === 'incomplete' && completedIncompleteReason === 'max_tokens'
    ? 'max_tokens'
    : activeTools.size > 0
      ? 'tool_use'
      : 'end_turn';
  yield { type: 'END', stopReason: streamStopReason };
}
