/**
 * Provider 接口与配置类型
 */

import type { StandardRequest } from '../protocol/standard-request.js';
import type { StandardResponse } from '../protocol/standard-response.js';
import type { StreamEvent } from '../protocol/stream-events.js';
import type { CapabilityMap } from './gateway.js';

export interface ModelCapabilities {
  /** 是否支持推理/思考 (默认 true) */
  thinking?: boolean;
  /** 是否支持视觉/图片输入 (默认 false) */
  vision?: boolean;
  /** 是否支持音频输入 (默认 false) */
  audio?: boolean;
  /** 是否支持视频输入 (默认 false) */
  video?: boolean;
  /** 是否支持工具调用 (默认 true) */
  functionCalling?: boolean;
  /** 上下文窗口大小 tokens (默认 1048576 = 1M) */
  contextWindow?: number;
  /** 最大输出 tokens (默认 0 不限制) */
  maxOutputTokens?: number;
  /** 是否支持提示词缓存 (默认 false) */
  promptCache?: boolean;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  protocolType?: string;
  providerType?: string;
  /** 模型能力配置（可选，使用默认值兼容老数据） */
  modelCapabilities?: ModelCapabilities;
}

/** 模型能力默认值常量，供 request builder 共享使用 */
export const DEFAULT_CAPABILITIES: Required<ModelCapabilities> = {
  thinking: true,
  vision: false,
  audio: false,
  video: false,
  functionCalling: true,
  contextWindow: 1048576,
  maxOutputTokens: 0,
  promptCache: false,
};

/** 解析供应商能力配置，对未设置的字段使用默认值 */
export function resolveCapabilities(config: ProviderConfig): Required<ModelCapabilities> {
  return {
    thinking: config.modelCapabilities?.thinking ?? DEFAULT_CAPABILITIES.thinking,
    vision: config.modelCapabilities?.vision ?? DEFAULT_CAPABILITIES.vision,
    audio: config.modelCapabilities?.audio ?? DEFAULT_CAPABILITIES.audio,
    video: config.modelCapabilities?.video ?? DEFAULT_CAPABILITIES.video,
    functionCalling: config.modelCapabilities?.functionCalling ?? DEFAULT_CAPABILITIES.functionCalling,
    contextWindow: config.modelCapabilities?.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow,
    maxOutputTokens: config.modelCapabilities?.maxOutputTokens ?? DEFAULT_CAPABILITIES.maxOutputTokens,
    promptCache: config.modelCapabilities?.promptCache ?? DEFAULT_CAPABILITIES.promptCache,
  };
}

export interface ProviderModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
  [key: string]: unknown;
}

export interface ProviderHealthStatus {
  ok: boolean;
  message?: string;
}

export interface ProviderDiscoveryResult {
  provider: string;
  models: ProviderModelInfo[];
  capabilities: Partial<CapabilityMap>;
  api?: Record<string, string>;
}

export interface Provider {
  /** 唯一 id，例如 "openai-compatible"、"anthropic"、"ollama"、"openai" */
  id: string;
  /** 首次连接时探测能力（应做缓存） */
  discover(config: ProviderConfig): Promise<ProviderDiscoveryResult>;
  /** 非流式：StandardRequest → 上游 HTTP → StandardResponse */
  chat(request: StandardRequest, config: ProviderConfig): Promise<StandardResponse>;
  /** 流式：StandardRequest → 上游 SSE → StreamEvent 序列 */
  stream(request: StandardRequest, config: ProviderConfig): AsyncGenerator<StreamEvent>;
  /** 列出可用模型 */
  models(config: ProviderConfig): Promise<{ object: string; data: ProviderModelInfo[] }>;
  /** 健康检查 */
  health(config: ProviderConfig): Promise<ProviderHealthStatus>;
}
