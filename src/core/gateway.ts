/**
 * Gateway 主类
 *
 * 串联：StandardRequest → middleware pipeline → Provider → StandardResponse/StreamEvent
 */

import { getProviderForConfig, providerTypeFromConfig } from './provider-manager.js';
import { discoveryCacheKey, getCachedDiscovery, setCachedDiscovery } from '../capability/cache.js';
import { detectCapabilities } from '../capability/detector.js';
import { supportsCapability } from '../capability/registry.js';
import { UnsupportedCapabilityError, normalizeGatewayError } from './errors.js';
import type { Provider, ProviderConfig, ProviderDiscoveryResult } from '../types/provider.js';
import type { StandardRequest } from '../protocol/standard-request.js';
import type { StandardResponse } from '../protocol/standard-response.js';
import type { StreamEvent } from '../protocol/stream-events.js';
import type { CapabilityMap } from '../types/gateway.js';
import type { MiddlewareFn } from '../middleware/pipeline.js';
import { createMiddlewarePipeline } from '../middleware/pipeline.js';

export class Gateway {
  private readonly config: ProviderConfig;
  public readonly provider: Provider;
  private discovery: ProviderDiscoveryResult | null = null;
  private middlewares: MiddlewareFn[] = [];

  constructor(config: ProviderConfig) {
    this.config = config;
    const provider = getProviderForConfig(config);
    if (!provider) {
      throw new Error(
        `No provider registered for ${providerTypeFromConfig(config)} ` +
        `(protocolType=${config.protocolType || 'chat'})`,
      );
    }
    this.provider = provider;
  }

  /**
   * Register middleware to be applied in order before provider call
   */
  use(middleware: MiddlewareFn): void {
    this.middlewares.push(middleware);
  }

  async discover(): Promise<ProviderDiscoveryResult> {
    const key = discoveryCacheKey({
      providerType: this.provider.id,
      protocolType: this.config.protocolType,
      baseUrl: this.config.baseUrl,
      model: this.config.model,
    });
    const cached = getCachedDiscovery(key);
    if (cached) {
      this.discovery = cached;
      return cached;
    }
    const fresh = await detectCapabilities(this.provider, this.config);
    this.discovery = setCachedDiscovery(key, fresh);
    return this.discovery;
  }

  async ensureCapabilities(request: StandardRequest): Promise<ProviderDiscoveryResult> {
    const discovery = this.discovery ?? (await this.discover());
    for (const cap of request.capabilitiesRequired) {
      if (!supportsCapability(discovery.capabilities, cap as keyof CapabilityMap)) {
        throw new UnsupportedCapabilityError(
          `Provider ${this.provider.id} does not support ${cap}`,
        );
      }
    }
    return discovery;
  }

  async chat(request: StandardRequest): Promise<StandardResponse> {
    try {
      await this.ensureCapabilities(request);

      const ctx: Record<string, unknown> = {
        request,
        gateway: this,
      };

      const pipeline = createMiddlewarePipeline(this.middlewares);

      let result: StandardResponse | undefined;
      await pipeline(ctx, async () => {
        result = await this.provider.chat(request, this.config);
      });

      return result!;
    } catch (error) {
      throw normalizeGatewayError(error);
    }
  }

  async *stream(request: StandardRequest): AsyncGenerator<StreamEvent> {
    try {
      await this.ensureCapabilities(request);

      const ctx: Record<string, unknown> = {
        request,
        gateway: this,
      };

      // For streaming, we don't apply the full middleware pipeline
      // Instead we just yield events and handle errors inline
      yield* this.provider.stream(request, this.config);
    } catch (error) {
      const err = normalizeGatewayError(error);
      yield { type: 'START', id: request.id, model: request.model };
      yield { type: 'ERROR', message: err.message, code: err.type, status: err.status };
      yield { type: 'END', stopReason: 'error' };
    }
  }

  async models(): Promise<{ object: string; data: { id: string }[] }> {
    return await this.provider.models(this.config);
  }
}
