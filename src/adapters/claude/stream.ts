/**
 * StreamEvent → Anthropic Messages SSE 字符串流
 *
 * 参考 Anthropic 官方 SSE 顺序:
 *   message_start
 *   content_block_start (index=0, thinking) - 如需
 *   content_block_delta (thinking_delta)
 *   content_block_delta (signature_delta)
 *   content_block_stop
 *   content_block_start (index=1, text)
 *   content_block_delta (text_delta)
 *   content_block_stop
 *   content_block_start (index=2, tool_use)
 *   content_block_delta (input_json_delta)
 *   content_block_stop
 *   message_delta (stop_reason, usage)
 *   message_stop
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import type { AdapterContext } from '../../types/adapter.js';
import { sseEvent } from '../../http/sse.js';
import { ICON } from '../../logging/icons.js';
import { isShellTool } from '../../utils/tool-summary.js';

interface ToolBlockState {
  id: string;
  name: string;
  index: number;
  blockIndex: number;
}

export async function* serializeClaudeStream(
  stream: AsyncIterable<StreamEvent>,
  context: AdapterContext,
): AsyncIterable<string> {
  const msgId = context.id;
  let model = '';
  let currentBlockType: 'thinking' | 'text' | null = null;
  let currentBlockIndex = 0;
  let nextBlockIndex = 0;
  const toolBlocks = new Map<number, ToolBlockState>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' = 'end_turn';
  let stopDetails: { type: 'refusal'; category?: string | null; explanation?: string } | null = null;
  let eventCount = 0;
  const t0 = Date.now();
  console.log(`${ICON.streamStart} [vv-switch] [claude-serialize] open | msgId=${msgId}`);

  function* closeCurrentBlock(): Generator<string> {
    if (currentBlockType !== null) {
      yield sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: currentBlockIndex,
      });
      currentBlockType = null;
    }
  }

  function* openTextBlock(): Generator<string> {
    if (currentBlockType === 'text') return;
    yield* closeCurrentBlock();
    currentBlockIndex = nextBlockIndex++;
    currentBlockType = 'text';
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  function* openThinkingBlock(): Generator<string> {
    if (currentBlockType === 'thinking') return;
    yield* closeCurrentBlock();
    currentBlockIndex = nextBlockIndex++;
    currentBlockType = 'thinking';
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: currentBlockIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
  }

  for await (const event of stream) {
    eventCount++;
    if (eventCount <= 3 || eventCount % 50 === 0) {
      console.log(`${ICON.streamChunk} [vv-switch] [claude-serialize] event #${eventCount} | type=${event.type}`);
    }
    switch (event.type) {
      case 'START':
        model = event.model;
        yield sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: null,
            stop_sequence: null,
          },
        });
        // 不预先开 text block,等第一个 TOKEN/THINKING 再开
        break;

      case 'TOKEN':
        yield* openTextBlock();
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'text_delta', text: event.text },
        });
        break;

      case 'THINKING':
        yield* openThinkingBlock();
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: currentBlockIndex,
          delta: { type: 'thinking_delta', thinking: event.text },
        });
        break;

      case 'THINKING_SIGNATURE':
        // signature 属于当前 thinking block(必须尚未 stop)
        if (currentBlockType === 'thinking') {
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'signature_delta', signature: event.signature },
          });
        }
        break;

      case 'TOOL_CALL_START': {
        yield* closeCurrentBlock();
        const blockIndex = nextBlockIndex++;
        toolBlocks.set(event.index, {
          id: event.id,
          name: event.name,
          index: event.index,
          blockIndex,
        });
        const shellTag = isShellTool(event.name) ? ' [💻 shell]' : '';
        console.log(`${ICON.toolStart} [vv-switch] [claude-serialize] tool_use start | name=${event.name}${shellTag} | id=${event.id}`);
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
        });
        break;
      }

      case 'TOOL_CALL_DELTA': {
        const block = toolBlocks.get(event.index);
        if (block) {
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: event.argumentsDelta },
          });
        }
        break;
      }

      case 'TOOL_CALL_END': {
        const block = toolBlocks.get(event.index);
        if (block) {
          console.log(`${ICON.toolEnd}   [vv-switch] [claude-serialize] tool_use end   | name=${block.name} | id=${block.id}`);
          yield sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: block.blockIndex,
          });
          toolBlocks.delete(event.index);
          stopReason = 'tool_use';
        }
        break;
      }

      case 'USAGE':
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        if (event.cacheCreationInputTokens != null) cacheCreationInputTokens = event.cacheCreationInputTokens;
        if (event.cacheReadInputTokens != null) cacheReadInputTokens = event.cacheReadInputTokens;
        // OpenAI-compatible 上游只暴露 cached_tokens(=已命中的缓存输入),语义等同于 Anthropic 的 cache_read_input_tokens
        // 若上游未提供 Anthropic 专属字段,则用 OpenAI 的 cachedInputTokens 兜底,让 Claude Code 能感知缓存命中
        if (cacheReadInputTokens == null && event.cachedInputTokens != null) {
          cacheReadInputTokens = event.cachedInputTokens;
        }
        break;

      case 'ERROR': {
        console.error(`${ICON.error} [vv-switch] [claude-stream] UPSTREAM ERROR | model=%s | code=%s | message=%s`, model, event.code || 'unknown', event.message);
        yield* closeCurrentBlock();
        for (const [, block] of toolBlocks) {
          yield sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: block.blockIndex,
          });
        }
        toolBlocks.clear();

        // 使用 error 事件类型,而不是虚构 end_turn
        yield sseEvent('error', {
          type: 'error',
          error: {
            type: event.code || 'api_error',
            message: event.message,
          },
        });
        yield sseEvent('message_stop', { type: 'message_stop' });
        console.log(`${ICON.error} [vv-switch] [claude-serialize] done (ERROR) | events=${eventCount} | duration=${Date.now() - t0}ms`);
        return;
      }

      case 'END': {
        yield* closeCurrentBlock();
        for (const [, block] of toolBlocks) {
          yield sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: block.blockIndex,
          });
        }
        toolBlocks.clear();

        if (event.stopReason && event.stopReason !== 'error') {
          // 防止上游错误的 'end_turn' 覆盖已从 TOOL_CALL_END 设置的 'tool_use'
          // 优先级: tool_use > 其他非 end_turn > end_turn
          if (stopReason !== 'tool_use' || event.stopReason !== 'end_turn') {
            stopReason = event.stopReason;
          }
        }
        if (event.stopDetails) {
          stopDetails = event.stopDetails;
        }

        const messageDelta: Record<string, unknown> = {
          stop_reason: stopReason,
          stop_sequence: null,
        };
        if (stopReason === 'refusal' && stopDetails) {
          messageDelta.stop_details = stopDetails;
        }

        const usage: Record<string, unknown> = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        };
        if (cacheCreationInputTokens != null) usage.cache_creation_input_tokens = cacheCreationInputTokens;
        if (cacheReadInputTokens != null) usage.cache_read_input_tokens = cacheReadInputTokens;

        yield sseEvent('message_delta', {
          type: 'message_delta',
          delta: messageDelta,
          usage,
        });
        yield sseEvent('message_stop', { type: 'message_stop' });
        console.log(`${ICON.streamDone} [vv-switch] [claude-serialize] done | events=${eventCount} | stop=${stopReason} | duration=${Date.now() - t0}ms`);
        return;
      }
    }
  }
  console.log(`${ICON.streamDone} [vv-switch] [claude-serialize] done (exhausted) | events=${eventCount} | duration=${Date.now() - t0}ms`);
}
