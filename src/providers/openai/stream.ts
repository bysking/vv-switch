/**
 * OpenAI Responses API SSE → StreamEvent 序列
 *
 * 响应事件类型（已处理）：
 * - response.created / response.in_progress
 * - response.output_item.added / response.output_item.done
 * - response.content_part.added / response.content_part.done
 * - response.output_text.delta
 * - response.refusal.delta / response.refusal.done
 * - response.function_call_arguments.delta / response.function_call_arguments.done
 * - response.reasoning_text.delta
 * - response.completed / response.incomplete / response.failed
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import { makeId } from '../../utils/id.js';

interface ResponsesStreamData {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  arguments?: string;
  refusal?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    error?: { code?: string; message?: string };
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
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
  let totalTokens = 0;
  let cachedInputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;
  let completedStatus: string | undefined;
  let completedIncompleteReason: string | undefined;
  let completedErrorMessage: string | undefined;
  let completedErrorCode: string | undefined;
  let upstreamResponseId: string | undefined;
  // 累积 refusal 文本，终态放入 stopDetails
  let refusalText = '';
  let hasRefusal = false;
  let hasAnyToolCalls = false;
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

          case 'response.refusal.delta':
            if (data.delta) {
              hasRefusal = true;
              refusalText += data.delta;
            }
            break;
          case 'response.refusal.done':
            hasRefusal = true;
            if (data.refusal) refusalText = data.refusal;
            break;

          case 'response.output_item.added':
            if (data.item?.type === 'function_call') {
              // function_call 的主键是 call_id；id 是 item 在 output 列表中的标识。
              // 两者通常值相同，但以 call_id 为准（与官方 ResponseFunctionToolCall 对齐）。
              const toolId = data.item.call_id || data.item.id || '';
              if (!toolId) break;
              hasAnyToolCalls = true;
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
            // reasoning / message / 其他内建工具类型的 output_item.added 暂不单独产出事件，
            // 因为内部统一协议里没有对应粒度；文本和思考分别走 TOKEN / THINKING 事件。
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
          case 'response.incomplete':
          case 'response.failed':
            if (data.response?.id) {
              upstreamResponseId = data.response.id;
            }
            if (data.response?.usage) {
              totalInput = data.response.usage.input_tokens ?? 0;
              totalOutput = data.response.usage.output_tokens ?? 0;
              totalTokens = data.response.usage.total_tokens ?? 0;
              cachedInputTokens = data.response.usage.input_tokens_details?.cached_tokens;
              reasoningOutputTokens = data.response.usage.output_tokens_details?.reasoning_tokens;
            }
            completedStatus = data.response?.status;
            completedIncompleteReason = data.response?.incomplete_details?.reason;
            if (data.type === 'response.failed') {
              completedErrorMessage = data.response?.error?.message;
              completedErrorCode = data.response?.error?.code;
            }
            break;
        }
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  // 未正常关闭的活跃工具，补 END 事件
  for (const [, tool] of activeTools) {
    yield { type: 'TOOL_CALL_END', id: tool.id, index: tool.index, arguments: tool.args };
  }

  // usage 事件：只在有 token 数据时发送
  if (totalInput || totalOutput || totalTokens || cachedInputTokens != null || reasoningOutputTokens != null) {
    const usageEvt: StreamEvent = {
      type: 'USAGE',
      inputTokens: totalInput,
      outputTokens: totalOutput,
    };
    if (totalTokens) usageEvt.totalTokens = totalTokens;
    if (cachedInputTokens != null) usageEvt.cachedInputTokens = cachedInputTokens;
    if (reasoningOutputTokens != null) usageEvt.reasoningOutputTokens = reasoningOutputTokens;
    yield usageEvt;
  }

  // 终态判断
  // 1. 上游显式失败 → error
  if (completedStatus === 'failed') {
    yield {
      type: 'ERROR',
      message: completedErrorMessage || 'upstream response failed',
      code: completedErrorCode || 'upstream_failed',
    };
    yield {
      type: 'END',
      stopReason: 'error',
      ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
    };
    return;
  }

  // 2. refusal → refusal
  if (hasRefusal) {
    yield {
      type: 'END',
      stopReason: 'refusal',
      stopDetails: {
        type: 'refusal',
        explanation: refusalText || undefined,
      },
      ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
    };
    return;
  }

  // 3. 截断 → max_tokens / stop_sequence
  //    注意：官方 reason 枚举值是 'max_output_tokens' | 'content_filter'
  if (completedStatus === 'incomplete') {
    if (completedIncompleteReason === 'max_output_tokens') {
      yield {
        type: 'END',
        stopReason: 'max_tokens',
        ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
      };
      return;
    }
    if (completedIncompleteReason === 'content_filter') {
      yield {
        type: 'END',
        stopReason: 'stop_sequence',
        ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
      };
      return;
    }
  }

  // 4. 有工具调用（即使已正常结束）→ tool_use
  if (hasAnyToolCalls) {
    yield {
      type: 'END',
      stopReason: 'tool_use',
      ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
    };
    return;
  }

  // 5. 兜底：end_turn
  yield {
    type: 'END',
    stopReason: 'end_turn',
    ...(upstreamResponseId ? { upstreamId: upstreamResponseId } : {}),
  };
}
