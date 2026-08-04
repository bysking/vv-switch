/**
 * 内部统一流事件
 *
 * Provider 将上游 SSE 转换为统一的 StreamEvent 序列;
 * Adapter 将 StreamEvent 序列序列化为客户端期望的 SSE 字符串。
 */

export interface StreamStartEvent {
  type: 'START';
  id: string;
  model: string;
}

export interface StreamTokenEvent {
  type: 'TOKEN';
  text: string;
}

export interface StreamThinkingEvent {
  type: 'THINKING';
  text: string;
}

/** Anthropic thinking block 的 signature(在 stop 前送达) */
export interface StreamThinkingSignatureEvent {
  type: 'THINKING_SIGNATURE';
  signature: string;
}

export interface StreamToolCallStartEvent {
  type: 'TOOL_CALL_START';
  id: string;
  name: string;
  index: number;
}

export interface StreamToolCallDeltaEvent {
  type: 'TOOL_CALL_DELTA';
  id: string;
  index: number;
  argumentsDelta: string;
}

export interface StreamToolCallEndEvent {
  type: 'TOOL_CALL_END';
  id: string;
  index: number;
  arguments: string;
}

export interface StreamUsageEvent {
  type: 'USAGE';
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  /** Anthropic: 新写入缓存的 input tokens */
  cacheCreationInputTokens?: number;
  /** Anthropic: 从缓存读取的 input tokens */
  cacheReadInputTokens?: number;
  /** OpenAI: prompt_tokens_details.cached_tokens，Codex 用于统计 context 使用 */
  cachedInputTokens?: number;
  /** OpenAI: completion_tokens_details.reasoning_tokens，Codex 用于 TUI 显示 */
  reasoningOutputTokens?: number;
}

export interface StreamErrorEvent {
  type: 'ERROR';
  message: string;
  code?: string;
  status?: number;
}

export interface StreamEndEvent {
  type: 'END';
  stopReason:
    | 'end_turn'
    | 'max_tokens'
    | 'tool_use'
    | 'stop_sequence'
    | 'pause_turn'
    | 'refusal'
    | 'error';
  stopDetails?: {
    type: 'refusal';
    category?: string | null;
    explanation?: string;
  } | null;
  /** 上游返回的 response id（透传用，策略A 中用于 previous_response_id 链） */
  upstreamId?: string;
}

export type StreamEvent =
  | StreamStartEvent
  | StreamTokenEvent
  | StreamThinkingEvent
  | StreamThinkingSignatureEvent
  | StreamToolCallStartEvent
  | StreamToolCallDeltaEvent
  | StreamToolCallEndEvent
  | StreamUsageEvent
  | StreamErrorEvent
  | StreamEndEvent;

export type StreamEventType = StreamEvent['type'];
