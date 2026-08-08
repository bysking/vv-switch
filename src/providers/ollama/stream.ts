/**
 * Ollama 流式响应 → StreamEvent 序列
 *
 * Ollama 流式返回 NDJSON（每行一个 JSON）
 *
 * 关键差异（与 OpenAI chat/completions 不同，基于 ollama 0.30.6 实测）：
 * 1. tool_calls 的 index 位于 **function 内部**（`function.index`），而非顶层 `tc.index`。
 * 2. 同一个 chunk 可能一次性给出多个 tool_call，且它们的 `function.index`
 *    **全部为 0**（minimax-m3:cloud 实测），因此 index 不能作为工具唯一标识，
 *    必须优先用 `id` 区分。
 * 3. arguments 可能是 **对象**（一次性完整给出，非增量）或 **字符串**（增量分片）。
 *    对象必须整体替换，只有字符串才能拼接，否则会拼出坏 JSON。
 * 4. 增量续传的 chunk 不带 `id`，只能靠 index 回查已有工具。
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import { makeId } from '../../utils/id.js';

interface OllamaToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: unknown; index?: number };
}

interface OllamaStreamChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<OllamaToolCall>;
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
  /** 对外发出的唯一序号（Ollama 的 index 可能重复，不能直接透传） */
  emitIndex: number;
  args: string;
  /** args 是否由「对象型 arguments」整体给出（后续分片需替换而非拼接） */
  argsFromObject: boolean;
}

/**
 * Ollama done_reason → 内部 END stopReason。
 * 'length' 必须映射为 max_tokens：否则出口（Codex Responses）会把被截断的输出
 * 当成助手正常结束，导致 agent 循环中断、需用户手动「继续」。
 */
function mapOllamaDoneReason(
  reason: string | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
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
  let finalDoneReason: string | undefined;

  // 同时按 id 和 Ollama 原始 index 索引：id 用于区分（可能同 index 的）多个工具，
  // 原始 index 用于给不带 id 的增量续传 chunk 回查归属。
  const toolsById = new Map<string, ActiveTool>();
  const toolsByRawIndex = new Map<number, ActiveTool>();
  const ordered: ActiveTool[] = [];
  let nextEmitIndex = 0;

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

        // Ollama 把思考内容放在 message.thinking（think:true 时），此前被整体丢弃
        if (message.thinking) {
          yield { type: 'THINKING', text: message.thinking };
        }

        if (message.content) {
          yield { type: 'TOKEN', text: message.content };
        }

        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            const fn = tc.function ?? {};
            // index 优先取 function.index（Ollama 的真实位置），回退到顶层 tc.index
            const rawIndex = fn.index ?? tc.index;
            const argsIsObject = fn.arguments != null && typeof fn.arguments === 'object';
            const argsChunk = typeof fn.arguments === 'string'
              ? fn.arguments
              : (fn.arguments != null ? JSON.stringify(fn.arguments) : '');

            // 归属判定：先按 id，再按原始 index（不带 id 的增量续传）
            let tool: ActiveTool | undefined;
            if (tc.id && toolsById.has(tc.id)) {
              tool = toolsById.get(tc.id);
            } else if (!tc.id && rawIndex != null) {
              tool = toolsByRawIndex.get(rawIndex);
            }

            if (!tool) {
              // 新工具：分配对外唯一 emitIndex（不能复用 Ollama 可能重复的 index）
              const callId = tc.id || makeId('call');
              tool = {
                id: callId,
                name: fn.name || '',
                emitIndex: nextEmitIndex++,
                args: '',
                argsFromObject: false,
              };
              toolsById.set(callId, tool);
              // 仅在该 index 尚未占用时登记，保证增量续传回查到首个该 index 的工具
              if (rawIndex != null && !toolsByRawIndex.has(rawIndex)) {
                toolsByRawIndex.set(rawIndex, tool);
              }
              ordered.push(tool);
              yield { type: 'TOOL_CALL_START', id: tool.id, name: tool.name, index: tool.emitIndex };
            } else if (fn.name && !tool.name) {
              // 名称可能在后续 chunk 才补全
              tool.name = fn.name;
            }

            if (argsChunk) {
              if (argsIsObject) {
                // 对象型 arguments 是完整值：整体替换，不能拼接
                const isReplacement = tool.args.length > 0;
                tool.args = argsChunk;
                tool.argsFromObject = true;
                // 首次给出才发 delta；替换场景由 TOOL_CALL_END 的 arguments 兜底
                if (!isReplacement) {
                  yield {
                    type: 'TOOL_CALL_DELTA',
                    id: tool.id,
                    index: tool.emitIndex,
                    argumentsDelta: argsChunk,
                  };
                }
              } else if (tool.argsFromObject) {
                // 已有完整对象值后又来字符串分片：忽略，避免污染出坏 JSON
                continue;
              } else {
                tool.args += argsChunk;
                yield {
                  type: 'TOOL_CALL_DELTA',
                  id: tool.id,
                  index: tool.emitIndex,
                  argumentsDelta: argsChunk,
                };
              }
            }
          }
        }

        if (chunk.done) {
          totalInput = chunk.prompt_eval_count ?? totalInput;
          totalOutput = chunk.eval_count ?? totalOutput;
          finalDoneReason = chunk.done_reason ?? finalDoneReason;
        }
      }
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  for (const tool of ordered) {
    yield { type: 'TOOL_CALL_END', id: tool.id, index: tool.emitIndex, arguments: tool.args };
  }

  if (totalInput || totalOutput) {
    yield {
      type: 'USAGE',
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
    };
  }

  // 有工具调用 → tool_use；否则还原上游真实结束原因（含 length 截断）
  yield {
    type: 'END',
    stopReason: ordered.length > 0 ? 'tool_use' : mapOllamaDoneReason(finalDoneReason),
  };
}
