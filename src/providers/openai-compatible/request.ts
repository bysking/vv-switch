/**
 * StandardRequest → Chat Completions (OpenAI 兼容) 请求体
 */

import type { StandardRequest, StandardMessage, StandardThinkingConfig } from '../../protocol/standard-request.js';
import { systemToString } from '../../protocol/helpers.js';
import { normalizeToolSchema } from '../../utils/schema.js';
import { toolInputToJsonString } from '../../utils/string.js';
import { resolveCapabilities, DEFAULT_CAPABILITIES } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/provider.js';
import { tokenCfg } from '../../constants/index.js';

export interface ChatCompletionMessage {
  role: string;
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  stop?: string[];
  reasoning_effort?: string;
  thinking?: unknown;
  tools?: ChatCompletionTool[];
  tool_choice?: unknown;
}

function messageToChat(msg: StandardMessage, opts?: { stripImages?: boolean }): ChatCompletionMessage[] {
  const result: ChatCompletionMessage[] = [];

  if (msg.role === 'tool') {
    // tool_result 消息
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

  // Array content
  const textParts: string[] = [];
  const imageParts: Record<string, unknown>[] = [];
  const toolCalls: ChatCompletionMessage['tool_calls'] = [];

  for (const part of msg.content) {
    if (part.type === 'text') {
      textParts.push(part.text);
    } else if (part.type === 'image') {
      if (opts?.stripImages) {
        // 上游不支持 vision 时降级:图片替换为占位 text part,保持多 part 数组结构
        imageParts.push({ type: 'text', text: '[image omitted: upstream vision unsupported]' });
      } else {
        imageParts.push({ type: 'image_url', image_url: { url: part.url } });
      }
    } else if (part.type === 'tool_use') {
      toolCalls!.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: toolInputToJsonString(part.input),
        },
      });
    } else if (part.type === 'tool_result') {
      // 已经在 tool 角色分支处理，跳过
      continue;
    }
  }

  if (msg.role === 'assistant' && toolCalls.length > 0) {
    result.push({
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
      tool_calls: toolCalls,
    });
    return result;
  }

  if (imageParts.length > 0) {
    // 多模态消息，保留数组格式
    const parts: Record<string, unknown>[] = [];
    if (textParts.length > 0) parts.push({ type: 'text', text: textParts.join('\n') });
    parts.push(...imageParts);
    result.push({ role: msg.role, content: parts });
  } else {
    result.push({ role: msg.role, content: textParts.join('\n') });
  }

  return result;
}

export interface BuildChatRequestOptions {
  stripThinking?: boolean;
  stripImages?: boolean;
}

function normalizeThinking(
  thinking: boolean | StandardThinkingConfig | undefined,
): StandardThinkingConfig | undefined {
  if (thinking === true) return { type: 'enabled' };
  if (thinking === false) return { type: 'disabled' };
  return thinking;
}

/** thinking → reasoning_effort(OpenAI 风格),adaptive/enabled→high,disabled→不传 */
function thinkingToReasoningEffort(thinking: StandardThinkingConfig | undefined): string | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'adaptive' || thinking.type === 'enabled') return 'high';
  return undefined;
}

/**
 * thinking → OpenAI-compatible 上游可识别的字段
 *
 * 注意: 此处不是 Anthropic 原字段透传。OpenAI-compatible 上游(如百炼 DashScope)
 * 的 thinking.type 只接受 ["enabled", "disabled", "auto"],不支持 Anthropic 的 "adaptive"。
 * 因此 adaptive → auto 映射,并丢弃 display(Anthropic 专有字段)。
 */
function serializeThinkingField(thinking: StandardThinkingConfig | undefined): unknown {
  if (!thinking) return undefined;
  if (thinking.type === 'adaptive') {
    // 百炼等 OpenAI-compatible 上游用 "auto" 表达"模型自决是否思考",语义等同 Anthropic "adaptive"
    return { type: 'auto' };
  }
  if (thinking.type === 'enabled') {
    return thinking.budgetTokens != null
      ? { type: 'enabled', budget_tokens: thinking.budgetTokens }
      : { type: 'enabled' };
  }
  return undefined; // disabled
}

