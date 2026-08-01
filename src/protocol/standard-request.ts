/**
 * 内部统一协议：StandardRequest
 *
 * 所有 Agent Adapter 都必须把客户端 body 转换成 StandardRequest,
 * 所有 Provider 都从 StandardRequest 构建上游 HTTP 请求。
 */

export type StandardRole = 'system' | 'user' | 'assistant' | 'tool';

export interface CacheControl {
  type: 'ephemeral';
  ttl?: string; // e.g. "5m" | "1h"
}

export interface StandardTextPart {
  type: 'text';
  text: string;
  cacheControl?: CacheControl;
}

export interface StandardImagePart {
  type: 'image';
  url: string; // 可能是 data:URL 或 http(s):URL
  mediaType?: string;
  cacheControl?: CacheControl;
}

export interface StandardToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cacheControl?: CacheControl;
}

export interface StandardToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  output: string;
  isError?: boolean;
  cacheControl?: CacheControl;
}

/**
 * Anthropic thinking block(用于多轮对话中原样回传)
 * SKILL.md: "pass thinking blocks back exactly as received on the same model"
 */
export interface StandardThinkingPart {
  type: 'thinking';
  text: string;
  signature?: string;
}

export interface StandardRedactedThinkingPart {
  type: 'redacted_thinking';
  data: string;
}

export type StandardContentPart =
  | StandardTextPart
  | StandardImagePart
  | StandardToolUsePart
  | StandardToolResultPart
  | StandardThinkingPart
  | StandardRedactedThinkingPart;

export interface StandardMessage {
  role: StandardRole;
  content: string | StandardContentPart[];
}

/** 结构化的 system prompt - 保留 cache_control 断点 */
export interface StandardSystemBlock {
  text: string;
  cacheControl?: CacheControl;
}

export interface StandardTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /** Anthropic strict tool use */
  strict?: boolean;
  cacheControl?: CacheControl;
}

export type StandardToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'tool'; name: string };

/**
 * Thinking 参数,支持 Anthropic 4.6+ 的 adaptive 模式
 * SKILL.md:
 *   - Fable 5 / Opus 4.8 / 4.7 / Sonnet 5: 仅支持 adaptive
 *   - Opus 4.6 / Sonnet 4.6: 推荐 adaptive, budget_tokens 已弃用
 *   - 老模型: enabled + budget_tokens
 */
export type StandardThinkingConfig =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };

/** Anthropic output_config.effort */
export type StandardEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StandardRequestParameters {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  reasoningEffort?: string;
  /** 支持 boolean(兼容旧代码)或结构化配置 */
  thinking?: boolean | StandardThinkingConfig;
  /** Anthropic output_config.effort */
  effort?: StandardEffort;
  /** 停止序列 */
  stopSequences?: string[];
  /** 用户 metadata */
  userId?: string;
}

export type StandardCapability =
  | 'chat'
  | 'responses'
  | 'tool_call'
  | 'vision'
  | 'reasoning'
  | 'thinking'
  | 'stream'
  | 'json_schema'
  | 'parallel_tool'
  | 'prompt_cache';

export interface StandardRequestMetadata {
  endpoint?: string;
  caller?: string;
  conversation?: unknown;
  rawHeaders?: Record<string, string>;
  [key: string]: unknown;
}

export interface StandardRequest {
  id: string;
  agent: string;
  model: string;
  /** 结构化 system:string(简单场景) | StandardSystemBlock[](需保留 cache_control) */
  system: string | StandardSystemBlock[] | null;
  messages: StandardMessage[];
  tools: StandardTool[];
  toolChoice?: StandardToolChoice;
  stream: boolean;
  parameters: StandardRequestParameters;
  capabilitiesRequired: StandardCapability[];
  metadata: StandardRequestMetadata;
  /** 客户端原始 body(adapter 用于反查未映射字段) */
  raw: unknown;
}

export function createStandardRequest(
  data: Partial<StandardRequest> & Pick<StandardRequest, 'id' | 'agent' | 'model'>,
): StandardRequest {
  return {
    id: data.id,
    agent: data.agent,
    model: data.model,
    system: data.system ?? null,
    messages: data.messages ?? [],
    tools: data.tools ?? [],
    toolChoice: data.toolChoice,
    stream: Boolean(data.stream),
    parameters: data.parameters ?? {},
    capabilitiesRequired: data.capabilitiesRequired ?? ['chat'],
    metadata: data.metadata ?? {},
    raw: data.raw,
  };
}
