/**
 * Anthropic Messages 客户端 body → StandardRequest
 */

import type {
  StandardRequest,
  StandardMessage,
  StandardContentPart,
  StandardTool,
  StandardToolChoice,
  StandardSystemBlock,
  StandardThinkingConfig,
  StandardEffort,
  CacheControl,
} from '../../protocol/standard-request.js';
import { createStandardRequest } from '../../protocol/standard-request.js';
import type { AdapterContext } from '../../types/adapter.js';
import { toSafeString } from '../../utils/string.js';

/**
 * Anthropic-defined tools 列表(服务端工具或客户端内置工具,无 input_schema,不应转发)
 * SKILL.md line 236-243: text_editor / bash / web_search / web_fetch / code_execution / memory 等
 */
const ANTHROPIC_DEFINED_TOOL_TYPES = new Set<string>([
  'computer_20241022',
  'computer_20250124',
  'text_editor_20241022',
  'text_editor_20250124',
  'text_editor_20250429',
  'text_editor_20250728',
  'bash_20241022',
  'bash_20250124',
  'web_search_20250305',
  'web_search_20260209',
  'web_fetch_20250910',
  'web_fetch_20260209',
  'code_execution_20260120',
  'code_execution_20260521',
  'tool_search_tool_regex_20251119',
  'tool_search_tool_bm25_20251119',
  'memory_20250818',
]);

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  thinking?: string;
  signature?: string;
  data?: string;
  cache_control?: CacheControl;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
  [key: string]: unknown;
}

interface AnthropicBody {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  tools?: Array<{
    name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    type?: string;
    strict?: boolean;
    cache_control?: CacheControl;
  }>;
  tool_choice?: { type?: string; name?: string } | string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: { type?: string; budget_tokens?: number; display?: 'summarized' | 'omitted' };
  output_config?: { effort?: string };
  stop_sequences?: string[];
  metadata?: { request_id?: string; user_id?: string };
}

/**
 * system 字段规范化 - 保留 cache_control 断点
 * 官方文档强调 prompt caching 严重依赖前缀稳定性
 */
function systemToStandard(
  system: string | AnthropicBlock[] | undefined,
): string | StandardSystemBlock[] | null {
  if (!system) return null;
  if (typeof system === 'string') return system;

  const blocks: StandardSystemBlock[] = [];
  for (const block of system) {
    if (typeof block === 'string') {
      blocks.push({ text: block });
    } else if (block.type === 'text' && block.text) {
      blocks.push({
        text: toSafeString(block.text),
        cacheControl: block.cache_control,
      });
    }
  }
  if (blocks.length === 0) return null;
  // 无 cache_control 时降级为纯字符串,减少后续处理复杂度
  const allPlain = blocks.every((b) => !b.cacheControl);
  if (allPlain) return blocks.map((b) => b.text).join('\n');
  return blocks;
}

function parseContent(content: string | AnthropicBlock[]): StandardContentPart[] | string {
  if (typeof content === 'string') return content;

  const parts: StandardContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push({
        type: 'text',
        text: block.text,
        cacheControl: block.cache_control,
      });
    } else if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data) {
        const mediaType = block.source.media_type || 'image/png';
        parts.push({
          type: 'image',
          url: `data:${mediaType};base64,${block.source.data}`,
          mediaType,
          cacheControl: block.cache_control,
        });
      } else if (block.source.type === 'url' && block.source.url) {
        parts.push({
          type: 'image',
          url: block.source.url,
          cacheControl: block.cache_control,
        });
      }
    } else if (block.type === 'tool_use' && block.id && block.name) {
      parts.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        cacheControl: block.cache_control,
      });
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      const output = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((b) => (typeof b === 'object' && b && 'text' in b) ? toSafeString((b as { text: unknown }).text) : '').filter(Boolean).join('\n')
          : '';
      parts.push({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        output,
        isError: block.is_error,
        cacheControl: block.cache_control,
      });
    } else if (block.type === 'thinking') {
      // 保留 thinking block - 多轮对话中必须原样回传
      parts.push({
        type: 'thinking',
        text: block.thinking || block.text || '',
        signature: block.signature,
      });
    } else if (block.type === 'redacted_thinking' && block.data) {
      parts.push({
        type: 'redacted_thinking',
        data: block.data,
      });
    }
  }

  return parts;
}

