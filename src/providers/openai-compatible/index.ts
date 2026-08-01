/**
 * OpenAI-Compatible Provider（DeepSeek、DashScope /v1、OpenAI Chat Completions）
 */

import type { Provider, ProviderConfig, ProviderDiscoveryResult, ProviderHealthStatus } from '../../types/provider.js';
import { resolveCapabilities } from '../../types/provider.js';
import type { StandardRequest } from '../../protocol/standard-request.js';
import type { StandardResponse } from '../../protocol/standard-response.js';
import type { StreamEvent } from '../../protocol/stream-events.js';
import { CAPABILITY_STATUS } from '../../types/gateway.js';
import { buildChatUrl, normalizeBaseUrl } from '../../utils/url.js';
import { buildChatRequest } from './request.js';
import { parseChatResponse } from './response.js';
import { parseChatStream } from './stream.js';
import { classifyRejection, shouldFallback, buildFallbackOptions } from './fallback.js';
import { getLearnedStripThinking, markStripThinking } from './strip-thinking-cache.js';
import { registerProvider } from '../registry.js';
import { ProviderUnavailable, AuthenticationError } from '../../core/errors.js';
import { ICON } from '../../logging/icons.js';
import { upstreamFetch } from '../../protocol-log/index.js';

function now(): number {
  return Date.now();
}

function log(...args: unknown[]): void {
  console.log(`[vv-switch] [openai-compatible-provider]`, ...args);
}

/** 构建出的 chat 请求是否带了 thinking 相关参数 */
function requestHasThinking(req: { reasoning_effort?: unknown; thinking?: unknown }): boolean {
  return req.reasoning_effort !== undefined || req.thinking !== undefined;
}

/**
 * 是否值得尝试剥离 thinking 后重试：
 * - 5xx（火山 chat 端点对该参数返回 InternalServiceError,错误体无关键词,shouldFallback 识别不到）
 * - 400 + 错误体含 "boolean"（deepseek V3.2 等期望 thinking 是布尔值,不是对象）
 */
function shouldTryStripThinking(
  status: number,
  text: string,
  learnedStrip: boolean,
  reqHasThinking: boolean,
): boolean {
  if (!reqHasThinking || learnedStrip) return false;
  if (status >= 500) return true;
  if (status === 400 && /\bboolean\b/i.test(text)) return true;
  return false;
}

