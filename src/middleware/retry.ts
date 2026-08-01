/**
 * Retry middleware — retries on transient failures with exponential backoff
 */

import { ProviderUnavailable, TimeoutError } from '../core/errors.js';

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  retryableStatuses?: number[];
}

const DEFAULT_RETRYABLE = [502, 503, 504];

export function retryMiddleware(config: RetryConfig = {}) {
  const maxAttempts = config.maxAttempts ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 1000;
  const retryableStatuses = config.retryableStatuses ?? DEFAULT_RETRYABLE;

  return async (ctx: Record<string, unknown>, next: () => Promise<unknown>): Promise<unknown> => {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await next();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on non-retryable errors
        if (lastError instanceof ProviderUnavailable || lastError instanceof TimeoutError) {
          if (attempt === maxAttempts) throw lastError;
        } else {
          throw lastError;
        }

        // Exponential backoff
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  };
}
