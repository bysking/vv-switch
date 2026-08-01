/**
 * Anthropic Messages Provider（DashScope /apps/anthropic、智谱、Anthropic 官方）
 */

import type { Provider, ProviderConfig, ProviderDiscoveryResult, ProviderHealthStatus } from '../../types/provider.js';
import type { StandardRequest } from '../../protocol/standard-request.js';
import type { StandardResponse } from '../../protocol/standard-response.js';
import type { StreamEvent } from '../../protocol/stream-events.js';
import { CAPABILITY_STATUS } from '../../types/gateway.js';
import { buildMessagesUrl, appendVersionedPath } from '../../utils/url.js';
import { buildAnthropicRequest } from './request.js';
import { parseAnthropicResponse } from './response.js';
import { parseAnthropicStream } from './stream.js';
import { registerProvider } from '../registry.js';
import { ProviderUnavailable, AuthenticationError } from '../../core/errors.js';
import { ICON } from '../../logging/icons.js';
import { upstreamFetch } from '../../protocol-log/index.js';

function now(): number {
  return Date.now();
}

function log(...args: unknown[]): void {
  console.log(`[vv-switch] [anthropic-provider]`, ...args);
}

function buildAnthropicHeaders(config: ProviderConfig, extra: Record<string, string> = {}): Record<string, string> {
  // 注意：DeepSeek 的 anthropic 端点会读取 authorization header 作为 API key，
  // 因此必须用 vv-switch 配置的 key 覆盖客户端传来的值
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...extra,
    'x-api-key': config.apiKey,
  };
  // 同时覆盖 authorization（某些上游用这个代替 x-api-key）
  if (config.apiKey) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async discover(config: ProviderConfig): Promise<ProviderDiscoveryResult> {
    let models: { id: string }[] = [];
    try {
      const url = appendVersionedPath(config.baseUrl, 'models');
      const response = await fetch(url, { headers: { 'x-api-key': config.apiKey } });
      if (response.ok) {
        const data = await response.json() as { data?: Array<{ id: string }> };
        models = data.data?.map((m) => ({ id: m.id })) ?? [];
      }
    } catch { /* fall through */ }

    return {
      provider: 'anthropic',
      models,
      capabilities: {
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.NATIVE,
        reasoning: CAPABILITY_STATUS.NATIVE,
        thinking: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        vision: CAPABILITY_STATUS.NATIVE,
        prompt_cache: CAPABILITY_STATUS.NATIVE,
      },
      api: { messages: buildMessagesUrl(config.baseUrl) },
    };
  },

  async chat(request: StandardRequest, config: ProviderConfig): Promise<StandardResponse> {
    const upstreamReq = buildAnthropicRequest(request, config.model, config);
    const url = buildMessagesUrl(config.baseUrl);
    const headers = buildAnthropicHeaders(
      config,
      typeof request.metadata.rawHeaders === 'object' && request.metadata.rawHeaders !== null
        ? (request.metadata.rawHeaders as Record<string, string>)
        : {},
    );

    log(`${ICON.fetch} chat | start | url=${url} | model=${upstreamReq.model} | messages=${upstreamReq.messages.length}`);
    const t0 = now();

    let response: Response;
    try {
      response = await upstreamFetch(request, url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...upstreamReq, stream: false }),
      });
    } catch (err) {
      log(`${ICON.fetchErr} chat | FETCH_ERROR | duration=${now() - t0}ms | error=${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    log(`${ICON.fetchOk} chat | fetch_done | status=${response.status} | duration=${now() - t0}ms`);

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(`Upstream auth failed (${response.status})`);
    }
    if (!response.ok) {
      const text = await response.text();
      log(`${ICON.error} chat | UPSTREAM_ERROR | status=${response.status} | body=${text.slice(0, 200)}`);
      throw new ProviderUnavailable(`Upstream error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    log(`${ICON.ok} chat | parse_done | duration=${now() - t0}ms`);
    return parseAnthropicResponse(data, { id: request.id, model: request.model });
  },

  async *stream(request: StandardRequest, config: ProviderConfig): AsyncGenerator<StreamEvent> {
    const upstreamReq = buildAnthropicRequest(request, config.model, config);
    const url = buildMessagesUrl(config.baseUrl);
    const headers = buildAnthropicHeaders(
      config,
      typeof request.metadata.rawHeaders === 'object' && request.metadata.rawHeaders !== null
        ? (request.metadata.rawHeaders as Record<string, string>)
        : {},
    );

    log(`${ICON.streamStart} stream | open | url=${url} | model=${upstreamReq.model} | messages=${upstreamReq.messages.length} | tools=${upstreamReq.tools?.length ?? 0}`);
    const t0 = now();

    let response: Response;
    try {
      response = await upstreamFetch(request, url, {
        method: 'POST',
        headers,
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

    if (!response.ok) {
      const errorBody = await response.text();
      log(`${ICON.error} stream | UPSTREAM_ERROR | status=${response.status} | body=${errorBody.slice(0, 300)}`);
      yield { type: 'START', id: request.id, model: request.model };
      yield { type: 'ERROR', message: errorBody.slice(0, 500), status: response.status };
      yield { type: 'END', stopReason: 'error' };
      return;
    }

    log(`${ICON.streamChunk} stream | parsing_start | duration=${now() - t0}ms`);
    let eventCount = 0;
    try {
      for await (const event of parseAnthropicStream(response, { id: request.id, model: request.model })) {
        eventCount++;
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
    log(`${ICON.streamDone} stream | done | events=${eventCount} | duration=${now() - t0}ms`);
  },

  async models(config: ProviderConfig) {
    try {
      const url = appendVersionedPath(config.baseUrl, 'models');
      const response = await fetch(url, { headers: { 'x-api-key': config.apiKey } });
      if (response.ok) return await response.json() as { object: string; data: { id: string }[] };
    } catch { /* fall through */ }
    return { object: 'list', data: [] };
  },

  async health(_config: ProviderConfig): Promise<ProviderHealthStatus> {
    return { ok: true };
  },
};

registerProvider(anthropicProvider);