/**
 * 默认输出预算：与 anthropic provider 对齐（流式 64000 / 非流式 16000）。
 * 目的：当客户端未指定 max_tokens 时，避免上游 chat 端使用其过小的默认上限
 * （常见 2048/4096/8192）导致长输出被截断，进而在 Codex 侧表现为“中断、需手动继续”。
 * 最终仍受模型真实输出上限 maxOutputTokens 与上下文窗口 contextWindow 双重封顶，
 * 既不会发超过模型能力的值（防 400），也允许通过配置精确控制。
 */
function defaultOutputMaxTokens(stream: boolean): number {
 return stream ? tokenCfg.max : tokenCfg.min;
}

function resolveOutputMaxTokens(
  request: StandardRequest,
  caps: ReturnType<typeof resolveCapabilities>,
): number {
  let mt = request.parameters.maxTokens ?? defaultOutputMaxTokens(request.stream);
  if (caps.maxOutputTokens > 0) mt = Math.min(mt, caps.maxOutputTokens);
  if (caps.contextWindow > 0) mt = Math.min(mt, caps.contextWindow);
  return mt;
}

export function buildChatRequest(
  request: StandardRequest,
  defaultModel?: string,
  options?: BuildChatRequestOptions,
  config?: ProviderConfig,
): ChatCompletionRequest {
  const caps = config ? resolveCapabilities(config) : { ...DEFAULT_CAPABILITIES, vision: true };
  const messages: ChatCompletionMessage[] = [];

  const systemStr = systemToString(request.system);
  if (systemStr) {
    messages.push({ role: 'system', content: systemStr });
  }

  // 能力配置控制：vision=false 时强制 stripImages；thinking=false 时强制 stripThinking
  const stripImages = options?.stripImages || !caps.vision;
  const shouldStripThinking = options?.stripThinking || !caps.thinking;

  for (const msg of request.messages) {
    messages.push(...messageToChat(msg, { stripImages }));
  }

  const req: ChatCompletionRequest = {
    model: request.model || defaultModel || '',
    messages,
    stream: request.stream,
  };

  // 关键：流式必须显式开启 include_usage，否则大多数 OpenAI 兼容上游不会返回 usage，
  // 会导致 Codex 侧 total_tokens 恒为 0，永远达不到 auto-compact 阈值。
  if (request.stream) {
    req.stream_options = { include_usage: true };
  }

  if (request.parameters.temperature != null) req.temperature = request.parameters.temperature;
  if (request.parameters.topP != null) req.top_p = request.parameters.topP;
  if (request.parameters.topK != null) req.top_k = request.parameters.topK;
  // 始终带上 max_tokens：客户端未指定时用兜底默认，并被 maxOutputTokens/contextWindow 封顶
  req.max_tokens = resolveOutputMaxTokens(request, caps);
  if (request.parameters.stopSequences && request.parameters.stopSequences.length > 0) {
    req.stop = request.parameters.stopSequences;
  }

  // thinking 透传(降级时 stripThinking=true 跳过,reasoning_effort 与原字段都不传)
  // 能力配置：thinking=false 时也强制跳过
  if (!shouldStripThinking) {
    const thinking = normalizeThinking(request.parameters.thinking);
    const effort = request.parameters.reasoningEffort || thinkingToReasoningEffort(thinking);
    if (effort) req.reasoning_effort = effort;
    const thinkingField = serializeThinkingField(thinking);
    if (thinkingField !== undefined) req.thinking = thinkingField;
  }

  // 工具：始终传递 tool definitions，保证多轮对话中模型仍能调用工具
  // 注意：之前用 hasToolResult 判断来跳过，但会导致多轮对话中模型看不到工具而无法继续调用
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

    if (request.toolChoice) {
      if (request.toolChoice === 'auto' || request.toolChoice === 'none') {
        req.tool_choice = request.toolChoice;
      } else if (request.toolChoice === 'required') {
        req.tool_choice = 'required';
      } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'tool') {
        req.tool_choice = { type: 'function', function: { name: request.toolChoice.name } };
      }
    }
  }

  return req;
}
