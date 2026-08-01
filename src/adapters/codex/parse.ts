/**
 * OpenAI Responses API 客户端 body → StandardRequest
 */

import type { StandardRequest, StandardMessage, StandardContentPart, StandardTool, StandardToolChoice } from '../../protocol/standard-request.js';
import { createStandardRequest } from '../../protocol/standard-request.js';
import type { AdapterContext } from '../../types/adapter.js';
import { toSafeString } from '../../utils/string.js';
import { responsesContentBlockToChatPart } from '../../utils/content.js';
import { safeParseJson } from '../shared/util.js';

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string | unknown;
  output?: string;
}

interface ResponsesBody {
  model?: string;
  instructions?: string;
  input?: string | ResponsesInputItem[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: { effort?: string };
  tool_choice?: unknown;
  tools?: Array<{
    type: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
  }>;
}

function inputItemContentToParts(content: unknown): StandardContentPart[] {
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: toSafeString(content) }];
  }
  const parts: StandardContentPart[] = [];
  for (const c of content) {
    const cp = responsesContentBlockToChatPart(c);
    if (cp === null) continue;
    if (typeof cp === 'string') {
      parts.push({ type: 'text', text: cp });
    } else if (cp.type === 'image_url') {
      parts.push({ type: 'image', url: cp.image_url.url });
    }
  }
  return parts;
}

export function parseCodexRequest(body: unknown, context: AdapterContext): StandardRequest {
  const data = (body || {}) as ResponsesBody;
  const messages: StandardMessage[] = [];

  // 处理 input
  if (typeof data.input === 'string') {
    messages.push({ role: 'user', content: data.input });
  } else if (Array.isArray(data.input)) {
    let pendingToolUses: StandardContentPart[] = [];

    const flushToolUses = (): void => {
      if (pendingToolUses.length > 0) {
        messages.push({ role: 'assistant', content: pendingToolUses });
        pendingToolUses = [];
      }
    };

    for (const item of data.input) {
      if (typeof item === 'string') {
        flushToolUses();
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;

      const itemType = item.type || '';

      if (itemType === 'function_call') {
        pendingToolUses.push({
          type: 'tool_use',
          id: item.call_id || item.id || '',
          name: item.name || '',
          input: typeof item.arguments === 'string'
            ? safeParseJson(item.arguments)
            : (item.arguments ?? {}),
        });
        continue;
      }

      if (itemType === 'function_call_output') {
        flushToolUses();
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool_result',
            toolUseId: item.call_id || '',
            output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          }],
        });
        continue;
      }

      flushToolUses();
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';

      const parts = inputItemContentToParts(item.content);
      const onlyText = parts.length === 1 && parts[0].type === 'text';
      messages.push({
        role: role as 'user' | 'assistant' | 'system',
        content: onlyText ? (parts[0] as { type: 'text'; text: string }).text : parts,
      });
    }

    flushToolUses();
  }

  // 处理 tools
  const tools: StandardTool[] = [];
  for (const t of data.tools ?? []) {
    if (t.type !== 'function') continue;
    const fn = t.function ?? t;
    tools.push({
      name: fn.name || '',
      description: fn.description,
      parameters: fn.parameters || {},
    });
  }

  // 解析 tool_choice：Responses API → StandardToolChoice
  const toolChoice = parseCodexToolChoice(data.tool_choice);

  // 作为代理，必须使用配置的默认模型，忽略客户端请求的 model
  const model = context.defaultModel || data.model || '';

  return createStandardRequest({
    id: context.id,
    agent: 'codex',
    model,
    system: data.instructions ?? null,
    messages,
    tools,
    toolChoice,
    stream: Boolean(data.stream),
    parameters: {
      maxTokens: data.max_output_tokens,
      temperature: data.temperature,
      topP: data.top_p,
      reasoningEffort: data.reasoning?.effort,
      thinking: data.reasoning?.effort ? { type: 'enabled' } as const : undefined,
    },
    capabilitiesRequired: tools.length > 0 ? ['chat', 'tool_call'] : ['chat'],
    metadata: {
      endpoint: '/v1/responses',
      caller: 'codex',
      rawHeaders: context.headers,
    },
    raw: data,
  });
}

/**
 * 将 Responses API 的 tool_choice 转换为 StandardToolChoice。
 *
 * Responses API:
 *   "auto" | "required" | "none" | { type: "function", name: "my_func" }
 *
 * StandardToolChoice:
 *   "auto" | "required" | "none" | { type: "tool", name: "my_func" }
 */
function parseCodexToolChoice(tc: unknown): StandardToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto' || tc === 'required' || tc === 'none') return tc;
    return undefined;
  }
  const obj = tc as Record<string, unknown>;
  if (obj.type === 'function' && typeof obj.name === 'string') {
    return { type: 'tool', name: obj.name };
  }
  return undefined;
}
