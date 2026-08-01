/**
 * StandardRequest → Anthropic Messages 请求体
 *
 * 关键规则(参考 Claude API 官方文档):
 * - Claude 4.6+ 推荐 adaptive thinking; Fable 5 / Opus 4.7+ 禁止 budget_tokens
 * - system 数组保留 cache_control(prompt caching 严重依赖前缀稳定性)
 * - image base64 双向支持(data:URL <-> base64 source)
 * - 默认 max_tokens 提升: 非流式 16000, 流式 64000
 * - thinking block 原样回传(signature 不能修改)
 */

import type {
  StandardRequest,
  StandardMessage,
  StandardSystemBlock,
  StandardThinkingConfig,
  CacheControl,
} from '../../protocol/standard-request.js';
import { normalizeToolSchema } from '../../utils/schema.js';
import { resolveCapabilities, DEFAULT_CAPABILITIES } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/provider.js';
import { tokenCfg } from '../../constants/index.js';

export interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: CacheControl }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
    strict?: boolean;
    cache_control?: CacheControl;
  }>;
  tool_choice?: unknown;
  thinking?:
    | { type: 'enabled'; budget_tokens?: number }
    | { type: 'disabled' }
    | { type: 'adaptive'; display?: 'summarized' | 'omitted' };
  output_config?: { effort?: string };
  stop_sequences?: string[];
  metadata?: { user_id?: string };
}

/** 匹配 Claude 4.7 / 4.8 / Fable 5 / Sonnet 5 - 禁用 budget_tokens,只支持 adaptive */
function isAdaptiveOnlyModel(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    m.includes('fable-5') ||
    m.includes('mythos-5') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-5')
  );
}

/** Fable 5 - 明确 disabled 会被 400 拒绝,只能省略 thinking */
function isFable5Model(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes('fable-5') || m.includes('mythos-5');
}

/** 支持 adaptive thinking 的 4.6+ 系列 */
function isAdaptiveCapableModel(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    isAdaptiveOnlyModel(model) ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6')
  );
}

/** 从 data:URL 提取 base64 数据和 media type */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function messageToAnthropic(msg: StandardMessage, opts?: { stripImages?: boolean }): Array<{ role: string; content: unknown }> {
  const result: Array<{ role: string; content: unknown }> = [];

  if (msg.role === 'tool') {
    // tool result → user message with tool_result block
    if (Array.isArray(msg.content)) {
      const blocks = msg.content
        .filter((part) => part.type === 'tool_result')
        .map((part) => {
          if (part.type !== 'tool_result') return null;
          const block: Record<string, unknown> = {
            type: 'tool_result',
            tool_use_id: part.toolUseId,
            content: part.output,
          };
          if (part.isError) block.is_error = true;
          if (part.cacheControl) block.cache_control = part.cacheControl;
          return block;
        })
        .filter(Boolean);
      if (blocks.length > 0) {
        result.push({ role: 'user', content: blocks });
      }
    }
    return result;
  }

  if (typeof msg.content === 'string') {
    result.push({ role: msg.role, content: msg.content });
    return result;
  }

  // Array of parts → array of Anthropic content blocks
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of msg.content) {
    if (part.type === 'text') {
      const block: Record<string, unknown> = { type: 'text', text: part.text };
      if (part.cacheControl) block.cache_control = part.cacheControl;
      blocks.push(block);
    } else if (part.type === 'image') {
      // 支持 data:URL 拆解回 base64 source
      const dataUrl = parseDataUrl(part.url);
      // 能力配置：vision=false 时图片替换为占位文本
      if (opts?.stripImages) {
        blocks.push({ type: 'text', text: '[image omitted: upstream vision unsupported]' });
      } else {
        const block: Record<string, unknown> = {
          type: 'image',
          source: dataUrl
            ? { type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data }
            : { type: 'url', url: part.url },
        };
        if (part.cacheControl) block.cache_control = part.cacheControl;
        blocks.push(block);
      }
    } else if (part.type === 'tool_use') {
      const block: Record<string, unknown> = {
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: typeof part.input === 'string' ? safeParseJson(part.input) : (part.input ?? {}),
      };
      if (part.cacheControl) block.cache_control = part.cacheControl;
      blocks.push(block);
    } else if (part.type === 'thinking') {
      // 多轮对话中原样回传 thinking block
      const block: Record<string, unknown> = { type: 'thinking', thinking: part.text };
      if (part.signature) block.signature = part.signature;
      blocks.push(block);
    } else if (part.type === 'redacted_thinking') {
      blocks.push({ type: 'redacted_thinking', data: part.data });
    }
  }

  if (blocks.length > 0) {
    result.push({ role: msg.role, content: blocks });
  }
  return result;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * 将标准 system 结构转换为 Anthropic system 字段,保留 cache_control
 */
function buildSystem(
  system: string | StandardSystemBlock[] | null,
): AnthropicRequest['system'] | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }];
  }
  return system.map((b) => {
    const block: { type: 'text'; text: string; cache_control?: CacheControl } = {
      type: 'text',
      text: b.text,
    };
    if (b.cacheControl) block.cache_control = b.cacheControl;
    return block;
  });
}

/**
 * 决定发送给上游的 thinking 参数
 * 规则(SKILL.md):
 *   - 客户端显式指定 → 遵从客户端(但对不兼容的模型做修正)
 *   - 未指定 → 视模型能力选择: adaptive-capable → adaptive; 否则不发送
 */
