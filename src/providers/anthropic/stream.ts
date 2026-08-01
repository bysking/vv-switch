/**
 * Anthropic Messages SSE → StreamEvent 序列
 *
 * Anthropic 的 SSE 格式:
 * event: message_start
 * data: {...}
 *
 * event: content_block_start
 * data: {"index":0, "content_block":{"type":"text",...}}
 *
 * event: content_block_delta
 * data: {"index":0, "delta":{"type":"text_delta","text":"..."}}
 *
 * event: content_block_stop
 * data: {"index":0}
 *
 * event: message_delta
 * data: {"delta":{"stop_reason":"end_turn","stop_details":...}, "usage":{...}}
 *
 * event: message_stop
 * data: {}
 */

import type { StreamEvent } from '../../protocol/stream-events.js';

interface AnthropicStreamData {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
    stop_details?: {
      type?: string;
      category?: string | null;
      explanation?: string;
    } | null;
    thinking?: string;
    signature?: string;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  error?: { type?: string; message?: string };
}

interface BlockState {
  type: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking';
  id?: string;
  name?: string;
  args: string;
}

type StreamStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'error';

function mapStopReason(reason: string | undefined): StreamStopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    case 'tool_use': return 'tool_use';
    case 'pause_turn': return 'pause_turn';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

