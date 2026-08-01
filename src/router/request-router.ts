/**
 * Request Router
 *
 * 选 Adapter + 选 Provider + 调 Gateway。
 * 不做协议转换，不做 HTTP 调用。
 */

import '../adapters/index.js';
import '../providers/index.js';

import { Gateway } from '../core/gateway.js';
import { getAdapter } from '../core/adapter-manager.js';
import type { AdapterContext, AgentAdapter } from '../types/adapter.js';
import type { ProviderConfig } from '../types/provider.js';
import type { StandardRequest } from '../protocol/standard-request.js';
import type { StandardResponse } from '../protocol/standard-response.js';
import type { StreamEvent } from '../protocol/stream-events.js';

export interface RouterConfig extends ProviderConfig {
  defaultModel?: string;
}

export class RequestRouter {
  public readonly gateway: Gateway;
  private readonly config: RouterConfig;

  constructor(config: RouterConfig) {
    this.gateway = new Gateway(config);
    this.config = config;
  }

  /**
   * 选 Adapter 并 parse 请求体
   */
  parseRequest(agentId: string, body: unknown, context: AdapterContext): StandardRequest {
    const adapter = this.getAdapter(agentId);
    return adapter.parseRequest(body, {
      ...context,
      defaultModel: context.defaultModel || this.config.defaultModel || this.config.model,
    });
  }

  /**
   * 选 Adapter 并序列化响应
   */
  serializeResponse(agentId: string, response: StandardResponse, context: AdapterContext): unknown {
    const adapter = this.getAdapter(agentId);
    return adapter.serializeResponse(response, context);
  }

  /**
   * 选 Adapter 并序列化流
   */
  serializeStream(
    agentId: string,
    stream: AsyncIterable<StreamEvent>,
    context: AdapterContext,
  ): AsyncIterable<string> {
    const adapter = this.getAdapter(agentId);
    return adapter.serializeStream(stream, context);
  }

  async chat(request: StandardRequest): Promise<StandardResponse> {
    return this.gateway.chat(request);
  }

  stream(request: StandardRequest): AsyncGenerator<StreamEvent> {
    return this.gateway.stream(request);
  }

  models(): Promise<{ object: string; data: { id: string }[] }> {
    return this.gateway.models();
  }

  private getAdapter(agentId: string): AgentAdapter {
    const adapter = getAdapter(agentId);
    if (!adapter) {
      throw new Error(`Unknown agent adapter: ${agentId}`);
    }
    return adapter;
  }
}