function buildThinking(
  model: string,
  thinking: boolean | StandardThinkingConfig | undefined,
): AnthropicRequest['thinking'] | undefined {
  const adaptiveOnly = isAdaptiveOnlyModel(model);
  const fable5 = isFable5Model(model);
  const adaptiveCapable = isAdaptiveCapableModel(model);

  // 客户端未指定 thinking
  if (thinking === undefined) {
    // 4.7+ / Fable 5: 默认 adaptive 更优,但风险是与客户端预期不符 - 让客户端自决,不主动开启
    // 老模型: 也不开启
    return undefined;
  }

  /** 老模型(非 adaptive)开启 thinking 的默认 budget_tokens */
  const DEFAULT_BUDGET_TOKENS = 4096;

  // 兼容旧的 boolean 形态
  if (thinking === true) {
    if (adaptiveCapable) return { type: 'adaptive' };
    return { type: 'enabled', budget_tokens: DEFAULT_BUDGET_TOKENS };
  }
  if (thinking === false) {
    if (fable5) return undefined; // Fable 5 明确 disabled 会 400
    if (adaptiveOnly) return { type: 'disabled' };
    return { type: 'disabled' };
  }

  // 结构化配置
  if (thinking.type === 'adaptive') {
    // 只有 adaptive-capable 才支持
    if (!adaptiveCapable) return undefined;
    const t: { type: 'adaptive'; display?: 'summarized' | 'omitted' } = { type: 'adaptive' };
    if (thinking.display) t.display = thinking.display;
    return t;
  }
  if (thinking.type === 'enabled') {
    // 4.7+ / Fable 5 不再支持 enabled + budget_tokens - 转成 adaptive
    if (adaptiveOnly) return { type: 'adaptive' };
    // 老模型：有 budgetTokens 则用，否则给一个默认值
    if (thinking.budgetTokens && thinking.budgetTokens >= 1024) {
      return { type: 'enabled', budget_tokens: thinking.budgetTokens };
    }
    return { type: 'enabled', budget_tokens: DEFAULT_BUDGET_TOKENS };
  }
  if (thinking.type === 'disabled') {
    if (fable5) return undefined;
    return { type: 'disabled' };
  }
  return undefined;
}

/** 默认 max_tokens: 流式给足空间(SKILL.md 建议 64000),非流式 16000 */
function defaultMaxTokens(stream: boolean): number {
  return stream ? tokenCfg.max : tokenCfg.min;
}

export function buildAnthropicRequest(request: StandardRequest, defaultModel?: string, config?: ProviderConfig): AnthropicRequest {
  const caps = config ? resolveCapabilities(config) : { ...DEFAULT_CAPABILITIES, vision: true };

  const messages: Array<{ role: string; content: unknown }> = [];
  const stripImages = !caps.vision;
  for (const msg of request.messages) {
    messages.push(...messageToAnthropic(msg, { stripImages }));
  }

  const model = request.model || defaultModel || '';
  const req: AnthropicRequest = {
    model,
    messages,
    max_tokens: caps.maxOutputTokens && caps.maxOutputTokens > 0
      ? Math.min(request.parameters.maxTokens ?? defaultMaxTokens(request.stream), caps.maxOutputTokens)
      : (request.parameters.maxTokens ?? defaultMaxTokens(request.stream)),
    stream: request.stream,
  };

  const system = buildSystem(request.system);
  if (system) {
    // 能力配置：promptCache=false 时剥离 cache_control
    if (Array.isArray(system) && !caps.promptCache) {
      req.system = system.map((b) => {
        if (typeof b === 'object' && b !== null && 'cache_control' in b) {
          const { cache_control, ...rest } = b as { type: 'text'; text: string; cache_control?: CacheControl };
          return rest as { type: 'text'; text: string };
        }
        return b;
      });
    } else {
      req.system = system;
    }
  }

  if (request.parameters.temperature != null) req.temperature = request.parameters.temperature;
  if (request.parameters.topP != null) req.top_p = request.parameters.topP;
  if (request.parameters.topK != null) req.top_k = request.parameters.topK;
  if (request.parameters.stopSequences && request.parameters.stopSequences.length > 0) {
    req.stop_sequences = request.parameters.stopSequences;
  }
  if (request.parameters.userId) {
    req.metadata = { user_id: request.parameters.userId };
  }

  // Fable 5 / Sonnet 5 移除了 temperature / top_p / top_k, 主动清理避免 400
  if (isAdaptiveOnlyModel(model)) {
    delete req.temperature;
    delete req.top_p;
    delete req.top_k;
  }

  // 能力配置：thinking=false 时跳过 thinking 参数
  if (caps.thinking) {
    const thinking = buildThinking(model, request.parameters.thinking);
    if (thinking) req.thinking = thinking;
  }

  // output_config.effort (Opus 4.5+ / Sonnet 4.6+ / Fable 5)
  if (request.parameters.effort) {
    req.output_config = { effort: request.parameters.effort };
  }

  // 能力配置：functionCalling=false 时跳过工具定义
  if (request.tools.length > 0 && caps.functionCalling) {
    req.tools = request.tools.map((t) => {
      const tool: {
        name: string;
        description?: string;
        input_schema: Record<string, unknown>;
        strict?: boolean;
        cache_control?: CacheControl;
      } = {
        name: t.name,
        description: t.description,
        input_schema: normalizeToolSchema(t.parameters),
      };
      if (t.strict) tool.strict = true;
      if (t.cacheControl) tool.cache_control = t.cacheControl;
      return tool;
    });

    if (request.toolChoice) {
      if (request.toolChoice === 'required') {
        req.tool_choice = { type: 'any' };
      } else if (request.toolChoice === 'auto') {
        req.tool_choice = { type: 'auto' };
      } else if (request.toolChoice === 'none') {
        req.tool_choice = { type: 'none' };
      } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'tool') {
        req.tool_choice = { type: 'tool', name: request.toolChoice.name };
      }
    }
  }

  return req;
}
