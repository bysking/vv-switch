/**
 * StandardRequest → Ollama /api/chat 请求体
 */

import type { StandardRequest, StandardMessage } from '../../protocol/standard-request.js';
import { systemToString } from '../../protocol/helpers.js';
import { normalizeToolSchema } from '../../utils/schema.js';
import { resolveCapabilities, DEFAULT_CAPABILITIES } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/provider.js';

export interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    id?: string;
    type: 'function';
    function: { name: string; arguments: unknown };
  }>;
  tool_call_id?: string;
  images?: string[];
}

export interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
  };
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  think?: boolean;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { value: s };
  }
}

function messageToOllama(msg: StandardMessage): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  if (msg.role === 'tool') {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: part.toolUseId,
            content: part.output,
          });
        }
      }
    }
    return result;
  }

  if (typeof msg.content === 'string') {
    result.push({ role: msg.role, content: msg.content });
    return result;
  }

  const textParts: string[] = [];
  const images: string[] = [];
  const toolCalls: OllamaMessage['tool_calls'] = [];

  for (const part of msg.content) {
    if (part.type === 'text') {
      textParts.push(part.text);
    } else if (part.type === 'image') {
      const m = /^data:[^;]+;base64,(.+)$/.exec(part.url);
      if (m) images.push(m[1]);
    } else if (part.type === 'tool_use') {
      const args = typeof part.input === 'string' ? safeParseJson(part.input) : (part.input ?? {});
      toolCalls!.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: args,
        },
      });
    }
  }

  const om: OllamaMessage = {
    role: msg.role,
    content: textParts.join('\n'),
  };
  if (images.length > 0) om.images = images;
  if (toolCalls.length > 0) om.tool_calls = toolCalls;

  result.push(om);
  return result;
}

export function buildOllamaRequest(request: StandardRequest, defaultModel?: string, config?: ProviderConfig): OllamaRequest {
  const caps = config ? resolveCapabilities(config) : { ...DEFAULT_CAPABILITIES, vision: true };

  const messages: OllamaMessage[] = [];

  const systemStr = systemToString(request.system);
  if (systemStr) {
    messages.push({ role: 'system', content: systemStr });
  }

  for (const msg of request.messages) {
    messages.push(...messageToOllama(msg));
  }

  const req: OllamaRequest = {
    model: request.model || defaultModel || '',
    messages,
    stream: request.stream,
  };

  const options: NonNullable<OllamaRequest['options']> = {};
  if (request.parameters.temperature != null) options.temperature = request.parameters.temperature;
  if (request.parameters.topP != null) options.top_p = request.parameters.topP;
  if (request.parameters.topK != null) options.top_k = request.parameters.topK;
  if (request.parameters.maxTokens != null) options.num_predict = request.parameters.maxTokens;
  if (request.parameters.stopSequences && request.parameters.stopSequences.length > 0) {
    options.stop = request.parameters.stopSequences;
  }
  if (Object.keys(options).length > 0) req.options = options;

  // 能力配置：functionCalling=false 时跳过工具定义
  if (request.tools.length > 0 && caps.functionCalling) {
    req.tools = request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: normalizeToolSchema(t.parameters),
      },
    }));
  }

  // 能力配置：thinking=false 时跳过 think 字段
  if (caps.thinking && request.parameters.thinking) {
    req.think = Boolean(request.parameters.thinking);
  }

  return req;
}
