/**
 * Rate limit middleware — tracks requests per time window using in-memory map
 */

import { RateLimitError } from '../core/errors.js';

interface WindowState {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, WindowState>();

export interface RateLimitConfig {
  maxRequests?: number;
  windowMs?: number;
}

export function rateLimitMiddleware(config: RateLimitConfig = {}) {
  const maxRequests = config.maxRequests ?? 100;
  const windowMs = config.windowMs ?? 60_000;

  return async (ctx: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown> => {
    // Use a simple key based on model for now
    const req = ctx.request as { model?: string } | undefined;
    const key = `model:${req?.model ?? 'default'}`;

    const now = Date.now();
    let state = memoryStore.get(key);

    if (!state || now > state.resetAt) {
      state = { count: 0, resetAt: now + windowMs };
      memoryStore.set(key, state);
    }

    state.count += 1;

    if (state.count > maxRequests) {
      throw new RateLimitError(`Rate limit exceeded: ${maxRequests} requests per ${windowMs / 1000}s`);
    }

    return next();
  };
}
