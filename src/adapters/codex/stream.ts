/**
 * StreamEvent → OpenAI Responses API SSE 字符串流
 */

import type { StreamEvent } from '../../protocol/stream-events.js';
import type { AdapterContext } from '../../types/adapter.js';
import { sseData } from '../../http/sse.js';
import { makeId } from '../../utils/id.js';
import { ICON } from '../../logging/icons.js';
import { summarizeToolArgs, isShellTool } from '../../utils/tool-summary.js';
import { toResponsesTerminal } from '../shared/stop-reason.js';

interface ActiveTool {
  id: string;
  name: string;
  outputIndex: number;
  args: string;
}

export async function* serializeCodexStream(
  stream: AsyncIterable<StreamEvent>,
  context: AdapterContext,
): AsyncIterable<string> {
  const respId = context.id;
  const created = Math.floor(Date.now() / 1000);
  const msgId = makeId('msg');
  let model = '';
  let outputIndex = 0;
  let fullText = '';
  let msgOpen = false;
  let msgClosed = false;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCombined = 0;
  let cachedInput = 0;
  let reasoningOutput = 0;
  const tools = new Map<string, ActiveTool>();
  const toolsByIndex = new Map<number, ActiveTool>();
  const completedTools: Array<ActiveTool> = [];

  const baseResponse = () => ({
    id: respId,
    object: 'response',
    created_at: created,
    status: 'in_progress',
    model,
    output: [],
    usage: null,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: 'medium', summary: 'auto' },
    text: { format: { type: 'text' } },
    tools: [],
    truncation: 'disabled',
  });

  function* openMessage(): Generator<string> {
    if (msgOpen) return;
    msgOpen = true;
    yield sseData({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    });
    yield sseData({
      type: 'response.content_part.added',
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  function* closeMessage(): Generator<string> {
    if (!msgOpen || msgClosed) return;
    msgClosed = true;
    const part = { type: 'output_text', text: fullText, annotations: [] };
    yield sseData({
      type: 'response.content_part.done',
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    yield sseData({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [part],
      },
    });
    outputIndex += 1;
  }

  for await (const event of stream) {
    switch (event.type) {
      case 'START':
        model = event.model;
        yield sseData({ type: 'response.created', response: baseResponse() });
        yield sseData({ type: 'response.in_progress', response: baseResponse() });
        yield* openMessage();
        break;

      case 'TOKEN':
        if (!msgOpen) yield* openMessage();
        fullText += event.text;
        yield sseData({
          type: 'response.output_text.delta',
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          delta: event.text,
        });
        break;

      case 'THINKING':
        yield sseData({
          type: 'response.reasoning_text.delta',
          item_id: msgId,
          output_index: outputIndex,
          content_index: 0,
          delta: event.text,
        });
        break;

      case 'THINKING_SIGNATURE':
        // Codex/OpenAI Responses 无 signature 概念,静默丢弃
        break;

      case 'TOOL_CALL_START': {
        yield* closeMessage();
        const tool: ActiveTool = {
          id: event.id,
          name: event.name,
          outputIndex,
          args: '',
        };
        tools.set(event.id, tool);
        toolsByIndex.set(event.index, tool);
        const shellTag = isShellTool(event.name) ? ' [💻 shell]' : '';
        console.log(`${ICON.toolStart} [vv-switch] [codex-serialize] tool_use start | name=${event.name}${shellTag} | id=${event.id}`);
        yield sseData({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            id: event.id,
            type: 'function_call',
            call_id: event.id,
            name: event.name,
            arguments: '',
            status: 'in_progress',
          },
        });
        outputIndex += 1;
        break;
      }

      case 'TOOL_CALL_DELTA': {
        const tool = tools.get(event.id) || toolsByIndex.get(event.index);
        if (tool) {
          tool.args += event.argumentsDelta;
          yield sseData({
            type: 'response.function_call_arguments.delta',
            item_id: tool.id,
            output_index: tool.outputIndex,
            delta: event.argumentsDelta,
          });
        }
        break;
      }

      case 'TOOL_CALL_END': {
        const tool = tools.get(event.id) || toolsByIndex.get(event.index);
        if (tool) {
          const finalArgs = event.arguments || tool.args;
          const summary = summarizeToolArgs(tool.name, finalArgs);
          console.log(`${ICON.toolEnd}   [vv-switch] [codex-serialize] tool_use end   | name=${tool.name} | ${summary} | id=${tool.id}`);
          yield sseData({
            type: 'response.function_call_arguments.done',
            item_id: tool.id,
            output_index: tool.outputIndex,
            arguments: finalArgs,
          });
          yield sseData({
            type: 'response.output_item.done',
            output_index: tool.outputIndex,
            item: {
              id: tool.id,
              type: 'function_call',
              call_id: tool.id,
              name: tool.name,
              arguments: finalArgs,
              status: 'completed',
            },
          });
          tool.args = finalArgs;
          completedTools.push(tool);
          tools.delete(tool.id);
          toolsByIndex.delete(event.index);
        }
        break;
      }

      case 'USAGE':
        totalInput = event.inputTokens;
        totalOutput = event.outputTokens;
        totalCombined = event.totalTokens ?? event.inputTokens + event.outputTokens;
        // Anthropic 上游 → Codex 客户端:cache_read_input_tokens 语义等同于 OpenAI 的 cached_tokens
        cachedInput = event.cachedInputTokens ?? event.cacheReadInputTokens ?? 0;
        reasoningOutput = event.reasoningOutputTokens ?? 0;
        break;

      case 'ERROR':
        console.error(`${ICON.error} [vv-switch] [codex-stream] UPSTREAM ERROR | model=%s | code=%s | message=%s`, model, event.code || 'unknown', event.message);
        yield sseData({
          type: 'response.failed',
          response: {
            id: respId,
            object: 'response',
            created_at: created,
            status: 'failed',
            model,
            error: { code: event.code || 'upstream_error', message: event.message },
          },
        });
        yield 'data: [DONE]\n\n';
        return;

      case 'END': {
        yield* closeMessage();

        const outputItems: Array<Record<string, unknown>> = [];
        if (fullText) {
          outputItems.push({
            id: msgId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
          });
        }
        for (const tool of completedTools) {
          outputItems.push({
            id: tool.id,
            type: 'function_call',
            call_id: tool.id,
            name: tool.name,
            arguments: tool.args,
            status: 'completed',
          });
        }

        // 关键：按 stopReason 上报 response.status，不能再写死 'completed'。
        // 截断(max_tokens) 必须报 'incomplete' + incomplete_details.reason='max_output_tokens'，
        // 否则 Codex 会把“半截输出”当成助手主动结束，导致 agent 循环中断、需用户手动“继续”。
        const terminal = toResponsesTerminal(event.stopReason);
        const completedResponse: Record<string, unknown> = {
          id: respId,
          object: 'response',
          created_at: created,
          status: terminal.status,
          model,
          output: outputItems,
          usage: {
            input_tokens: totalInput,
            input_tokens_details: { cached_tokens: cachedInput },
            output_tokens: totalOutput,
            output_tokens_details: { reasoning_tokens: reasoningOutput },
            total_tokens: totalCombined || totalInput + totalOutput,
          },
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: { effort: 'medium', summary: 'auto' },
          text: { format: { type: 'text' } },
          tools: [],
          truncation: 'disabled',
        };
        if (terminal.incomplete_details) {
          completedResponse.incomplete_details = terminal.incomplete_details;
        }
        yield sseData({ type: 'response.completed', response: completedResponse });
        yield 'data: [DONE]\n\n';
        return;
      }
    }
  }
}