function parseTools(tools: AnthropicBody['tools']): StandardTool[] {
  if (!Array.isArray(tools)) return [];
  const result: StandardTool[] = [];
  for (const t of tools) {
    // 过滤 Anthropic-defined tools(服务端工具/内置工具,不应转发到通用上游)
    if (t.type && ANTHROPIC_DEFINED_TOOL_TYPES.has(t.type)) continue;
    if (!t.name) continue;
    result.push({
      name: t.name,
      description: t.description,
      parameters: t.input_schema || {},
      strict: t.strict,
      cacheControl: t.cache_control,
    });
  }
  return result;
}

function parseToolChoice(tc: AnthropicBody['tool_choice']): StandardToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'required' || tc === 'auto' || tc === 'none') return tc;
    return undefined;
  }
  if (tc.type === 'any') return 'required';
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'tool', name: tc.name };
  return undefined;
}

/**
 * 解析 thinking 参数为标准配置
 * 支持:
 *   { type: 'adaptive', display: 'summarized' | 'omitted' }
 *   { type: 'enabled', budget_tokens: N }
 *   { type: 'disabled' }
 */
function parseThinking(t: AnthropicBody['thinking']): StandardThinkingConfig | undefined {
  if (!t || !t.type) return undefined;
  if (t.type === 'adaptive') {
    return { type: 'adaptive', display: t.display };
  }
  if (t.type === 'enabled') {
    return { type: 'enabled', budgetTokens: t.budget_tokens };
  }
  if (t.type === 'disabled') {
    return { type: 'disabled' };
  }
  return undefined;
}

function parseEffort(effort: string | undefined): StandardEffort | undefined {
  if (!effort) return undefined;
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort;
  }
  return undefined;
}

export function parseClaudeRequest(body: unknown, context: AdapterContext): StandardRequest {
  const data = (body || {}) as AnthropicBody;
  const messages: StandardMessage[] = [];

  for (const msg of data.messages ?? []) {
    const content = parseContent(msg.content);

    // 检测 user 消息中的 tool_result,单独成 tool 角色
    if (msg.role === 'user' && Array.isArray(content)) {
      const toolResults = content.filter((p) => p.type === 'tool_result');
      const others = content.filter((p) => p.type !== 'tool_result');
      if (toolResults.length > 0) {
        messages.push({ role: 'tool', content: toolResults });
      }
      if (others.length > 0) {
        messages.push({ role: 'user', content: others });
      }
    } else {
      messages.push({ role: msg.role as 'user' | 'assistant' | 'system', content });
    }
  }

  const tools = parseTools(data.tools);
  const thinkingConfig = parseThinking(data.thinking);
  const effort = parseEffort(data.output_config?.effort);

  // 作为代理,必须使用配置的默认模型,忽略客户端请求的 model
  // Claude Code 会发送 claude-sonnet-4-20250514 等模型名,但上游供应商可能不支持
  // context.defaultModel 来自供应商配置,是实际可用的模型名
  const model = context.defaultModel || data.model || '';

  const capabilities: StandardRequest['capabilitiesRequired'] = ['chat'];
  if (tools.length > 0) capabilities.push('tool_call');
  if (thinkingConfig && thinkingConfig.type !== 'disabled') capabilities.push('thinking');

  return createStandardRequest({
    id: data.metadata?.request_id || context.id,
    agent: 'claude',
    model,
    system: systemToStandard(data.system),
    messages,
    tools,
    toolChoice: parseToolChoice(data.tool_choice),
    stream: Boolean(data.stream),
    parameters: {
      maxTokens: data.max_tokens,
      temperature: data.temperature,
      topP: data.top_p,
      topK: data.top_k,
      thinking: thinkingConfig,
      effort,
      stopSequences: data.stop_sequences,
      userId: data.metadata?.user_id,
    },
    capabilitiesRequired: capabilities,
    metadata: {
      endpoint: '/v1/messages',
      caller: 'claude',
      rawHeaders: context.headers,
    },
    raw: data,
  });
}
