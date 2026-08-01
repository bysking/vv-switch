/**
 * Chat Completions SSE → StreamEvent 序列
 */

import type { StreamEvent } from '../../protocol/stream-events.js';

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
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

interface ActiveToolCall {
  id: string;
  name: string;
  index: number;
  args: string;
}

/**
 * 上游 chat/completions 的 finish_reason → 内部 END stopReason。
 * 关键：'length'(max_tokens 截断) 必须映射为 'max_tokens'，否则出口无法向上游客户端
 * （如 Codex Responses）上报“被截断”，会被误判为正常结束而中断 agent 循环。
 */
function mapChatFinishReason(
  finish: string | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  switch (finish) {
    case 'length': return 'max_tokens';
    case 'content_filter': return 'stop_sequence';
    default: return 'end_turn';
  }
}

export async function* parseChatStream(
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
  let cachedInput = 0;
  let reasoningOutput = 0;

  const activeTools = new Map<number, ActiveToolCall>();
  // 跟踪是否已发送过 TOOL_CALL_END(用于最终 stopReason 判断)
  // 原因: finish_reason='tool_calls' 时先发送 TOOL_CALL_END 再 clear activeTools,
  // 不能依赖 activeTools.size 判断最终 stopReason
  let emittedToolCalls = false;
  // 记录上游最后一个非空 finish_reason，用于在无工具调用时还原真实结束原因
  let finalFinish: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // 兼容 "data: {...}" 和 "data:{...}" 两种 SSE 格式
        let dataStr: string | null = null;
        if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataStr = line.slice(5).trim();
        }
        if (!dataStr) continue;
        if (dataStr === '[DONE]') continue;

        let chunk: ChatCompletionStreamChunk;
        try {
          chunk = JSON.parse(dataStr) as ChatCompletionStreamChunk;
        } catch {
          continue;
        }

        const choices = chunk.choices ?? [];
        if (choices.length === 0) {
          if (chunk.usage) {
            totalInput = chunk.usage.prompt_tokens ?? totalInput;
            totalOutput = chunk.usage.completion_tokens ?? totalOutput;
            totalTokens = chunk.usage.total_tokens ?? totalTokens;
            cachedInput = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedInput;
            reasoningOutput = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningOutput;
          }
          continue;
        }

        const delta = choices[0].delta ?? {};
        const finish = choices[0].finish_reason;
        if (finish) finalFinish = finish;

        if (delta.reasoning_content) {
          yield { type: 'THINKING', text: delta.reasoning_content };
        }

        if (delta.content) {
          yield { type: 'TOKEN', text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? 0;
            const fn = tc.function ?? {};
            const argsDelta = typeof fn.arguments === 'string'
              ? fn.arguments
              : (fn.arguments ? JSON.stringify(fn.arguments) : '');

            if (tc.id && !activeTools.has(tcIndex)) {
              const callId = tc.id;
              activeTools.set(tcIndex, {
                id: callId,
                name: fn.name || '',
                index: tcIndex,
                args: '',
              });
              yield { type: 'TOOL_CALL_START', id: callId, name: fn.name || '', index: tcIndex };

              if (argsDelta) {
                const active = activeTools.get(tcIndex)!;
                active.args += argsDelta;
                yield { type: 'TOOL_CALL_DELTA', id: callId, index: tcIndex, argumentsDelta: argsDelta };
              }
            } else if (activeTools.has(tcIndex) && argsDelta) {
              const active = activeTools.get(tcIndex)!;
              active.args += argsDelta;
              yield { type: 'TOOL_CALL_DELTA', id: active.id, index: tcIndex, argumentsDelta: argsDelta };
            }
          }
        }

        if (finish === 'tool_calls') {
          for (const [, active] of activeTools) {
            yield { type: 'TOOL_CALL_END', id: active.id, index: active.index, arguments: active.args };
          }
          emittedToolCalls = emittedToolCalls || activeTools.size > 0;
          activeTools.clear();
        }

        if (chunk.usage) {
          totalInput = chunk.usage.prompt_tokens ?? totalInput;
          totalOutput = chunk.usage.completion_tokens ?? totalOutput;
          totalTokens = chunk.usage.total_tokens ?? totalTokens;
          cachedInput = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedInput;
          reasoningOutput = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningOutput;
        }
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  // 兜底关闭未完成的 tool calls
  if (activeTools.size > 0) {
    emittedToolCalls = true;
  }
  for (const [, active] of activeTools) {
    yield { type: 'TOOL_CALL_END', id: active.id, index: active.index, arguments: active.args };
  }

  if (totalInput || totalOutput) {
    yield {
      type: 'USAGE',
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalTokens || totalInput + totalOutput,
      cachedInputTokens: cachedInput,
      reasoningOutputTokens: reasoningOutput,
    };
  }

  yield { type: 'END', stopReason: emittedToolCalls ? 'tool_use' : mapChatFinishReason(finalFinish) };
}
