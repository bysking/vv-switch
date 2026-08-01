/**
 * 适配器共享:停止原因映射
 *
 * 单一权威来源:把内部 StandardStopReason 映射到三种客户端协议的结束表达。
 * 之前散落在 claude/openai/codex 各自的 serialize+stream(6 处)且口径不一致
 * (openai/codex 对 pause_turn/refusal/error 走 default 静默成 stop/completed)。
 * 集中后,新增 stopReason 只需改这一处,各适配器口径自动一致。
 */

import type { StandardStopReason } from '../../protocol/standard-response.js';

/**
 * → Anthropic Messages stop_reason。
 * 与 StandardStopReason 同义(Anthropic 是参照协议),identity 映射。
 * error 在非流式不可达(路由层已抛 500);流式走独立 error 事件,不经过此函数。
 */
export function toAnthropicStopReason(reason: StandardStopReason): string {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
    case 'refusal':
      return reason;
    default:
      return 'end_turn';
  }
}

/**
 * → OpenAI Chat Completions finish_reason。
 * chat 协议无 error/pause_turn/refusal 对应枚举,只能落到 'stop'
 * (错误信息会随 error 字段或失败响应另行上报,此处不静默吞掉语义)。
 */
export function toChatFinishReason(reason: StandardStopReason, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
    default:
      return 'stop';
  }
}

/**
 * → OpenAI Responses 终态(status + incomplete_details)。
 * max_tokens → incomplete(让 Codex 知道被截断,而非误判为主动结束)。
 * error → failed(非流式不可达;流式 ERROR 路径另行构造 response.failed)。
 */
export interface ResponsesTerminal {
  status: 'completed' | 'incomplete' | 'failed';
  incomplete_details?: { reason: 'max_output_tokens' | 'content_filter' };
}

export function toResponsesTerminal(reason: StandardStopReason): ResponsesTerminal {
  switch (reason) {
    case 'max_tokens':
      return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    case 'error':
      return { status: 'failed' };
    default:
      // end_turn / stop_sequence / tool_use / pause_turn / refusal
      // pause_turn/refusal 在 Responses 协议无对应 incomplete_reason,按正常完成处理
      return { status: 'completed' };
  }
}
