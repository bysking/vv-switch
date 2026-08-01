/**
 * OpenAI Responses Provider（OpenAI 原生 Responses API）
 */

import type { Provider, ProviderConfig, ProviderDiscoveryResult, ProviderHealthStatus } from '../../types/provider.js';
import type { StandardRequest } from '../../protocol/standard-request.js';
import type { StandardResponse } from '../../protocol/standard-response.js';
import type { StreamEvent } from '../../protocol/stream-events.js';
import { CAPABILITY_STATUS } from '../../types/gateway.js';
import { buildResponsesUrl, buildModelsUrl } from '../../utils/url.js';
import { buildResponsesRequest } from './request.js';
import { parseResponsesResponse } from './response.js';
import { parseResponsesStream } from './stream.js';
import { registerProvider } from '../registry.js';
import { ProviderUnavailable, AuthenticationError } from '../../core/errors.js';
import { upstreamFetch } from '../../protocol-log/index.js';

export const openAIProvider: Provider = {
  id: 'openai',

  async discover(config: ProviderConfig): Promise<ProviderDiscoveryResult> {
    let models: { id: string }[] = [];
    try {
      const url = buildModelsUrl(config.baseUrl);
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.apiKey}` } });
      if (response.ok) {
        const data = await response.json() as { data?: Array<{ id: string }> };
        models = data.data?.map((m) => ({ id: m.id })) ?? [];
      }
    } catch { /* fall through */ }

    return {
      provider: 'openai',
      models,
      capabilities: {
        chat: CAPABILITY_STATUS.NATIVE,
        responses: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        parallel_tool: CAPABILITY_STATUS.NATIVE,
        reasoning: CAPABILITY_STATUS.NATIVE,
        json_schema: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        vision: CAPABILITY_STATUS.NATIVE,
      },
      api: { responses: buildResponsesUrl(config.baseUrl) },
    };
  },

  async chat(request: StandardRequest, config: ProviderConfig): Promise<StandardResponse> {
    const upstreamReq = buildResponsesRequest(request, config.model, config);
    const response = await upstreamFetch(request, buildResponsesUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...upstreamReq, stream: false }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(`Upstream auth failed (${response.status})`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new ProviderUnavailable(`Responses error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    return parseResponsesResponse(data, { id: request.id, model: request.model });
  },

  async *stream(request: StandardRequest, config: ProviderConfig): AsyncGenerator<StreamEvent> {
    const upstreamReq = buildResponsesRequest(request, config.model, config);
    const response = await upstreamFetch(request, buildResponsesUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...upstreamReq, stream: true }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      yield { type: 'START', id: request.id, model: request.model };
      yield { type: 'ERROR', message: errorBody.slice(0, 500), status: response.status };
      yield { type: 'END', stopReason: 'error' };
      return;
    }

    yield* parseResponsesStream(response, { id: request.id, model: request.model });
  },

  async models(config: ProviderConfig) {
    const response = await fetch(buildModelsUrl(config.baseUrl), {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    });
    if (!response.ok) return { object: 'list', data: [] };
    return await response.json() as { object: string; data: { id: string }[] };
  },

  async health(_config: ProviderConfig): Promise<ProviderHealthStatus> {
    return { ok: true };
  },
};

registerProvider(openAIProvider);
