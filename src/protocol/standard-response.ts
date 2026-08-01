/**
 * 内部统一协议：StandardResponse
 *
 * Provider 将上游响应转换为 StandardResponse;
 * Adapter 将 StandardResponse 序列化为客户端期望的格式。
 */

export interface StandardTextOutput {
  type: 'text';
  text: string;
}

export interface StandardThinkingOutput {
  type: 'thinking';
  text: string;
  /** Anthropic 4.6+ thinking block 的签名,回传时必须原样保留 */
  signature?: string;
}

export interface StandardRedactedThinkingOutput {
  type: 'redacted_thinking';
  data: string;
}

export interface StandardToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type StandardResponseContent =
  | StandardTextOutput
  | StandardThinkingOutput
  | StandardRedactedThinkingOutput;

export type StandardStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'error';

/**
 * 当 stop_reason === 'refusal',上游会返回 stop_details 结构
 * SKILL.md line 455: `type: "refusal", category: "cyber"|"bio"|null, explanation`
 */
export interface StandardStopDetails {
  type: 'refusal';
  category?: string | null;
  explanation?: string;
}

export interface StandardUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Anthropic prompt caching */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** OpenAI: prompt_tokens_details.cached_tokens */
  cachedInputTokens?: number;
  /** OpenAI: completion_tokens_details.reasoning_tokens */
  reasoningOutputTokens?: number;
}

export interface StandardResponse {
  id: string;
  model: string;
  content: StandardResponseContent[];
  toolCalls: StandardToolCall[];
  usage: StandardUsage;
  stopReason: StandardStopReason;
  stopDetails?: StandardStopDetails | null;
  /** 上游原始响应(用于日志和调试) */
  raw?: unknown;
}

export function createStandardResponse(
  data: Partial<StandardResponse> & Pick<StandardResponse, 'id' | 'model'>,
): StandardResponse {
  const usage: StandardUsage = {
    inputTokens: data.usage?.inputTokens ?? 0,
    outputTokens: data.usage?.outputTokens ?? 0,
    totalTokens: data.usage?.totalTokens ?? 0,
  };
  if (data.usage?.cacheCreationInputTokens != null) {
    usage.cacheCreationInputTokens = data.usage.cacheCreationInputTokens;
  }
  if (data.usage?.cacheReadInputTokens != null) {
    usage.cacheReadInputTokens = data.usage.cacheReadInputTokens;
  }
  if (data.usage?.cachedInputTokens != null) {
    usage.cachedInputTokens = data.usage.cachedInputTokens;
  }
  if (data.usage?.reasoningOutputTokens != null) {
    usage.reasoningOutputTokens = data.usage.reasoningOutputTokens;
  }
  return {
    id: data.id,
    model: data.model,
    content: data.content ?? [],
    toolCalls: data.toolCalls ?? [],
    usage,
    stopReason: data.stopReason ?? 'end_turn',
    stopDetails: data.stopDetails ?? null,
    raw: data.raw,
  };
}
