/**
 * StreamEvent → OpenAI Chat Completions SSE 字符串流（chat.completion.chunk）
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import type { AdapterContext } from '../../types/adapter.js';
import { sseData } from '../../http/sse.js';
import { ICON } from '../../logging/icons.js';
import { toChatFinishReason } from '../shared/stop-reason.js';

export async function* serializeOpenAIStream(
  stream: AsyncIterable<StreamEvent>,
  context: AdapterContext,
): AsyncIterable<string> {
  const id = context.id;
  const created = Math.floor(Date.now() / 1000);
  let model = context.defaultModel || '';
  let roleSent = false;
  let totalInput = 0;
  let totalOutput = 0;
  let sawToolCall = false;
  // chat/completions 流里 tool_calls 用数组下标（index）标识；映射内部 index → chat index
  const toolIndexMap = new Map<number, number>();
  let nextToolIndex = 0;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

  for await (const event of stream) {
    switch (event.type) {
      case 'START':
        model = event.model || model;
        // 首个 chunk 带 role
        yield chunk({ role: 'assistant', content: '' });
        roleSent = true;
        break;

      case 'TOKEN':
        if (!roleSent) { yield chunk({ role: 'assistant', content: '' }); roleSent = true; }
        yield chunk({ content: event.text });
        break;

      case 'THINKING':
        if (!roleSent) { yield chunk({ role: 'assistant', content: '' }); roleSent = true; }
        // 以 reasoning_content 增量透传（DeepSeek/OpenAI 兼容端惯例）
        yield chunk({ reasoning_content: event.text });
        break;

      case 'THINKING_SIGNATURE':
        // OpenAI 客户端无 signature 概念,静默丢弃
        break;

      case 'TOOL_CALL_START': {
        sawToolCall = true;
        if (!roleSent) { yield chunk({ role: 'assistant', content: '' }); roleSent = true; }
        const chatIndex = nextToolIndex++;
        toolIndexMap.set(event.index, chatIndex);
        console.log(`${ICON.toolStart} [vv-switch] [openai-serialize] tool_use start | name=${event.name} | id=${event.id}`);
        yield chunk({
          tool_calls: [{
            index: chatIndex,
            id: event.id,
            type: 'function',
            function: { name: event.name, arguments: '' },
          }],
        });
        break;
      }

      case 'TOOL_CALL_DELTA': {
        const chatIndex = toolIndexMap.get(event.index) ?? 0;
        yield chunk({
          tool_calls: [{
            index: chatIndex,
            function: { arguments: event.argumentsDelta },
          }],
        });
        break;
      }

      case 'TOOL_CALL_END':
        console.log(`${ICON.toolEnd}   [vv-switch] [openai-serialize] tool_use end   | id=${event.id}`);
        // chat/completions 流不需要显式 end 事件，参数已通过 delta 累积
        break;

      case 'USAGE':
        totalInput = event.inputTokens;
        totalOutput = event.outputTokens;
        break;

      case 'ERROR':
        console.error(`${ICON.error} [vv-switch] [openai-stream] UPSTREAM ERROR | model=%s | code=%s | message=%s`, model, event.code || 'unknown', event.message);
        yield sseData({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: toChatFinishReason('error', false) }],
          error: { code: event.code || 'upstream_error', message: event.message },
        });
        yield 'data: [DONE]\n\n';
        return;

      case 'END': {
        const finishReason = toChatFinishReason(event.stopReason, sawToolCall);
        yield chunk({}, finishReason);
        // usage（OpenAI stream_options.include_usage 惯例，附带一个空 choices 的 usage chunk）
        yield sseData({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: totalInput,
            completion_tokens: totalOutput,
            total_tokens: totalInput + totalOutput,
          },
        });
        yield 'data: [DONE]\n\n';
        return;
      }
    }
  }

  // 流意外结束兜底
  if (!roleSent) yield chunk({ role: 'assistant', content: '' });
  yield chunk({}, 'stop');
  yield 'data: [DONE]\n\n';
}
