/**
 * StandardRequest → OpenAI Responses API 请求体
 *
 * Responses API 是 OpenAI 推出的新协议，用 input 数组而非 messages
 */

import type { StandardRequest, StandardMessage } from '../../protocol/standard-request.js';
import { systemToString } from '../../protocol/helpers.js';
import { normalizeToolSchema } from '../../utils/schema.js';
import { resolveCapabilities, DEFAULT_CAPABILITIES } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/provider.js';

export interface ResponsesRequestItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface ResponsesRequest {
  model: string;
  input?: ResponsesRequestItem[];
  instructions?: string;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: { effort: string };
  tools?: Array<{
    type: 'function';
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
}

function messageToResponsesItems(msg: StandardMessage): ResponsesRequestItem[] {
  const result: ResponsesRequestItem[] = [];

  if (msg.role === 'tool') {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool_result') {
          result.push({
            type: 'function_call_output',
            call_id: part.toolUseId,
            output: part.output,
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
  for (const part of msg.content) {
    if (part.type === 'text') {
      textParts.push(part.text);
    } else if (part.type === 'tool_use') {
      result.push({
        type: 'function_call',
        call_id: part.id,
        name: part.name,
        arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
      });
    }
  }

  if (textParts.length > 0) {
    result.push({ role: msg.role, content: textParts.join('\n') });
  }

  return result;
}

export function buildResponsesRequest(request: StandardRequest, defaultModel?: string, config?: ProviderConfig): ResponsesRequest {
  const caps = config ? resolveCapabilities(config) : { ...DEFAULT_CAPABILITIES, vision: true };

  const input: ResponsesRequestItem[] = [];

  for (const msg of request.messages) {
    input.push(...messageToResponsesItems(msg));
  }

  const req: ResponsesRequest = {
    model: request.model || defaultModel || '',
    input,
    stream: request.stream,
  };

  const systemStr = systemToString(request.system);
  if (systemStr) req.instructions = systemStr;
  if (request.parameters.temperature != null) req.temperature = request.parameters.temperature;
  if (request.parameters.topP != null) req.top_p = request.parameters.topP;
  if (request.parameters.maxTokens != null) req.max_output_tokens = request.parameters.maxTokens;
  // 能力配置：thinking=false 时跳过 reasoning 参数
  if (caps.thinking && request.parameters.reasoningEffort) {
    req.reasoning = { effort: request.parameters.reasoningEffort };
  }

  // 能力配置：functionCalling=false 时跳过工具定义
  if (request.tools.length > 0 && caps.functionCalling) {
    req.tools = request.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: normalizeToolSchema(t.parameters),
    }));
  }

  // tool_choice 映射（Responses API 格式同 Chat Completions）
  if (request.toolChoice) {
    if (request.toolChoice === 'auto' || request.toolChoice === 'none' || request.toolChoice === 'required') {
      req.tool_choice = request.toolChoice;
    } else if (typeof request.toolChoice === 'object' && (request.toolChoice as any).type === 'tool') {
      req.tool_choice = { type: 'function', name: (request.toolChoice as any).name };
    }
  }

  return req;
}
