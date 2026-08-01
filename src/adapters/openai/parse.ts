/**
 * OpenAI Chat Completions 客户端 body → StandardRequest
 *
 * 面向直接使用 /v1/chat/completions 的客户端（如 VS Code Copilot 自定义端点）。
 */

import type {
  StandardRequest,
  StandardMessage,
  StandardContentPart,
  StandardTool,
  StandardToolChoice,
} from '../../protocol/standard-request.js';
import { createStandardRequest } from '../../protocol/standard-request.js';
import type { AdapterContext } from '../../types/adapter.js';
import { toSafeString } from '../../utils/string.js';
import { safeParseJson } from '../shared/util.js';

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | object };
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  thinking?: unknown;
  tool_choice?: unknown;
  tools?: Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  }>;
}

/** 将 chat message 的 content（string 或 parts 数组）转换为 StandardContentPart[] */
function contentToParts(content: unknown): StandardContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: toSafeString(content) }];
  }
  const parts: StandardContentPart[] = [];
  for (const c of content) {
    if (typeof c === 'string') {
      parts.push({ type: 'text', text: c });
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    const part = c as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const img = part.image_url as { url?: string } | undefined;
      if (img?.url) parts.push({ type: 'image', url: img.url });
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

export function parseOpenAIRequest(body: unknown, context: AdapterContext): StandardRequest {
  const data = (body || {}) as ChatBody;
  const messages: StandardMessage[] = [];

  for (const msg of data.messages ?? []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role || 'user';

    // tool 结果消息
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool_result',
          toolUseId: msg.tool_call_id || '',
          output: typeof msg.content === 'string' ? msg.content : toSafeString(msg.content),
        }],
      });
      continue;
    }

    // assistant 带 tool_calls
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const parts: StandardContentPart[] = [];
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) parts.push({ type: 'text', text });
      for (const tc of msg.tool_calls) {
        const fn = tc.function ?? {};
        parts.push({
          type: 'tool_use',
          id: tc.id || '',
          name: fn.name || '',
          input: typeof fn.arguments === 'string' ? safeParseJson(fn.arguments) : (fn.arguments ?? {}),
        });
      }
      messages.push({ role: 'assistant', content: parts });
      continue;
    }

    // system / user / assistant 普通消息
    const parts = contentToParts(msg.content);
    const onlyText = parts.length === 1 && parts[0].type === 'text';
    messages.push({
      role: role as 'user' | 'assistant' | 'system',
      content: onlyText ? (parts[0] as { type: 'text'; text: string }).text : parts,
    });
  }

  // tools
  const tools: StandardTool[] = [];
  for (const t of data.tools ?? []) {
    if (t.type !== 'function') continue;
    const fn = t.function ?? {};
    tools.push({
      name: fn.name || '',
      description: fn.description,
      parameters: fn.parameters || {},
    });
  }

  const toolChoice = parseOpenAIToolChoice(data.tool_choice);

  // 作为代理，使用配置的默认模型，忽略客户端请求的 model
  const model = context.defaultModel || data.model || '';

  return createStandardRequest({
    id: context.id,
    agent: 'openai',
    model,
    system: null,
    messages,
    tools,
    toolChoice,
    stream: Boolean(data.stream),
    parameters: {
      maxTokens: data.max_completion_tokens ?? data.max_tokens,
      temperature: data.temperature,
      topP: data.top_p,
      reasoningEffort: data.reasoning_effort,
      thinking: data.thinking as any,
    },
    capabilitiesRequired: tools.length > 0 ? ['chat', 'tool_call'] : ['chat'],
    metadata: {
      endpoint: '/v1/chat/completions',
      caller: 'openai',
      rawHeaders: context.headers,
    },
    raw: data,
  });
}

/**
 * Chat Completions tool_choice → StandardToolChoice
 *   "auto" | "required" | "none" | { type:"function", function:{name} }
 */
function parseOpenAIToolChoice(tc: unknown): StandardToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto' || tc === 'required' || tc === 'none') return tc;
    return undefined;
  }
  const obj = tc as Record<string, unknown>;
  if (obj.type === 'function') {
    const fn = obj.function as { name?: string } | undefined;
    if (fn?.name) return { type: 'tool', name: fn.name };
  }
  return undefined;
}