export const openAICompatibleProvider: Provider = {
  id: 'openai-compatible',

  async discover(config: ProviderConfig): Promise<ProviderDiscoveryResult> {
    let models: { id: string }[] = [];
    try {
      const url = `${normalizeBaseUrl(config.baseUrl)}/models`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.apiKey}` } });
      if (response.ok) {
        const data = await response.json() as { data?: Array<{ id: string }> };
        models = data.data?.map((m) => ({ id: m.id })) ?? [];
      }
    } catch { /* fall through */ }

    return {
      provider: 'openai-compatible',
      models,
      capabilities: {
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.PROXY,
        reasoning: CAPABILITY_STATUS.PROXY,
        thinking: CAPABILITY_STATUS.PROXY,
        json_schema: CAPABILITY_STATUS.PROXY,
        vision: CAPABILITY_STATUS.PROXY,
        image: CAPABILITY_STATUS.PROXY,
      },
      api: { chat: buildChatUrl(config.baseUrl) },
    };
  },

  async chat(request: StandardRequest, config: ProviderConfig): Promise<StandardResponse> {
    // modelCapabilities 显式设置了 thinking 时，以配置为准，跳过学习的 strip 缓存
    const learnedStrip = config.modelCapabilities?.thinking !== undefined
      ? false : getLearnedStripThinking(config);
    const upstreamReq = buildChatRequest(
      request,
      config.model,
      learnedStrip ? { stripThinking: true } : undefined,
      config,
    );
    const url = buildChatUrl(config.baseUrl);
    log(`${ICON.fetch} chat | start | url=${url} | model=${upstreamReq.model} | messages=${upstreamReq.messages.length} | tools=${upstreamReq.tools?.length ?? 0}`);
    const t0 = now();

    let response: Response;
    try {
      response = await upstreamFetch(request, url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...upstreamReq, stream: false }),
      });
    } catch (err) {
      log(`${ICON.fetchErr} chat | FETCH_ERROR | duration=${now() - t0}ms | error=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    log(`${ICON.fetchOk} chat | fetch_done | status=${response.status} | duration=${now() - t0}ms`);

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      log(`${ICON.error} chat | AUTH_ERROR | status=${response.status}`);
      throw new AuthenticationError(`Upstream auth failed: ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      log(`${ICON.error} chat | UPSTREAM_ERROR | status=${response.status} | body=${text.slice(0, 200)}`);
      // 运行时降级:上游因 thinking/image 拒绝时,剥离对应参数重试一次
      if (shouldFallback(response.status, text)) {
        log(`${ICON.warn} chat | FALLBACK | reason=${classifyRejection(response.status, text).thinking ? 'thinking' : ''}${classifyRejection(response.status, text).image ? 'image' : ''}`);
        const fallbackReq = buildChatRequest(
          request,
          config.model,
          buildFallbackOptions(classifyRejection(response.status, text)),
          config,
        );
        const retry = await upstreamFetch(request, url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...fallbackReq, stream: false }),
        }, 'fallback');
        if (retry.status === 401 || retry.status === 403) {
          const retryText = await retry.text();
          throw new AuthenticationError(`Upstream auth failed: ${retryText.slice(0, 200)}`);
        }
        if (retry.ok) {
          const data = await retry.json();
          log(`${ICON.ok} chat | fallback_done | duration=${now() - t0}ms`);
          return parseChatResponse(data, { id: request.id, model: request.model });
        }
        const retryText = await retry.text();
        throw new ProviderUnavailable(`Upstream error ${retry.status}: ${retryText.slice(0, 200)}`);
      }
      // 乐观学习：上游对 thinking 返回非标准拒绝（5xx 或 400+"boolean"）时，剥离 thinking 重试一次。
      // 成功则记忆该上游需剥离 thinking，后续请求首次即剥离；失败则报原错，不掩盖真故障。
      if (shouldTryStripThinking(response.status, text, learnedStrip, requestHasThinking(upstreamReq))) {
        log(`${ICON.warn} chat | STRIP_TRY | status=${response.status} | 剥离 thinking 重试`);
        const strippedReq = buildChatRequest(request, config.model, { stripThinking: true }, config);
        const retry = await upstreamFetch(request, url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...strippedReq, stream: false }),
        }, 'fallback');
        if (retry.ok) {
          markStripThinking(config);
          log(`${ICON.ok} chat | STRIP_LEARNED | 已记忆该上游需剥离 thinking | duration=${now() - t0}ms`);
          const data = await retry.json();
          return parseChatResponse(data, { id: request.id, model: request.model });
        }
        log(`${ICON.error} chat | STRIP_FAIL | retry_status=${retry.status} | 报原 ${response.status}`);
      }
      throw new ProviderUnavailable(`Upstream error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    log(`${ICON.ok} chat | parse_done | duration=${now() - t0}ms`);
    return parseChatResponse(data, { id: request.id, model: request.model });
  },

  async *stream(request: StandardRequest, config: ProviderConfig): AsyncGenerator<StreamEvent> {
    // modelCapabilities 显式设置了 thinking 时，以配置为准，跳过学习的 strip 缓存
    const learnedStrip = config.modelCapabilities?.thinking !== undefined
      ? false : getLearnedStripThinking(config);
    let upstreamReq = buildChatRequest(
      request,
      config.model,
      learnedStrip ? { stripThinking: true } : undefined,
      config,
    );
    const url = buildChatUrl(config.baseUrl);
    log(`${ICON.streamStart} stream | open | url=${url} | model=${upstreamReq.model} | messages=${upstreamReq.messages.length} | tools=${upstreamReq.tools?.length ?? 0}`);
    const t0 = now();

    let response: Response;
    try {
      response = await upstreamFetch(request, url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...upstreamReq, stream: true }),
      });
    } catch (err) {
      log(`${ICON.fetchErr} stream | FETCH_ERROR | duration=${now() - t0}ms | error=${err instanceof Error ? err.message : String(err)}`);
      yield { type: 'START', id: request.id, model: request.model };
      yield { type: 'ERROR', message: `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 };
      yield { type: 'END', stopReason: 'error' };
      return;
    }
    log(`${ICON.fetchOk} stream | fetch_done | status=${response.status} | duration=${now() - t0}ms | hasBody=${!!response.body}`);

    // 首响应试探:4xx 且命中能力关键词时,降级重试一次再正式开流
    if (!response.ok) {
      const text = await response.text();
      log(`${ICON.error} stream | UPSTREAM_ERROR | status=${response.status} | body=${text.slice(0, 200)}`);
      if (shouldFallback(response.status, text)) {
        log(`${ICON.warn} stream | FALLBACK | reason=${classifyRejection(response.status, text).thinking ? 'thinking' : ''}${classifyRejection(response.status, text).image ? 'image' : ''}`);
        upstreamReq = buildChatRequest(
          request,
          config.model,
          buildFallbackOptions(classifyRejection(response.status, text)),
          config,
        );
        response = await upstreamFetch(request, url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...upstreamReq, stream: true }),
        }, 'fallback');
        log(`${ICON.fetchOk} stream | fallback_done | status=${response.status} | duration=${now() - t0}ms`);
      }
      // 乐观学习：上游对 thinking 返回非标准拒绝（5xx 或 400+"boolean"）时，剥离 thinking 重试开流；成功则记忆
      if (shouldTryStripThinking(response.status, text, learnedStrip, requestHasThinking(upstreamReq))) {
        log(`${ICON.warn} stream | STRIP_TRY | status=${response.status} | 剥离 thinking 重试`);
        upstreamReq = buildChatRequest(request, config.model, { stripThinking: true });
        response = await upstreamFetch(request, url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...upstreamReq, stream: true }),
        }, 'fallback');
        if (response.ok) {
          markStripThinking(config);
          log(`${ICON.ok} stream | STRIP_LEARNED | 已记忆该上游需剥离 thinking | duration=${now() - t0}ms`);
        } else {
          log(`${ICON.error} stream | STRIP_FAIL | retry_status=${response.status} | 报原错误`);
        }
      }
      if (!response.ok) {
        const errorBody = await response.text();
        yield { type: 'START', id: request.id, model: request.model };
        yield { type: 'ERROR', message: errorBody.slice(0, 500), status: response.status };
        yield { type: 'END', stopReason: 'error' };
        return;
      }
    }

    log(`${ICON.streamChunk} stream | parsing_start | duration=${now() - t0}ms`);
    let eventCount = 0;
    const eventTypes: Record<string, number> = {};
    try {
      for await (const event of parseChatStream(response, { id: request.id, model: request.model })) {
        eventCount++;
        eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
        if (eventCount <= 3 || eventCount % 50 === 0) {
          log(`${ICON.streamChunk} stream | event #${eventCount} | type=${event.type}`);
        }
        yield event;
      }
    } catch (err) {
      log(`${ICON.error} stream | PARSE_ERROR | events=${eventCount} | duration=${now() - t0}ms | error=${err instanceof Error ? err.message : String(err)}`);
      yield { type: 'ERROR', message: `Stream parse error: ${err instanceof Error ? err.message : String(err)}` };
      yield { type: 'END', stopReason: 'error' };
      return;
    }
    log(`${ICON.streamDone} stream | done | events=${eventCount} | types=${JSON.stringify(eventTypes)} | duration=${now() - t0}ms`);
  },

  async models(config: ProviderConfig) {
    const url = `${normalizeBaseUrl(config.baseUrl)}/models`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.apiKey}` } });
    if (!response.ok) return { object: 'list', data: [] };
    return await response.json() as { object: string; data: { id: string }[] };
  },

  async health(config: ProviderConfig): Promise<ProviderHealthStatus> {
    try {
      const url = `${normalizeBaseUrl(config.baseUrl)}/models`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.apiKey}` } });
      return { ok: response.ok, message: response.ok ? 'OK' : `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
};

registerProvider(openAICompatibleProvider);
