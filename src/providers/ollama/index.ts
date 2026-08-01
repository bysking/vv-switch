/**
 * Ollama Provider
 */

import type { Provider, ProviderConfig, ProviderDiscoveryResult, ProviderHealthStatus } from '../../types/provider.js';
import type { StandardRequest } from '../../protocol/standard-request.js';
import type { StandardResponse } from '../../protocol/standard-response.js';
import type { StreamEvent } from '../../protocol/stream-events.js';
import { CAPABILITY_STATUS } from '../../types/gateway.js';
import { buildOllamaChatUrl, buildOllamaModelsUrl } from '../../utils/url.js';
import { buildOllamaRequest } from './request.js';
import { parseOllamaResponse } from './response.js';
import { parseOllamaStream } from './stream.js';
import { registerProvider } from '../registry.js';
import { ProviderUnavailable } from '../../core/errors.js';
import { upstreamFetch } from '../../protocol-log/index.js';

export const ollamaProvider: Provider = {
  id: 'ollama',

  async discover(config: ProviderConfig): Promise<ProviderDiscoveryResult> {
    let models: { id: string }[] = [];
    try {
      const url = buildOllamaModelsUrl(config.baseUrl);
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json() as { models?: Array<{ name: string }> };
        models = data.models?.map((m) => ({ id: m.name })) ?? [];
      }
    } catch { /* fall through */ }

    return {
      provider: 'ollama',
      models,
      capabilities: {
        chat: CAPABILITY_STATUS.NATIVE,
        tool_call: CAPABILITY_STATUS.NATIVE,
        stream: CAPABILITY_STATUS.NATIVE,
        thinking: CAPABILITY_STATUS.NATIVE,
      },
      api: { chat: buildOllamaChatUrl(config.baseUrl) },
    };
  },

  async chat(request: StandardRequest, config: ProviderConfig): Promise<StandardResponse> {
    const upstreamReq = buildOllamaRequest(request, config.model, config);
    const response = await upstreamFetch(request, buildOllamaChatUrl(config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...upstreamReq, stream: false }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderUnavailable(`Ollama error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    return parseOllamaResponse(data, { id: request.id, model: request.model });
  },

  async *stream(request: StandardRequest, config: ProviderConfig): AsyncGenerator<StreamEvent> {
    const upstreamReq = buildOllamaRequest(request, config.model, config);
    const response = await upstreamFetch(request, buildOllamaChatUrl(config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...upstreamReq, stream: true }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      yield { type: 'START', id: request.id, model: request.model };
      yield { type: 'ERROR', message: errorBody.slice(0, 500), status: response.status };
      yield { type: 'END', stopReason: 'error' };
      return;
    }

    yield* parseOllamaStream(response, { id: request.id, model: request.model });
  },

  async models(config: ProviderConfig) {
    const response = await fetch(buildOllamaModelsUrl(config.baseUrl));
    if (!response.ok) return { object: 'list', data: [] };
    const data = await response.json() as { models?: Array<{ name: string }> };
    return {
      object: 'list',
      data: (data.models ?? []).map((m) => ({
        id: m.name,
        object: 'model',
        owned_by: 'ollama',
      })),
    };
  },

  async health(_config: ProviderConfig): Promise<ProviderHealthStatus> {
    return { ok: true };
  },
};

registerProvider(ollamaProvider);