export async function* parseAnthropicStream(
  response: Response,
  context: { id: string; model: string },
): AsyncGenerator<StreamEvent> {
  yield { type: 'START', id: context.id, model: context.model };

  if (!response.body) {
    console.log(`[vv-switch] [anthropic-stream] WARN: response.body is null, ending stream`);
    yield { type: 'END', stopReason: 'end_turn' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalInput = 0;
  let totalOutput = 0;
  let cacheCreation: number | undefined;
  let cacheRead: number | undefined;
  let finalStopReason: StreamStopReason = 'end_turn';
  let finalStopDetails: { type: 'refusal'; category?: string | null; explanation?: string } | null = null;
  let chunkCount = 0;
  let lineCount = 0;
  let dataLineCount = 0;
  let lastEventType = '';
  const t0 = Date.now();
  const blocks = new Map<number, BlockState>();
  console.log(`[vv-switch] [anthropic-stream] START reading SSE stream`);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`[vv-switch] [anthropic-stream] Stream reader done | chunks=${chunkCount} | dataLines=${dataLineCount} | duration=${Date.now() - t0}ms | lastEvent=${lastEventType}`);
        break;
      }

      chunkCount++;
      const rawText = decoder.decode(value, { stream: true });
      if (chunkCount <= 3) {
        console.log(`[vv-switch] [anthropic-stream] chunk #${chunkCount} | len=${rawText.length} | preview=${rawText.slice(0, 100).replace(/\n/g, '\\n')}`);
      }

      buffer += rawText;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        lineCount++;
        if (line.startsWith('event:')) {
          lastEventType = line.slice(6).trim();
          continue;
        }
        let dataStr: string | null = null;
        if (line.startsWith('data: ')) {
          dataStr = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataStr = line.slice(5).trim();
        }
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
          console.log(`[vv-switch] [anthropic-stream] Received [DONE] sentinel`);
          continue;
        }
        dataLineCount++;

        let data: AnthropicStreamData;
        try { data = JSON.parse(dataStr) as AnthropicStreamData; } catch (e) {
          console.log(`[vv-switch] [anthropic-stream] WARN: JSON parse failed | data=${dataStr.slice(0, 100)} | error=${e instanceof Error ? e.message : String(e)}`);
          continue;
        }

        if (data.type === 'message_start') {
          const u = data.message?.usage;
          totalInput = u?.input_tokens ?? 0;
          if (u?.cache_creation_input_tokens != null) cacheCreation = u.cache_creation_input_tokens;
          if (u?.cache_read_input_tokens != null) cacheRead = u.cache_read_input_tokens;
          console.log(`[vv-switch] [anthropic-stream] message_start | inputTokens=${totalInput} | cacheRead=${cacheRead ?? 0} | cacheCreation=${cacheCreation ?? 0} | model=${data.message?.model ?? 'N/A'}`);
        } else if (data.type === 'content_block_start') {
          const idx = data.index ?? 0;
          const cb = data.content_block ?? {};
          if (cb.type === 'tool_use') {
            blocks.set(idx, { type: 'tool_use', id: cb.id, name: cb.name, args: '' });
            yield { type: 'TOOL_CALL_START', id: cb.id || '', name: cb.name || '', index: idx };
          } else if (cb.type === 'thinking') {
            blocks.set(idx, { type: 'thinking', args: '' });
            // 若初始 thinking block 已有内容,立即透传
            if (cb.thinking) {
              yield { type: 'THINKING', text: cb.thinking };
            }
          } else if (cb.type === 'redacted_thinking') {
            blocks.set(idx, { type: 'redacted_thinking', args: '' });
            // redacted_thinking 内容位于 content_block.data,不在 delta 中
            // 目前 StreamEvent 未提供专属事件,交由 response.ts 处理非流式;此处忽略即可
          } else {
            blocks.set(idx, { type: 'text', args: '' });
          }
        } else if (data.type === 'content_block_delta') {
          const idx = data.index ?? 0;
          const block = blocks.get(idx);
          const delta = data.delta ?? {};
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'TOKEN', text: delta.text };
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'THINKING', text: delta.thinking };
          } else if (delta.type === 'signature_delta' && delta.signature) {
            yield { type: 'THINKING_SIGNATURE', signature: delta.signature };
          } else if (delta.type === 'input_json_delta' && delta.partial_json && block?.type === 'tool_use') {
            block.args += delta.partial_json;
            yield {
              type: 'TOOL_CALL_DELTA',
              id: block.id || '',
              index: idx,
              argumentsDelta: delta.partial_json,
            };
          }
        } else if (data.type === 'content_block_stop') {
          const idx = data.index ?? 0;
          const block = blocks.get(idx);
          if (block?.type === 'tool_use') {
            yield {
              type: 'TOOL_CALL_END',
              id: block.id || '',
              index: idx,
              arguments: block.args,
            };
          }
        } else if (data.type === 'message_delta') {
          if (data.usage?.output_tokens != null) {
            totalOutput = data.usage.output_tokens;
          }
          if (data.usage?.cache_creation_input_tokens != null) {
            cacheCreation = data.usage.cache_creation_input_tokens;
          }
          if (data.usage?.cache_read_input_tokens != null) {
            cacheRead = data.usage.cache_read_input_tokens;
          }
          if (data.delta?.stop_reason) {
            finalStopReason = mapStopReason(data.delta.stop_reason);
          }
          if (data.delta?.stop_details) {
            const sd = data.delta.stop_details;
            if (sd.type === 'refusal') {
              finalStopDetails = {
                type: 'refusal',
                category: sd.category ?? null,
                explanation: sd.explanation,
              };
            }
          }
        } else if (data.type === 'error') {
          console.error(`[vv-switch] [anthropic-stream] UPSTREAM ERROR event: ${JSON.stringify(data).slice(0, 300)}`);
          const errType = data.error?.type || 'api_error';
          const errMsg = data.error?.message || JSON.stringify(data);
          const status = errType === 'overload_error' ? 529 : 500;
          yield { type: 'ERROR', message: errMsg, code: errType, status };
        }
      }
    }
  } catch (err) {
    console.error(`[vv-switch] [anthropic-stream] READ_ERROR | chunks=${chunkCount} | dataLines=${dataLineCount} | duration=${Date.now() - t0}ms | error=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }

  if (totalInput || totalOutput || cacheCreation != null || cacheRead != null) {
    const usage: StreamEvent = {
      type: 'USAGE',
      inputTokens: totalInput,
      outputTokens: totalOutput,
    };
    if (cacheCreation != null) usage.cacheCreationInputTokens = cacheCreation;
    if (cacheRead != null) usage.cacheReadInputTokens = cacheRead;
    yield usage;
  }
  yield {
    type: 'END',
    stopReason: finalStopReason,
    stopDetails: finalStopDetails,
  };
}
